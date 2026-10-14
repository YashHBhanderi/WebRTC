import crypto from "crypto";
import mongoose from "mongoose";
import Meeting, { IMeeting, IRecurrence, RecurrenceFreq } from "../models/meetingModel";
import Conversation from "../models/conversationModel";
import Call from "../models/callModel";
import Notification from "../models/notificationModel";
import User from "../models/userModel";
import callService from "./call.service";
import notificationService from "./notification.service";
import { describeRecurrence, isValidTimeZone, occurrencesBetween } from "./recurrence";
import { emitToUsers } from "../realtime/io";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const MAX_INVITEES = 250;
const MAX_RANGE_DAYS = 62;
const REMINDER_LEAD_MS = 5 * 60 * 1000;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export interface MeetingInput {
    title?: unknown;
    description?: unknown;
    startAt?: unknown;
    endAt?: unknown;
    timeZone?: unknown;
    invitees?: unknown;
    recurrence?: unknown;
    lobby?: unknown;
    /** string = set, "" = remove, undefined = keep */
    password?: unknown;
}

// ---------------------------------------------------------------- validation helpers

function text(value: unknown, name: string, max: number, required = false): string {
    const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (required && !s) {
        throw new AppError(`${name} is required`);
    }
    if (s.length > max) {
        throw new AppError(`${name} can be up to ${max} characters`);
    }
    return s;
}

function date(value: unknown, name: string): Date {
    const d = new Date(String(value ?? ""));
    if (isNaN(d.getTime())) {
        throw new AppError(`${name} is invalid`);
    }
    return d;
}

function recurrence(value: unknown, startAt: Date): IRecurrence | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    const freq = v.freq as RecurrenceFreq;
    if (!["daily", "weekdays", "weekly", "monthly"].includes(freq)) {
        throw new AppError("Invalid repeat option");
    }
    const interval = Math.min(Math.max(Math.floor(Number(v.interval) || 1), 1), 30);
    const byWeekday = Array.isArray(v.byWeekday)
        ? [...new Set(v.byWeekday.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
        : undefined;
    const until = v.until ? date(v.until, "Repeat end date") : null;
    if (until && until.getTime() < startAt.getTime()) {
        throw new AppError("The repeat end date must be after the first meeting");
    }
    const count = v.count ? Math.min(Math.max(Math.floor(Number(v.count)), 1), 500) : null;
    if (!until && !count) {
        // Open-ended series are allowed but bounded to two years
        return { freq, interval, byWeekday, until: new Date(startAt.getTime() + 730 * 24 * 3600 * 1000), count: null };
    }
    return { freq, interval, byWeekday, until, count };
}

function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString("hex");
    return `${salt}:${crypto.scryptSync(password, salt, 32).toString("hex")}`;
}

function checkPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) {
        return false;
    }
    const candidate = crypto.scryptSync(password, salt, 32);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function newCode(): string {
    const bytes = crypto.randomBytes(10);
    let code = "";
    for (let i = 0; i < 10; i++) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        if (i === 2 || i === 6) code += "-";
    }
    return code; // e.g. "k7p-q2xm-4tz"
}

/**
 * Scheduled meetings: each has its own chat conversation (organiser + invitees) where its calls
 * run, so meeting chat, lobby and host controls reuse the existing chat / call infrastructure.
 */
class MeetingService {
    async create(organizerId: string, input: MeetingInput) {
        const title = text(input.title, "Title", 120, true);
        const description = text(input.description, "Description", 2000);
        const startAt = date(input.startAt, "Start time");
        const endAt = date(input.endAt, "End time");
        if (endAt.getTime() <= startAt.getTime()) {
            throw new AppError("The meeting must end after it starts");
        }
        if (endAt.getTime() - startAt.getTime() > 24 * 3600 * 1000) {
            throw new AppError("A meeting can last up to 24 hours");
        }
        const timeZone = isValidTimeZone(input.timeZone) ? input.timeZone : "UTC";
        const invitees = await this.validInvitees(input.invitees, organizerId);
        const members = [organizerId, ...invitees];

        const conversation = await Conversation.create({
            members: members.map(oid),
            isGroup: true,
            groupName: title,
            groupAdmin: oid(organizerId),
            groupAdmins: [oid(organizerId)],
            groupDescription: "Meeting chat",
        });

        let code = newCode();
        for (let i = 0; i < 3 && (await Meeting.exists({ code })); i++) {
            code = newCode();
        }
        const password = typeof input.password === "string" ? input.password.trim() : "";
        if (password && (password.length < 4 || password.length > 64)) {
            throw new AppError("The password must be 4 to 64 characters");
        }
        const meeting = await Meeting.create({
            title,
            description,
            organizerId: oid(organizerId),
            invitees: invitees.map(oid),
            conversationId: conversation._id,
            startAt,
            endAt,
            timeZone,
            recurrence: recurrence(input.recurrence, startAt),
            code,
            passwordHash: password ? hashPassword(password) : null,
            lobby: input.lobby === true,
        });

        await this.invite(meeting, invitees, organizerId, "invited you to");
        emitToUsers(members, "group:added", { groupId: String(conversation._id) });
        emitToUsers(members, "meeting:updated", { meetingId: String(meeting._id) });
        return this.present(meeting, organizerId);
    }

    async update(meetingId: unknown, userId: string, input: MeetingInput) {
        const meeting = await this.organized(meetingId, userId);
        if (input.title !== undefined) meeting.title = text(input.title, "Title", 120, true);
        if (input.description !== undefined) meeting.description = text(input.description, "Description", 2000);
        if (input.startAt !== undefined) meeting.startAt = date(input.startAt, "Start time");
        if (input.endAt !== undefined) meeting.endAt = date(input.endAt, "End time");
        if (meeting.endAt.getTime() <= meeting.startAt.getTime()) {
            throw new AppError("The meeting must end after it starts");
        }
        if (input.timeZone !== undefined && isValidTimeZone(input.timeZone)) meeting.timeZone = input.timeZone;
        if (input.recurrence !== undefined) meeting.recurrence = recurrence(input.recurrence, meeting.startAt);
        if (input.lobby !== undefined) meeting.lobby = input.lobby === true;
        if (typeof input.password === "string") {
            const password = input.password.trim();
            if (password && (password.length < 4 || password.length > 64)) {
                throw new AppError("The password must be 4 to 64 characters");
            }
            meeting.passwordHash = password ? hashPassword(password) : null;
        }

        let added: string[] = [];
        if (input.invitees !== undefined) {
            const next = await this.validInvitees(input.invitees, userId);
            const before = new Set(meeting.invitees.map(String));
            added = next.filter((id) => !before.has(id));
            meeting.invitees = next.map(oid);
            // Removed invitees leave the meeting chat too; new ones join it
            await Conversation.updateOne({ _id: meeting.conversationId }, { $set: { members: [userId, ...next].map(oid) } });
        }
        await meeting.save();
        await Conversation.updateOne({ _id: meeting.conversationId }, { $set: { groupName: meeting.title } });

        const everyone = [userId, ...meeting.invitees.map(String)];
        await this.invite(meeting, added, userId, "invited you to");
        emitToUsers(added, "group:added", { groupId: String(meeting.conversationId) });
        emitToUsers(everyone, "meeting:updated", { meetingId: String(meeting._id) });
        return this.present(meeting, userId);
    }

    /** Cancel the whole series, or one occurrence (`occurrence` = its start time). */
    async cancel(meetingId: unknown, userId: string, occurrence?: unknown) {
        const meeting = await this.organized(meetingId, userId);
        if (occurrence) {
            const at = date(occurrence, "Occurrence");
            meeting.cancelledOccurrences = [...meeting.cancelledOccurrences, at];
        } else {
            meeting.status = "cancelled";
        }
        await meeting.save();
        const invitees = meeting.invitees.map(String);
        await notificationService.notify(invitees.map((id) => ({
            userId: id,
            type: "meeting-invite" as const,
            actorId: userId,
            conversationId: String(meeting.conversationId),
            meetingId: String(meeting._id),
            text: `Cancelled: ${meeting.title}`,
        })));
        emitToUsers([userId, ...invitees], "meeting:updated", { meetingId: String(meeting._id) });
    }

    /** My meetings (organised or invited) with an occurrence in [from, to), one entry per occurrence. */
    async range(userId: string, fromValue: unknown, toValue: unknown) {
        const from = date(fromValue, "From");
        const to = date(toValue, "To");
        if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 3600 * 1000) {
            throw new AppError(`Choose a range of up to ${MAX_RANGE_DAYS} days`);
        }
        const meetings = await Meeting.find({
            status: "scheduled",
            $or: [{ organizerId: oid(userId) }, { invitees: oid(userId) }],
            startAt: { $lt: to },
            $and: [{ $or: [{ recurrence: null }, { "recurrence.until": null }, { "recurrence.until": { $gte: from } }, { endAt: { $gte: from } }] }],
        }).lean();

        const active = await this.activeCalls(meetings.map((m) => m.conversationId));
        const people = await this.people(meetings);
        const items = [];
        for (const m of meetings) {
            const duration = new Date(m.endAt).getTime() - new Date(m.startAt).getTime();
            for (const start of occurrencesBetween(new Date(m.startAt), new Date(m.endAt), m.recurrence, m.timeZone, from, to, m.cancelledOccurrences)) {
                items.push({
                    ...this.summary(m, userId, people, active),
                    occurrenceStart: start,
                    occurrenceEnd: new Date(start.getTime() + duration),
                });
            }
        }
        items.sort((a, b) => a.occurrenceStart.getTime() - b.occurrenceStart.getTime());
        return items;
    }

    /** Details for someone who can see the meeting (organiser / invitee). */
    async get(meetingId: unknown, userId: string) {
        const meeting = await Meeting.findById(requireObjectId(meetingId, "meetingId"));
        if (!meeting || !this.canSee(meeting, userId)) {
            throw new NotFoundError("Meeting not found");
        }
        return this.present(meeting, userId);
    }

    /** What a link shows before joining: enough to decide, nothing private. */
    async preview(code: unknown, userId: string) {
        const meeting = await this.byCode(code);
        const invited = this.canSee(meeting, userId);
        const organizer = await User.findById(meeting.organizerId).select("username").lean();
        return {
            meetingId: invited ? String(meeting._id) : null,
            code: meeting.code,
            title: meeting.title,
            organizerName: organizer?.username || "",
            startAt: meeting.startAt,
            endAt: meeting.endAt,
            recurrence: describeRecurrence(meeting.recurrence),
            invited,
            needsPassword: !invited && !!meeting.passwordHash,
            cancelled: meeting.status === "cancelled",
            conversationId: invited ? String(meeting.conversationId) : null,
        };
    }

    /**
     * Join by link / ID: people who weren't invited give the password (when set) and are added to
     * the meeting chat; the call's own lobby / host rules still apply when they enter.
     */
    async joinByCode(code: unknown, userId: string, password: unknown) {
        const meeting = await this.byCode(code);
        if (meeting.status === "cancelled") {
            throw new AppError("This meeting was cancelled", 410);
        }
        if (!this.canSee(meeting, userId)) {
            if (meeting.passwordHash && !(typeof password === "string" && checkPassword(password, meeting.passwordHash))) {
                throw new AppError("The meeting password is incorrect", 403);
            }
            await Conversation.updateOne({ _id: meeting.conversationId }, { $addToSet: { members: oid(userId) } });
            meeting.invitees = [...meeting.invitees, oid(userId)];
            await meeting.save();
            // Already running: they must be on the call's participant list to enter it
            const call = await callService.getActiveCall(String(meeting.conversationId));
            if (call && !call.participants.some((p: any) => String(p.userId) === userId)) {
                await Call.updateOne({ _id: call._id }, { $push: { participants: { userId: oid(userId), status: "invited" } } });
            }
            emitToUsers([userId], "group:added", { groupId: String(meeting.conversationId) });
        }
        return { meetingId: String(meeting._id), conversationId: String(meeting.conversationId), lobby: meeting.lobby };
    }

    /** Lobby default for a call that starts in a meeting's chat. */
    async lobbyDefaultFor(conversationId: string): Promise<boolean> {
        const meeting = await Meeting.findOne({ conversationId: oid(conversationId), status: "scheduled" }).select("lobby").lean();
        return !!meeting?.lobby;
    }

    // ---------------------------------------------------------------- reminders

    private reminderTimer: ReturnType<typeof setInterval> | null = null;

    /** Once a minute: invitees get a reminder ~5 minutes before each occurrence (once). */
    startReminders(): void {
        if (this.reminderTimer) {
            return;
        }
        this.reminderTimer = setInterval(() => void this.sendReminders().catch((e) => console.error("[meetings] reminders failed", e)), 60_000);
    }

    private async sendReminders(): Promise<void> {
        const now = Date.now();
        const from = new Date(now + REMINDER_LEAD_MS - 60_000);
        const to = new Date(now + REMINDER_LEAD_MS);
        const meetings = await Meeting.find({
            status: "scheduled",
            startAt: { $lt: to },
            $or: [{ recurrence: null, startAt: { $gte: from } }, { recurrence: { $ne: null }, "recurrence.until": { $gte: from } }],
        }).lean();
        for (const m of meetings) {
            for (const start of occurrencesBetween(new Date(m.startAt), new Date(m.endAt), m.recurrence, m.timeZone, from, to, m.cancelledOccurrences)) {
                if (start.getTime() < from.getTime() || start.getTime() >= to.getTime()) {
                    continue;
                }
                // Once per occurrence, even across restarts / several server instances
                const already = await Notification.exists({ meetingId: m._id, type: "meeting-reminder", createdAt: { $gte: new Date(start.getTime() - 15 * 60_000) } });
                if (already) {
                    continue;
                }
                const recipients = [String(m.organizerId), ...m.invitees.map(String)];
                await notificationService.notify(recipients.map((userId) => ({
                    userId,
                    type: "meeting-reminder" as const,
                    conversationId: String(m.conversationId),
                    meetingId: String(m._id),
                    text: `${m.title} starts in 5 minutes`,
                })));
            }
        }
    }

    // ---------------------------------------------------------------- internals

    private async validInvitees(value: unknown, organizerId: string): Promise<string[]> {
        const list = Array.isArray(value) ? [...new Set(value.map(String))].filter((id) => id !== organizerId) : [];
        if (list.length > MAX_INVITEES) {
            throw new AppError(`A meeting can have up to ${MAX_INVITEES} invitees`);
        }
        const ids = list.filter((id) => mongoose.isValidObjectId(id));
        const found = await User.find({ _id: { $in: ids.map(oid) } }).select("_id").lean();
        return found.map((u) => String(u._id));
    }

    private async organized(meetingId: unknown, userId: string) {
        const meeting = await Meeting.findById(requireObjectId(meetingId, "meetingId"));
        if (!meeting) {
            throw new NotFoundError("Meeting not found");
        }
        if (String(meeting.organizerId) !== userId) {
            throw new ForbiddenError("Only the organizer can change this meeting");
        }
        return meeting;
    }

    private async byCode(code: unknown) {
        const value = typeof code === "string" ? code.trim().toLowerCase() : "";
        if (!/^[a-z0-9-]{8,16}$/.test(value)) {
            throw new NotFoundError("Meeting not found");
        }
        const meeting = await Meeting.findOne({ code: value });
        if (!meeting) {
            throw new NotFoundError("Meeting not found");
        }
        return meeting;
    }

    private canSee(meeting: Pick<IMeeting, "organizerId" | "invitees">, userId: string): boolean {
        return String(meeting.organizerId) === userId || meeting.invitees.some((id) => String(id) === userId);
    }

    private async invite(meeting: IMeeting, userIds: string[], actorId: string, verb: string) {
        if (!userIds.length) {
            return;
        }
        await notificationService.notify(userIds.map((id) => ({
            userId: id,
            type: "meeting-invite" as const,
            actorId,
            conversationId: String(meeting.conversationId),
            meetingId: String(meeting._id),
            text: meeting.title,
        })));
    }

    private async activeCalls(conversationIds: mongoose.Types.ObjectId[]): Promise<Map<string, string>> {
        const calls = await Call.find({ conversationId: { $in: conversationIds }, callStatus: { $in: ["ringing", "active"] } })
            .select("conversationId").lean();
        return new Map(calls.map((c: any) => [String(c.conversationId), String(c._id)]));
    }

    private async people(meetings: any[]) {
        const ids = new Set<string>();
        meetings.forEach((m) => {
            ids.add(String(m.organizerId));
            m.invitees.forEach((i: any) => ids.add(String(i)));
        });
        const users = await User.find({ _id: { $in: [...ids].map(oid) } }).select("username avatar").lean();
        return new Map(users.map((u: any) => [String(u._id), { _id: String(u._id), username: u.username, avatar: u.avatar }]));
    }

    private summary(m: any, userId: string, people: Map<string, any>, active: Map<string, string>) {
        return {
            _id: String(m._id),
            title: m.title,
            description: m.description,
            organizer: people.get(String(m.organizerId)) || { _id: String(m.organizerId), username: "" },
            invitees: m.invitees.map((i: any) => people.get(String(i)) || { _id: String(i), username: "" }),
            isOrganizer: String(m.organizerId) === userId,
            conversationId: String(m.conversationId),
            startAt: m.startAt,
            endAt: m.endAt,
            timeZone: m.timeZone,
            recurrence: m.recurrence || null,
            recurrenceText: describeRecurrence(m.recurrence),
            code: m.code,
            hasPassword: !!m.passwordHash,
            lobby: !!m.lobby,
            status: m.status,
            activeCallId: active.get(String(m.conversationId)) || null,
        };
    }

    private async present(meeting: IMeeting, userId: string) {
        const lean = meeting.toObject ? meeting.toObject() : meeting;
        lean.passwordHash = (meeting as any).passwordHash;
        const people = await this.people([lean]);
        const active = await this.activeCalls([meeting.conversationId]);
        return this.summary(lean, userId, people, active);
    }
}

export default new MeetingService();

import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import User from "../models/userModel";
import { emitToUsers, userSockets } from "../realtime/io";
import mediasoupService from "./mediasoup.service";
import { AppError } from "../utils/errors";

/** Statuses a user can choose. "Offline" is never chosen: it is what others see without a connection. */
export const USER_STATUSES = ["Available", "Busy", "Do not disturb", "Away", "Appear offline"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const STATUS_MESSAGE_MAX = 140;

export interface PresencePayload {
    userId: string;
    /** Visible online state (false while "Appear offline") */
    isOnline: boolean;
    /** Chosen status as others may see it ("Appear offline" is never revealed) */
    status: Exclude<UserStatus, "Appear offline">;
    statusMessage: string;
    /** No input for a while (only meaningful when status is Available) */
    autoAway: boolean;
    /** In a call or meeting right now (shown as "In a call" unless Do not disturb / appearing offline) */
    inCall: boolean;
    lastSeen: Date | null;
}

const CONTACTS_TTL_MS = 60_000;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** What others may see of a chosen status. */
export function publicStatus(status: string | undefined): PresencePayload["status"] {
    return !status || status === "Appear offline" ? "Available" : (status as PresencePayload["status"]);
}

/**
 * Presence: connection + chosen status + automatic away. Changes go only to people who share a
 * chat with the user (and the user's own sockets), not to every connected client.
 */
class PresenceService {
    private contacts = new Map<string, { ids: string[]; at: number }>();

    /** Everyone this user shares a chat with (cached briefly; group changes catch up within a minute). */
    async contactsOf(userId: string): Promise<string[]> {
        const cached = this.contacts.get(userId);
        if (cached && Date.now() - cached.at < CONTACTS_TTL_MS) {
            return cached.ids;
        }
        const ids = (await Conversation.distinct("members", { members: oid(userId) })).map(String);
        this.contacts.set(userId, { ids, at: Date.now() });
        return ids;
    }

    isConnected(userId: string): boolean {
        return userSockets.has(String(userId));
    }

    /** Socket connected: online (unless appearing offline), activity resets automatic away. */
    async connected(userId: string): Promise<void> {
        const user = await User.findById(userId).select("status").lean();
        await User.updateOne({ _id: userId }, { $set: { isOnline: user?.status !== "Appear offline", autoAway: false } });
        await this.publish(userId);
    }

    /** The user's active socket went away. */
    async disconnected(userId: string): Promise<void> {
        await User.updateOne({ _id: userId }, { $set: { isOnline: false, lastSeen: new Date(), autoAway: false } });
        await this.publish(userId);
    }

    async setStatus(userId: string, status: unknown, statusMessage: unknown): Promise<PresencePayload> {
        const update: Record<string, unknown> = {};
        if (status !== undefined) {
            if (!USER_STATUSES.includes(status as UserStatus)) {
                throw new AppError("Invalid status");
            }
            update.status = status;
            update.isOnline = this.isConnected(userId) && status !== "Appear offline";
        }
        if (statusMessage !== undefined) {
            const text = typeof statusMessage === "string" ? statusMessage.replace(/\s+/g, " ").trim() : "";
            if (text.length > STATUS_MESSAGE_MAX) {
                throw new AppError(`Status messages can be up to ${STATUS_MESSAGE_MAX} characters`);
            }
            update.statusMessage = text;
        }
        if (!Object.keys(update).length) {
            throw new AppError("Nothing to update");
        }
        await User.updateOne({ _id: userId }, { $set: update });
        return this.publish(userId);
    }

    /** Idle on every device for a while → Away (only shown while the chosen status is Available). */
    async setIdle(userId: string, idle: boolean): Promise<void> {
        const res = await User.updateOne({ _id: userId, autoAway: { $ne: idle } }, { $set: { autoAway: idle } });
        if (res.modifiedCount) {
            await this.publish(userId);
        }
    }

    async payloadFor(userId: string): Promise<PresencePayload> {
        const user = await User.findById(userId).select("status statusMessage autoAway isOnline lastSeen").lean();
        const chosen = (user?.status || "Available") as UserStatus;
        return {
            userId: String(userId),
            isOnline: this.isConnected(userId) && chosen !== "Appear offline",
            status: publicStatus(chosen),
            statusMessage: user?.statusMessage || "",
            autoAway: !!user?.autoAway,
            inCall: chosen !== "Appear offline" && mediasoupService.isUserInCall(userId),
            lastSeen: user?.lastSeen || null,
        };
    }

    /** Push the user's current presence to their contacts, and the unmasked version to their own sockets. */
    async publish(userId: string): Promise<PresencePayload & { ownStatus: UserStatus }> {
        const payload = await this.payloadFor(userId);
        const own = await User.findById(userId).select("status").lean();
        const contacts = (await this.contactsOf(userId)).filter((id) => id !== String(userId));
        emitToUsers(contacts, "user:presence", payload);
        const mine = { ...payload, ownStatus: (own?.status || "Available") as UserStatus };
        emitToUsers([String(userId)], "user:presence", mine);
        return mine;
    }
}

export default new PresenceService();

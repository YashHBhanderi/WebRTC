import { RequestContext, runAsSystem, runWithContext } from "../tenancy/context";
import TenantMembership from "../models/tenantMembershipModel";
import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import User from "../models/userModel";
import { appMayReceive, emitToUsers, io, socketContexts, socketIdsOf, userSockets } from "../realtime/io";
import { onCluster, publish, userConnectedAnywhere } from "../realtime/cluster";
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
        // Everyone who shares a conversation with the user in any workspace (cache is per user, not per context)
        const ids = (await runAsSystem(() => Conversation.distinct("members", { members: oid(userId) }))).map(String);
        this.contacts.set(userId, { ids, at: Date.now() });
        return ids;
    }

    /** Connected on this instance, or (multi-instance) on any instance. */
    isConnected(userId: string): Promise<boolean> {
        return userConnectedAnywhere(String(userId), userSockets.has(String(userId)));
    }

    /** Socket connected: online (unless appearing offline), activity resets automatic away. */
    async connected(userId: string): Promise<void> {
        const user = await User.findById(userId).select("status").lean();
        await User.updateOne({ _id: userId }, { $set: { isOnline: user?.status !== "Appear offline", autoAway: false } });
        await this.publish(userId);
    }

    /** The user's active socket went away. */
    async disconnected(userId: string): Promise<void> {
        // Still connected through another instance: stay online
        if (await this.isConnected(userId)) return;
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
            update.isOnline = (await this.isConnected(userId)) && status !== "Appear offline";
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
            isOnline: (await this.isConnected(userId)) && chosen !== "Appear offline",
            status: publicStatus(chosen),
            statusMessage: user?.statusMessage || "",
            autoAway: !!user?.autoAway,
            inCall: chosen !== "Appear offline" && mediasoupService.isUserInCall(userId),
            lastSeen: user?.lastSeen || null,
        };
    }

    private visibility = new Map<string, { ok: boolean; at: number }>();

    /**
     * May the viewer (in the context of their socket) see the subject's presence? Only if, in that
     * context, they share a visible conversation, or the subject is in that context's directory
     * (workspace member / globally discoverable). Cached briefly per (subject, viewer, context).
     */
    async visibleTo(subjectId: string, viewer: RequestContext): Promise<boolean> {
        const key = `${subjectId}:${viewer.userId}:${viewer.tenantId || "global"}`;
        const hit = this.visibility.get(key);
        if (hit && Date.now() - hit.at < CONTACTS_TTL_MS) {
            return hit.ok;
        }
        let ok = !!(await runWithContext(viewer, () => Conversation.exists({ members: { $all: [oid(subjectId), oid(viewer.userId)] } })));
        if (!ok && viewer.tenantId && viewer.role === "guest") {
            ok = false; // guests: people they share a conversation with only (checked above)
        } else if (!ok && viewer.tenantId) {
            ok = !!(await runAsSystem(() => TenantMembership.exists({ tenantId: oid(viewer.tenantId!), userId: oid(subjectId), status: "active" }), "presence-visibility"));
        }
        // Personal context: presence only for people I share a conversation with (checked above)
        if (this.visibility.size > 50_000) this.visibility.clear();
        this.visibility.set(key, { ok, at: Date.now() });
        return ok;
    }

    /** Each live socket of each contact on THIS instance (SpreeWe and developer-app connections), judged by that socket's context. */
    async deliverLocally(subjectId: string, contacts: string[], payload: PresencePayload): Promise<void> {
        await Promise.all(contacts.flatMap((contactId) => socketIdsOf(contactId)).map(async (socketId) => {
            const viewer = socketContexts.get(socketId);
            if (viewer && appMayReceive(viewer, "user:presence") && (await this.visibleTo(subjectId, viewer).catch(() => false))) {
                io().to(socketId).emit("user:presence", payload);
            }
        }));
    }

    /** Push the user's current presence to contacts allowed to see it, and the unmasked version to their own sockets. */
    async publish(userId: string): Promise<PresencePayload & { ownStatus: UserStatus }> {
        const payload = await this.payloadFor(userId);
        const own = await User.findById(userId).select("status").lean();
        const contacts = (await this.contactsOf(userId)).filter((id) => id !== String(userId));
        await this.deliverLocally(String(userId), contacts, payload);
        // Contacts connected to other instances are judged there, by their own socket's context
        publish({ kind: "presence", subjectId: String(userId), contacts, payload });
        const mine = { ...payload, ownStatus: (own?.status || "Available") as UserStatus };
        emitToUsers([String(userId)], "user:presence", mine);
        return mine;
    }
}

const presenceService = new PresenceService();
onCluster("presence", (m) => presenceService.deliverLocally(String(m.subjectId), (m.contacts as string[]) || [], m.payload as PresencePayload));

export default presenceService;

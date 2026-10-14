import Call from "../models/callModel";
import Conversation from "../models/conversationModel";
import User from "../models/userModel";
import mediasoupService from "./mediasoup.service";
import { emitToCall, getScreenSharer, isCallHost, releaseScreenShare } from "./call-session.service";
import { io, emitToUser } from "../realtime/io";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";

export type MeetingRole = "host" | "cohost" | "attendee";

export interface MeetingSettings {
    lobby: boolean;
    allowUnmute: boolean;
    allowShare: boolean;
}

export interface LobbyEntry {
    userId: string;
    username: string;
    avatar?: string;
    since: number;
}

const DEFAULT_SETTINGS: MeetingSettings = { lobby: false, allowUnmute: true, allowShare: true };

/**
 * Host / co-host permissions for group meetings, enforced here (never only in the UI):
 * lobby admission, who may unmute or share, mute everyone, co-host roles.
 * Settings and co-hosts live on the call document; the waiting room is in memory (people waiting
 * simply ask again after a server restart).
 */
class MeetingControlsService {
    /** callId → userId → waiting entry */
    private lobbies = new Map<string, Map<string, LobbyEntry>>();
    /** callId → audio producer ids paused because attendees may not unmute */
    private policyPaused = new Map<string, Set<string>>();

    async load(callId: unknown) {
        const call = await Call.findById(String(callId || ""));
        if (!call) {
            throw new NotFoundError("Call not found");
        }
        const group = await Conversation.findById(call.conversationId).select("isGroup groupAdmin groupAdmins");
        return { call, group };
    }

    settingsOf(call: any): MeetingSettings {
        return { ...DEFAULT_SETTINGS, ...(call.settings?.toObject?.() || call.settings || {}) };
    }

    cohostIds(call: any): string[] {
        return (call.settings?.cohosts || []).map(String);
    }

    roleOf(call: any, group: any, userId: string): MeetingRole {
        if (!group?.isGroup) {
            // 1:1 calls: both people are equal hosts
            return "host";
        }
        if (isCallHost(call, group, userId)) {
            return "host";
        }
        return this.cohostIds(call).includes(String(userId)) ? "cohost" : "attendee";
    }

    isModerator(call: any, group: any, userId: string): boolean {
        return this.roleOf(call, group, userId) !== "attendee";
    }

    async requireModerator(callId: unknown, userId: string) {
        const loaded = await this.load(callId);
        if (!loaded.group?.isGroup || !this.isModerator(loaded.call, loaded.group, userId)) {
            throw new ForbiddenError("Only the host or a co-host can do this");
        }
        return loaded;
    }

    // ---------------------------------------------------------------- lobby

    /** Must this participant wait for admission before joining the media session? */
    mustWait(call: any, group: any, userId: string): boolean {
        if (!group?.isGroup || !this.settingsOf(call).lobby || this.isModerator(call, group, userId)) {
            return false;
        }
        const me = (call.participants || []).find((p: any) => String(p.userId) === String(userId));
        return !me?.admittedAt;
    }

    async enterLobby(callId: string, userId: string): Promise<void> {
        const lobby = this.lobbies.get(callId) || new Map<string, LobbyEntry>();
        if (!lobby.has(userId)) {
            const user = await User.findById(userId).select("username avatar").lean();
            lobby.set(userId, { userId, username: user?.username || "Someone", avatar: user?.avatar, since: Date.now() });
        }
        this.lobbies.set(callId, lobby);
        await this.announceLobby(callId);
    }

    lobbyOf(callId: string): LobbyEntry[] {
        return [...(this.lobbies.get(String(callId))?.values() || [])].sort((a, b) => a.since - b.since);
    }

    leaveLobby(callId: string, userId: string): void {
        const lobby = this.lobbies.get(String(callId));
        if (lobby?.delete(String(userId))) {
            void this.announceLobby(String(callId));
        }
    }

    /** The user went away (disconnect): drop them from every waiting room. */
    dropFromLobbies(userId: string): void {
        for (const [callId, lobby] of this.lobbies) {
            if (lobby.delete(String(userId))) {
                void this.announceLobby(callId);
            }
        }
    }

    async admit(callId: unknown, moderatorId: string, userIds: unknown): Promise<string[]> {
        const { call } = await this.requireModerator(callId, moderatorId);
        const key = String(call._id);
        const waiting = this.lobbies.get(key) || new Map();
        const ids = userIds === "all" ? [...waiting.keys()] : (Array.isArray(userIds) ? userIds : [userIds]).map(String);
        const now = new Date();
        const admitted: string[] = [];
        for (const id of ids) {
            const participant = (call.participants || []).find((p: any) => String(p.userId) === id);
            if (!participant || participant.status === "removed") {
                continue;
            }
            (participant as any).admittedAt = now;
            waiting.delete(id);
            admitted.push(id);
        }
        await call.save();
        admitted.forEach((id) => {
            emitToUser(id, "call:admitted", { callId: key });
            io().to(key).emit("call:participant-joined", { callId: key, userId: id });
        });
        await this.announceLobby(key);
        return admitted;
    }

    async deny(callId: unknown, moderatorId: string, userId: unknown): Promise<void> {
        const { call } = await this.requireModerator(callId, moderatorId);
        const key = String(call._id);
        const id = String(userId || "");
        this.lobbies.get(key)?.delete(id);
        // Not let in: recorded as left (not "joined") so history and counts stay right
        const participant = (call.participants || []).find((p: any) => String(p.userId) === id);
        if (participant && participant.status === "joined") {
            participant.status = "left";
            (participant as any).leftAt = new Date();
            (participant as any).joinedAt = undefined;
            await call.save();
        }
        emitToUser(id, "call:denied", { callId: key });
        await this.announceLobby(key);
    }

    /** Moderators see who is waiting (sent to their sockets only). */
    private async announceLobby(callId: string): Promise<void> {
        const loaded = await this.load(callId).catch(() => null);
        if (!loaded) {
            this.lobbies.delete(callId);
            return;
        }
        const waiting = this.lobbyOf(callId);
        mediasoupService.getPeersByCallId(callId)
            .filter((peer) => this.isModerator(loaded.call, loaded.group, peer.userId))
            .forEach((peer) => io().to(peer.socketId).emit("call:lobby", { callId, waiting }));
    }

    // ---------------------------------------------------------------- settings / roles

    async updateSettings(callId: unknown, moderatorId: string, changes: Partial<Record<keyof MeetingSettings, unknown>>) {
        const { call, group } = await this.requireModerator(callId, moderatorId);
        const settings = this.settingsOf(call);
        for (const key of ["lobby", "allowUnmute", "allowShare"] as const) {
            if (changes[key] !== undefined) {
                if (typeof changes[key] !== "boolean") {
                    throw new AppError("Invalid setting");
                }
                settings[key] = changes[key] as boolean;
            }
        }
        (call as any).settings = { ...settings, cohosts: (call as any).settings?.cohosts || [] };
        await call.save();
        const key = String(call._id);

        if (!settings.allowShare) {
            this.stopAttendeeShare(call, group);
        }
        this.applyUnmutePolicy(call, group);
        // Lobby switched off: everyone waiting gets in
        if (!settings.lobby && this.lobbyOf(key).length) {
            await this.admit(key, moderatorId, "all");
        }

        io().to(key).emit("call:settings", { callId: key, settings, cohostIds: this.cohostIds(call) });
        return settings;
    }

    async setCohost(callId: unknown, hostId: string, userId: unknown, cohost: boolean) {
        const { call, group } = await this.load(callId);
        if (!group?.isGroup || this.roleOf(call, group, hostId) !== "host") {
            throw new ForbiddenError("Only the host can change co-hosts");
        }
        const target = String(userId || "");
        if (!(call.participants || []).some((p: any) => String(p.userId) === target)) {
            throw new AppError("This person is not in the meeting");
        }
        if (isCallHost(call, group, target)) {
            throw new AppError("This person is already a host");
        }
        const current = new Set(this.cohostIds(call));
        if (cohost) {
            current.add(target);
        } else {
            current.delete(target);
        }
        (call as any).settings = { ...this.settingsOf(call), cohosts: [...current] };
        await call.save();
        const key = String(call._id);
        this.applyUnmutePolicy(call, group);
        io().to(key).emit("call:settings", { callId: key, settings: this.settingsOf(call), cohostIds: [...current] });
        await this.announceLobby(key);
    }

    /** Ask every attendee's client to mute (moderators keep their microphones). */
    async muteAll(callId: unknown, moderatorId: string): Promise<void> {
        const { call, group } = await this.requireModerator(callId, moderatorId);
        const key = String(call._id);
        mediasoupService.getPeersByCallId(key)
            .filter((peer) => peer.userId !== moderatorId && !this.isModerator(call, group, peer.userId))
            .forEach((peer) => io().to(peer.socketId).emit("call:force-muted", { callId: key, by: moderatorId, all: true }));
    }

    // ---------------------------------------------------------------- media enforcement

    /** May this user send this kind of media now? (checked when a producer is created) */
    async mayProduce(callId: string, userId: string, kind: string, source: "camera" | "screen"): Promise<{ allowed: boolean; pauseAudio: boolean }> {
        const loaded = await this.load(callId).catch(() => null);
        if (!loaded || !loaded.group?.isGroup || this.isModerator(loaded.call, loaded.group, userId)) {
            return { allowed: true, pauseAudio: false };
        }
        const settings = this.settingsOf(loaded.call);
        if (source === "screen" && !settings.allowShare) {
            return { allowed: false, pauseAudio: false };
        }
        return { allowed: true, pauseAudio: kind === "audio" && !settings.allowUnmute };
    }

    rememberPolicyPause(callId: string, producerId: string): void {
        const set = this.policyPaused.get(callId) || new Set<string>();
        set.add(producerId);
        this.policyPaused.set(callId, set);
    }

    /**
     * Attendees' microphones are paused on the server while unmuting is not allowed, so nothing
     * is forwarded whatever their client does; allowed again → resumed (their client is still muted).
     */
    private applyUnmutePolicy(call: any, group: any): void {
        const key = String(call._id);
        const block = !this.settingsOf(call).allowUnmute;
        const paused = this.policyPaused.get(key) || new Set<string>();
        for (const peer of mediasoupService.getPeersByCallId(key)) {
            const attendee = !this.isModerator(call, group, peer.userId);
            for (const producer of peer.producers.values()) {
                if (producer.kind !== "audio" || producer.closed) {
                    continue;
                }
                if (block && attendee && !producer.paused) {
                    void producer.pause();
                    paused.add(producer.id);
                    io().to(peer.socketId).emit("call:force-muted", { callId: key, all: true, locked: true });
                } else if ((!block || !attendee) && paused.has(producer.id)) {
                    void producer.resume();
                    paused.delete(producer.id);
                }
            }
        }
        this.policyPaused.set(key, paused);
    }

    /** Sharing turned off for attendees: stop an attendee's ongoing share. */
    private stopAttendeeShare(call: any, group: any): void {
        const key = String(call._id);
        const sharer = getScreenSharer(key);
        if (!sharer || this.isModerator(call, group, sharer.userId)) {
            return;
        }
        const peer = mediasoupService.getPeerByUserId(sharer.userId);
        peer?.producers.forEach((producer) => {
            if ((producer.appData as any)?.source === "screen") {
                producer.close();
                peer.producers.delete(producer.id);
                emitToCall(key, "mediasoup:producerClosed", { producerId: producer.id, userId: peer.userId, source: "screen" });
            }
        });
        releaseScreenShare(key, sharer.userId);
        emitToUser(sharer.userId, "call:share-stopped", { callId: key, reason: "not-allowed" });
    }

    /** Call finished: forget its in-memory state. */
    dispose(callId: string): void {
        this.lobbies.delete(String(callId));
        this.policyPaused.delete(String(callId));
    }
}

export default new MeetingControlsService();

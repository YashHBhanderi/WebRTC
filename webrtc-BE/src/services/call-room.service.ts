/**
 * In-memory, per-call UI state that does not belong in the database:
 * mic/camera flags, raised hands, ring timers and reaction rate limits.
 * Lost on restart by design — clients re-announce their media state on join.
 */

export interface MediaState {
    audio: boolean;
    video: boolean;
}

interface CallRoom {
    media: Map<string, MediaState>;
    hands: Map<string, number>;
    ringTimer?: ReturnType<typeof setTimeout>;
}

/** Emoji allowed as call reactions — anything else is dropped. */
export const CALL_REACTIONS = new Set(['👍', '❤️', '😂', '👏', '😮', '😢']);

const REACTION_MIN_INTERVAL_MS = 300;

class CallRoomService {
    private rooms = new Map<string, CallRoom>();
    private lastReactionAt = new Map<string, number>();

    private room(callId: string): CallRoom {
        const key = String(callId);
        let room = this.rooms.get(key);
        if (!room) {
            room = { media: new Map(), hands: new Map() };
            this.rooms.set(key, room);
        }
        return room;
    }

    setMedia(callId: string, userId: string, state: MediaState): void {
        this.room(callId).media.set(String(userId), {
            audio: !!state.audio,
            video: !!state.video,
        });
    }

    setHand(callId: string, userId: string, raised: boolean): void {
        const hands = this.room(callId).hands;
        if (raised) {
            hands.set(String(userId), Date.now());
        } else {
            hands.delete(String(userId));
        }
    }

    /** Drop one participant's flags (left / removed). */
    clearUser(callId: string, userId: string): void {
        const room = this.rooms.get(String(callId));
        if (!room) {
            return;
        }
        room.media.delete(String(userId));
        room.hands.delete(String(userId));
    }

    snapshot(callId: string): { media: Record<string, MediaState>; hands: string[] } {
        const room = this.rooms.get(String(callId));
        if (!room) {
            return { media: {}, hands: [] };
        }
        return {
            media: Object.fromEntries(room.media),
            // Oldest raise first, like a queue
            hands: [...room.hands.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
        };
    }

    /** True when this user may send another reaction now (simple per-user throttle). */
    allowReaction(userId: string): boolean {
        const now = Date.now();
        const last = this.lastReactionAt.get(String(userId)) || 0;
        if (now - last < REACTION_MIN_INTERVAL_MS) {
            return false;
        }
        this.lastReactionAt.set(String(userId), now);
        return true;
    }

    setRingTimer(callId: string, timer: ReturnType<typeof setTimeout>): void {
        const room = this.room(callId);
        if (room.ringTimer) {
            clearTimeout(room.ringTimer);
        }
        room.ringTimer = timer;
    }

    clearRingTimer(callId: string): void {
        const room = this.rooms.get(String(callId));
        if (room?.ringTimer) {
            clearTimeout(room.ringTimer);
            room.ringTimer = undefined;
        }
    }

    /** Call finished — release everything held for it. */
    dispose(callId: string): void {
        this.clearRingTimer(callId);
        this.rooms.delete(String(callId));
    }
}

export default new CallRoomService();

import type { HttpClient, Page } from "./http.js";
import type { RealtimeClient } from "./realtime.js";
import { Store, type ReadableStore, type Unsubscribe } from "./store.js";
import type { DirectoryEntry, PresenceUpdate, UserSummary } from "./types.js";

/**
 * People lookups shared by every module (profiles, directory, presence). Profiles are cached in
 * memory per client; presence comes from `user:presence` events (scope realtime:connect).
 */
export class PeopleApi {
    private readonly profiles = new Map<string, Promise<UserSummary>>();
    private readonly presenceStore = new Store<ReadonlyMap<string, PresenceUpdate>>(new Map());
    private presenceWired = false;

    constructor(private readonly http: HttpClient, private readonly realtime: RealtimeClient) {}

    /** People the user can contact in the app's context (GET /v1/directory, scope directory:read). */
    directory(params: { q?: string; limit?: number; cursor?: string | null } = {}): Promise<Page<DirectoryEntry>> {
        return this.http.page<DirectoryEntry>("/v1/directory", { query: { q: params.q, limit: params.limit, cursor: params.cursor ?? undefined } });
    }

    /** A profile the user may see (GET /web/user/:userId, scope profile:read). Cached; pass `refresh` to re-fetch. */
    profile(userId: string, options: { refresh?: boolean } = {}): Promise<UserSummary> {
        if (options.refresh || !this.profiles.has(userId)) {
            const p = this.http.get<UserSummary>(`/web/user/${encodeURIComponent(userId)}`);
            p.catch(() => this.profiles.delete(userId));
            this.profiles.set(userId, p);
        }
        return this.profiles.get(userId)!;
    }

    /** Seed the cache from data that already contains profiles (conversation members, message authors). */
    remember(users: Iterable<Partial<UserSummary> | null | undefined>): void {
        for (const u of users) if (u?._id && u.username && !this.profiles.has(String(u._id))) this.profiles.set(String(u._id), Promise.resolve(u as UserSummary));
    }

    /** Live presence by user id (filled by `user:presence` events once the socket is connected). */
    get presence(): ReadableStore<ReadonlyMap<string, PresenceUpdate>> {
        this.wirePresence();
        return this.presenceStore;
    }

    /** Presence of one user, updated live. */
    watchPresence(userId: string, listener: (p: PresenceUpdate | undefined) => void): Unsubscribe {
        return this.presence.subscribe((map) => listener(map.get(userId)));
    }

    /** Seed presence from REST data (directory entries, profiles) without waiting for events. */
    seedPresence(entries: Iterable<{ _id: string; isOnline?: boolean; status?: string; statusMessage?: string }>): void {
        const next = new Map(this.presenceStore.value);
        let changed = false;
        for (const e of entries) {
            if (!e?._id || next.has(e._id) || e.isOnline === undefined) continue;
            next.set(e._id, { userId: e._id, isOnline: !!e.isOnline, status: e.status, statusMessage: e.statusMessage });
            changed = true;
        }
        if (changed) this.presenceStore.set(next);
    }

    private wirePresence(): void {
        if (this.presenceWired) return;
        this.presenceWired = true;
        this.realtime.on<PresenceUpdate>("user:presence", (p) => {
            if (!p?.userId) return;
            const next = new Map(this.presenceStore.value);
            next.set(String(p.userId), { ...next.get(String(p.userId)), ...p, userId: String(p.userId) });
            this.presenceStore.set(next);
        });
    }
}

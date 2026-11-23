import { Emitter, Store, type ReadableStore, type SpreeWeClient, type Unsubscribe } from "@spreewe/core";
import type { NotificationFeedState, NotificationView, SpreeWeNotification } from "./types.js";

const NOTIFICATIONS_SERVICE = Symbol.for("spreewe.notifications");
/** Server default and maximum are 30 and 50 (NotificationService.list) */
const PAGE_SIZE = 30;
/** POST /notifications/read refuses more than 200 ids per request */
const MARK_READ_BATCH = 200;
/** How long a first load waits for the socket before reading over REST anyway */
const CONNECT_WAIT_MS = 4000;

/** The client's notifications service (created on first use). */
export function getNotifications(client: SpreeWeClient): NotificationsService {
    return client.service(NOTIFICATIONS_SERVICE, (c) => new NotificationsService(c));
}

/**
 * Live state of the notification socket events:
 * - "off": start() not called yet
 * - "connecting": connecting or reconnecting
 * - "live": `notification:new` / `notification:read` arrive as they happen
 * - "unavailable": the token lacks realtime:connect or the socket failed; the feed still works over REST
 */
export type NotificationsLiveState = "off" | "connecting" | "live" | "unavailable";

interface ServiceEvents extends Record<string, unknown> {
    notification: SpreeWeNotification;
    unread: number;
}

/**
 * Headless activity feed: mentions, replies, reactions, missed calls, meeting invites and reminders,
 * recording milestones (GET /notifications), the unread badge (GET /notifications/unread-count),
 * marking read (POST /notifications/read) and live `notification:new` / `notification:read` events
 * over the shared socket, re-synced after every reconnect.
 *
 * Scopes: notifications:read (feed, count, live events), notifications:write (mark read),
 * realtime:connect (live events; without it the feed is REST only).
 */
export class NotificationsService {
    readonly client: SpreeWeClient;
    private readonly feeds = new Map<NotificationView, NotificationFeed>();
    private readonly unreadStore = new Store<number>(0);
    private readonly unreadLoadedStore = new Store<boolean>(false);
    private readonly unreadErrorStore = new Store<Error | null>(null);
    private readonly liveStore = new Store<NotificationsLiveState>("off");
    private readonly emitter = new Emitter<ServiceEvents>();
    private readonly offs: Unsubscribe[] = [];
    private starting: Promise<void> | null = null;
    private wired = false;
    private realtimeAllowed = false;
    private everConnected = false;
    private unreadLoad: Promise<number> | null = null;
    private readSyncTimer: ReturnType<typeof setTimeout> | null = null;
    private seen = new Set<string>();
    private destroyed = false;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    /** Unread notifications (server count; kept current by live events and mark-read calls) */
    get unread(): ReadableStore<number> {
        return this.unreadStore;
    }

    /** True once the unread count was loaded at least once */
    get unreadLoaded(): ReadableStore<boolean> {
        return this.unreadLoadedStore;
    }

    /** Why the unread count couldn't be loaded (null when fine) */
    get unreadError(): ReadableStore<Error | null> {
        return this.unreadErrorStore;
    }

    get live(): ReadableStore<NotificationsLiveState> {
        return this.liveStore;
    }

    /** The "all" feed's state (shortcut for `feed("all").state`) */
    get items(): ReadableStore<NotificationFeedState> {
        return this.feed("all").state;
    }

    /**
     * A feed for one server view: "all", "unread" (not read when loaded) or "mentions". Feeds are
     * kept per view and all receive live updates. Items marked read stay in the "unread" feed (shown
     * as read) until it is reloaded, so the list doesn't jump while the user reads it.
     */
    feed(view: NotificationView = "all"): NotificationFeed {
        let f = this.feeds.get(view);
        if (!f) {
            f = new NotificationFeed(this, view);
            this.feeds.set(view, f);
        }
        return f;
    }

    /** Load (or reload) the "all" feed */
    load(options: { refresh?: boolean } = {}): Promise<void> {
        return this.feed("all").load(options);
    }

    /** Next page of the "all" feed */
    loadMore(): Promise<void> {
        return this.feed("all").loadMore();
    }

    /**
     * Subscribe to live events and connect the socket when the token allows it (idempotent). Never
     * rejects: without realtime:connect, or when the socket fails, `live` is "unavailable" and the
     * feed keeps working over REST.
     */
    start(): Promise<void> {
        if (!this.wired) {
            this.wired = true;
            this.wire();
        }
        if (!this.starting) {
            this.starting = (async () => {
                this.realtimeAllowed = await this.client.hasScopes("realtime:connect").catch(() => false);
                if (!this.realtimeAllowed) {
                    this.liveStore.set("unavailable");
                    return;
                }
                this.offs.push(this.client.realtime.state.subscribe((s) => this.liveStore.set(liveFrom(s))));
                let timer: ReturnType<typeof setTimeout> | undefined;
                const connecting = this.client.realtime.connect().catch(() => undefined);
                await Promise.race([connecting, new Promise<void>((r) => (timer = setTimeout(r, CONNECT_WAIT_MS)))]);
                clearTimeout(timer);
            })();
        }
        return this.starting;
    }

    /** Reload the unread count (GET /notifications/unread-count) */
    refreshUnread(): Promise<number> {
        if (this.unreadLoad) return this.unreadLoad;
        this.unreadLoad = (async () => {
            try {
                const res = await this.client.http.get<{ unread: number }>("/notifications/unread-count");
                const n = Math.max(0, Number(res?.unread) || 0);
                this.setUnread(n);
                this.unreadLoadedStore.set(true);
                this.unreadErrorStore.set(null);
                return n;
            } catch (e) {
                this.unreadErrorStore.set(e as Error);
                throw e;
            } finally {
                this.unreadLoad = null;
            }
        })();
        return this.unreadLoad;
    }

    /** Whether the token may mark notifications read (notifications:write). */
    canMarkRead(): Promise<boolean> {
        return this.client.hasScopes("notifications:write").catch(() => false);
    }

    /**
     * Mark these notifications read (POST /notifications/read, scope notifications:write). Shown as
     * read immediately and rolled back if the server refuses. Resolves with how many were updated.
     */
    async markRead(ids: string[]): Promise<number> {
        const unique = [...new Set(ids.map(String).filter(Boolean))];
        if (!unique.length) return 0;
        const wereUnread = new Set(unique.filter((id) => this.findItem(id)?.read === false));
        const unreadBefore = this.unreadStore.value;
        // Optimistic; the server's `notification:read` event then sets the exact count
        this.patchRead((n) => wereUnread.has(n._id));
        this.setUnread(Math.max(0, unreadBefore - wereUnread.size));
        let updated = 0;
        try {
            for (let i = 0; i < unique.length; i += MARK_READ_BATCH) {
                const res = await this.client.http.post<{ updated: number }>("/notifications/read", { ids: unique.slice(i, i + MARK_READ_BATCH) });
                updated += Number(res?.updated) || 0;
            }
        } catch (e) {
            this.patchRead((n) => wereUnread.has(n._id), false);
            if (wereUnread.size) void this.refreshUnread().catch(() => this.setUnread(unreadBefore));
            throw e;
        }
        // Without the live event (REST-only token), or when ids unknown here were updated, read the count
        if (this.liveStore.value !== "live" || updated !== wereUnread.size) void this.refreshUnread().catch(() => undefined);
        return updated;
    }

    /** Mark every notification read (POST /notifications/read without ids, scope notifications:write). */
    async markAllRead(): Promise<number> {
        const before = this.snapshotUnread();
        const unreadBefore = this.unreadStore.value;
        this.patchRead(() => true);
        this.setUnread(0);
        try {
            const res = await this.client.http.post<{ updated: number }>("/notifications/read", {});
            return Number(res?.updated) || 0;
        } catch (e) {
            this.patchRead((n) => before.has(n._id), false);
            this.setUnread(unreadBefore);
            throw e;
        }
    }

    /** Runs for every new notification that arrives live (e.g. to show a toast). */
    onNotification(listener: (n: SpreeWeNotification) => void): Unsubscribe {
        return this.emitter.on("notification", listener);
    }

    /** Runs whenever the unread count changes */
    onUnreadChange(listener: (unread: number) => void): Unsubscribe {
        return this.emitter.on("unread", listener);
    }

    findItem(id: string): SpreeWeNotification | undefined {
        for (const f of this.feeds.values()) {
            const hit = f.state.value.items.find((n) => n._id === id);
            if (hit) return hit;
        }
        return undefined;
    }

    // ------------------------------------------------------------------ live events

    private wire(): void {
        const rt = this.client.realtime;
        this.offs.push(
            rt.on<unknown>("notification:new", (raw) => {
                const n = normalizeNotification(raw);
                if (n) this.onNew(n);
            }),
            rt.on<{ unread?: number }>("notification:read", (p) => {
                if (typeof p?.unread === "number") this.onReadCount(p.unread);
            }),
            rt.onConnect(() => {
                const first = !this.everConnected;
                this.everConnected = true;
                // After a reconnect (or a first connect that came after the REST load) events may have been missed
                if (!first || [...this.feeds.values()].some((f) => f.fetchedOnce)) this.resync();
            }),
        );
    }

    private onNew(n: SpreeWeNotification): void {
        const fresh = !this.seen.has(n._id);
        this.seen.add(n._id);
        if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-500));
        for (const f of this.feeds.values()) f.receive(n);
        if (fresh && !n.read && this.unreadLoadedStore.value) this.setUnread(this.unreadStore.value + 1);
        if (fresh) this.emitter.emit("notification", n);
    }

    private onReadCount(unread: number): void {
        const n = Math.max(0, unread);
        this.setUnread(n);
        this.unreadLoadedStore.set(true);
        if (n === 0) {
            this.patchRead(() => true);
            return;
        }
        // Read elsewhere (another device, or opening the chat cleared its mentions): find out which
        let localUnread = 0;
        const ids = new Set<string>();
        for (const f of this.feeds.values()) for (const item of f.state.value.items) if (!item.read && !ids.has(item._id)) (ids.add(item._id), localUnread++);
        if (localUnread > n) this.scheduleReadSync();
    }

    private scheduleReadSync(): void {
        if (this.readSyncTimer) return;
        this.readSyncTimer = setTimeout(() => {
            this.readSyncTimer = null;
            void this.syncReadFlags().catch(() => undefined);
        }, 300);
    }

    /** Re-read which loaded items are still unread (one request, newest 50 unread). */
    private async syncReadFlags(): Promise<void> {
        const page = await this.client.http.get<{ items?: unknown[]; nextCursor?: string | null }>("/notifications", { query: { view: "unread", limit: 50 } });
        const unread = (page?.items || []).map(normalizeNotification).filter((x): x is SpreeWeNotification => !!x);
        const ids = new Set(unread.map((n) => n._id));
        // Items older than the page's last entry may still be unread: leave those alone
        const oldest = page?.nextCursor && unread.length ? Date.parse(unread[unread.length - 1].createdAt) : -Infinity;
        this.patchRead((n) => !ids.has(n._id) && (Date.parse(n.createdAt) || 0) >= oldest);
    }

    private resync(): void {
        if (this.destroyed) return;
        if (this.unreadLoadedStore.value) void this.refreshUnread().catch(() => undefined);
        for (const f of this.feeds.values()) if (f.state.value.loaded) void f.catchUp();
    }

    private setUnread(n: number): void {
        if (n === this.unreadStore.value) return;
        this.unreadStore.set(n);
        this.emitter.emit("unread", n);
    }

    private snapshotUnread(): Set<string> {
        const out = new Set<string>();
        for (const f of this.feeds.values()) for (const n of f.state.value.items) if (!n.read) out.add(n._id);
        return out;
    }

    private patchRead(match: (n: SpreeWeNotification) => boolean, read = true): void {
        for (const f of this.feeds.values()) f.patch((n) => (n.read !== read && match(n) ? { ...n, read } : n));
    }

    /** Disconnect live handlers and drop loaded feeds (called by client.destroy()). */
    destroy(): void {
        this.destroyed = true;
        this.offs.splice(0).forEach((off) => off());
        if (this.readSyncTimer) clearTimeout(this.readSyncTimer);
        this.emitter.clear();
        this.feeds.clear();
    }
}

/** One server view of the feed, newest first, paged with the `before` cursor. */
export class NotificationFeed {
    readonly view: NotificationView;
    private readonly service: NotificationsService;
    private readonly store: Store<NotificationFeedState>;
    private cursor: string | null = null;
    private loading: Promise<void> | null = null;
    private loadToken: object | null = null;
    /** @internal A REST page was requested at least once */
    fetchedOnce = false;

    constructor(service: NotificationsService, view: NotificationView) {
        this.service = service;
        this.view = view;
        this.store = new Store<NotificationFeedState>({ view, items: [], loading: false, loadingMore: false, loaded: false, hasMore: false, error: null });
    }

    get state(): ReadableStore<NotificationFeedState> {
        return this.store;
    }

    /** First page (and the unread count). Concurrent calls share one request unless `refresh`. */
    load(options: { refresh?: boolean } = {}): Promise<void> {
        if (this.loading && !options.refresh) return this.loading;
        if (this.store.value.loaded && !options.refresh) return Promise.resolve();
        this.store.update((s) => ({ ...s, loading: true, error: null }));
        const token = {};
        this.loadToken = token;
        const current = () => this.loadToken === token;
        const run = (async () => {
            try {
                await this.service.start();
                void this.service.refreshUnread().catch(() => undefined);
                const page = await this.fetch(null);
                if (!current()) return;
                this.cursor = page.nextCursor;
                this.store.update((s) => ({ ...s, items: page.items, loading: false, loaded: true, hasMore: !!page.nextCursor, error: null }));
            } catch (e) {
                if (current()) this.store.update((s) => ({ ...s, loading: false, error: e as Error }));
                throw e;
            } finally {
                if (current()) this.loading = null;
            }
        })();
        this.loading = run;
        return run;
    }

    /** The next (older) page */
    async loadMore(): Promise<void> {
        const s = this.store.value;
        if (!s.loaded || s.loading || s.loadingMore || !s.hasMore || !this.cursor) return;
        this.store.update((x) => ({ ...x, loadingMore: true, error: null }));
        try {
            const page = await this.fetch(this.cursor);
            this.cursor = page.nextCursor;
            this.store.update((x) => ({ ...x, items: mergeById(x.items, page.items), loadingMore: false, hasMore: !!page.nextCursor }));
        } catch (e) {
            this.store.update((x) => ({ ...x, loadingMore: false, error: e as Error }));
            throw e;
        }
    }

    /** @internal After a reconnect: newest page again, merged with what's loaded (older pages kept). */
    async catchUp(): Promise<void> {
        try {
            const page = await this.fetch(null);
            const x = this.store.value;
            const fresh = new Set(page.items.map((n) => n._id));
            const oldest = page.items.length ? Date.parse(page.items[page.items.length - 1].createdAt) || 0 : Infinity;
            // Older loaded pages keep their place (and the cursor after them); the fresh page takes the server's state
            const older = page.nextCursor ? x.items.filter((n) => !fresh.has(n._id) && (Date.parse(n.createdAt) || 0) < oldest) : [];
            if (!older.length) this.cursor = page.nextCursor;
            this.store.set({ ...x, items: [...page.items, ...older], error: null, hasMore: older.length ? x.hasMore : !!page.nextCursor });
        } catch {
            // the next reconnect retries
        }
    }

    /** @internal A live notification */
    receive(n: SpreeWeNotification): void {
        const s = this.store.value;
        if (!s.loaded) return;
        if (this.view === "mentions" && n.type !== "mention") return;
        if (this.view === "unread" && n.read) return;
        if (s.items.some((x) => x._id === n._id)) return;
        this.store.set({ ...s, items: [n, ...s.items].sort(byNewest) });
    }

    /** @internal */
    patch(fn: (n: SpreeWeNotification) => SpreeWeNotification): void {
        const s = this.store.value;
        let changed = false;
        const items = s.items.map((n) => {
            const next = fn(n);
            if (next !== n) changed = true;
            return next;
        });
        if (changed) this.store.set({ ...s, items });
    }

    private async fetch(before: string | null): Promise<{ items: SpreeWeNotification[]; nextCursor: string | null }> {
        this.fetchedOnce = true;
        const res = await this.service.client.http.get<{ items?: unknown[]; nextCursor?: string | null }>("/notifications", {
            query: { limit: PAGE_SIZE, before: before || undefined, view: this.view === "all" ? undefined : this.view },
        });
        const items = (res?.items || []).map(normalizeNotification).filter((x): x is SpreeWeNotification => !!x);
        return { items, nextCursor: res?.nextCursor || null };
    }
}

/** Ids as strings and defaults for missing fields (the server sends ObjectIds and nulls). */
export function normalizeNotification(raw: unknown): SpreeWeNotification | null {
    const r = raw as Record<string, any> | null;
    if (!r || typeof r !== "object" || !r._id) return null;
    const id = (v: unknown) => (v === null || v === undefined || v === "" ? null : String((v as any)?._id ?? v));
    const actor = r.actor && typeof r.actor === "object" && r.actor._id ? { _id: String(r.actor._id), username: String(r.actor.username || ""), avatar: r.actor.avatar || undefined } : null;
    return {
        _id: String(r._id),
        type: String(r.type || ""),
        actor,
        conversationId: id(r.conversationId),
        messageId: id(r.messageId),
        callId: id(r.callId),
        meetingId: id(r.meetingId),
        recordingId: id(r.recordingId),
        text: typeof r.text === "string" ? r.text : "",
        read: !!r.read,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
    };
}

function liveFrom(s: string): NotificationsLiveState {
    if (s === "connected") return "live";
    if (s === "failed") return "unavailable";
    if (s === "idle") return "off";
    return "connecting";
}

function mergeById(a: SpreeWeNotification[], b: SpreeWeNotification[]): SpreeWeNotification[] {
    const seen = new Set(a.map((n) => n._id));
    return [...a, ...b.filter((n) => !seen.has(n._id))];
}

function byNewest(a: SpreeWeNotification, b: SpreeWeNotification): number {
    return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

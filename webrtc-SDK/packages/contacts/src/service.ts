import {
    PRESENCE_STATUSES,
    SpreeWeError,
    Store,
    type DirectoryEntry,
    type Page,
    type PresenceStatus,
    type PresenceUpdate,
    type ReadableStore,
    type Scope,
    type SpreeWeClient,
} from "@spreewe/core";
import type { BlockResult, ContactLookupResult, ContactProfile, ContactScope, DirectoryState, MyPresence, MyProfile, ProfileUpdate, StartedConversation } from "./types.js";

const CONTACTS_SERVICE = Symbol.for("spreewe.contacts");

/** Server limits (webrtc-BE services/userServices.ts, presence.service.ts, file.service.ts AVATAR_RULE) */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const BIO_MAX = 160;
export const STATUS_MESSAGE_MAX = 140;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** The client's contacts service (created on first use). */
export function getContacts(client: SpreeWeClient): ContactsService {
    return client.service(CONTACTS_SERVICE, (c) => new ContactsService(c));
}

/** Why a picture can't be used as a profile picture (null when it can). Mirrors the server's avatar rule. */
export function validateAvatar(file: Blob): string | null {
    if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return "Please choose a JPG, PNG, GIF or WebP image";
    if (!file.size) return "The file is empty";
    if (file.size > AVATAR_MAX_BYTES) return "This file is too large. The limit is 5 MB for this type.";
    return null;
}

/** Same rule as the server's validateUsername (null when valid). */
export function validateUsername(value: string): string | null {
    const name = value.replace(/\s+/g, " ").trim();
    if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return `Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`;
    if (!/^[\p{L}\p{M}\p{N} ._'-]+$/u.test(name)) return "Username can only contain letters, numbers, spaces and . _ ' -";
    return null;
}

/** A directory search with cursor paging (see ContactsService.browse). */
export interface DirectoryQuery {
    readonly state: ReadableStore<DirectoryState>;
    /** Load the next page (no-op while loading or when done) */
    loadMore(): Promise<void>;
    /** Start again from the first page */
    refresh(): Promise<void>;
}

/**
 * Headless contacts: directory search, profiles, presence, lookup by e-mail, blocking, and the
 * signed-in user's own profile and status.
 *
 * Scopes: directory:read (directory, lookup), profile:read (profiles, my profile), realtime:connect
 * (live presence, and the socket used by block / presence); contacts:write (start a chat by e-mail,
 * block / unblock), profile:write (update my profile, set my status).
 *
 * Who appears: in an organization, its active members; in the personal (global) context, only people
 * the user already shares a conversation with. Others are found by exact e-mail with `lookup()`.
 */
export class ContactsService {
    readonly client: SpreeWeClient;
    private readonly blockedStore = new Store<ReadonlyMap<string, boolean>>(new Map());
    private readonly meStore = new Store<MyProfile | null>(null);
    private meLoad: Promise<MyProfile> | null = null;
    private live: Promise<boolean> | null = null;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    // ------------------------------------------------------------------ presence

    /** Live presence by user id (shared with every module: `client.people.presence`). */
    get presence(): ReadableStore<ReadonlyMap<string, PresenceUpdate>> {
        return this.client.people.presence;
    }

    /**
     * Connect the socket so `user:presence` updates arrive (needs realtime:connect). Resolves true when
     * live, false when the token can't connect; never rejects.
     */
    startPresence(): Promise<boolean> {
        if (!this.live) {
            const attempt = (async () => {
                if (!(await this.client.hasScopes("realtime:connect"))) return false;
                void this.client.people.presence; // wires the user:presence listener
                await this.client.realtime.connect();
                return true;
            })().catch(() => {
                if (this.live === attempt) this.live = null;
                return false;
            });
            this.live = attempt;
        }
        return this.live;
    }

    // ------------------------------------------------------------------ directory & profiles

    /** One directory page (GET /v1/directory). Seeds the presence store and the profile cache. */
    async search(params: { q?: string; limit?: number; cursor?: string | null } = {}): Promise<Page<DirectoryEntry>> {
        const page = await this.client.people.directory({ q: params.q?.trim() || undefined, limit: params.limit, cursor: params.cursor });
        this.client.people.seedPresence(page.items);
        return page;
    }

    /** A directory search you can page through ("load more" / infinite scroll). */
    browse(options: { q?: string; pageSize?: number } = {}): DirectoryQuery {
        const q = (options.q || "").trim();
        const limit = Math.min(Math.max(options.pageSize || 30, 1), 100);
        const store = new Store<DirectoryState>({ q, items: [], loading: false, loaded: false, error: null, nextCursor: null, done: false });
        let inflight: Promise<void> | null = null;
        let generation = 0;
        const fetchPage = (reset: boolean): Promise<void> => {
            const s = store.value;
            if (!reset && (inflight || s.done)) return inflight || Promise.resolve();
            const gen = ++generation;
            store.set({ ...s, loading: true, error: null, ...(reset ? { items: [], nextCursor: null, done: false, loaded: false } : {}) });
            const cursor = reset ? null : s.nextCursor;
            const run = this.search({ q, limit, cursor }).then(
                (page) => {
                    if (gen !== generation) return;
                    const seen = new Set(store.value.items.map((i) => i._id));
                    const items = [...store.value.items, ...page.items.filter((i) => !seen.has(i._id))];
                    store.set({ ...store.value, items, loading: false, loaded: true, nextCursor: page.nextCursor, done: !page.nextCursor });
                },
                (e) => {
                    if (gen === generation) store.set({ ...store.value, loading: false, error: e as Error });
                    throw e;
                },
            );
            inflight = run;
            const clear = () => {
                if (inflight === run) inflight = null;
            };
            run.then(clear, clear);
            return run;
        };
        void fetchPage(true).catch(() => undefined);
        return { state: store, loadMore: () => fetchPage(false), refresh: () => fetchPage(true) };
    }

    /** A profile the user may see (404 otherwise). Cached per client; `refresh` re-fetches. */
    async profile(userId: string, options: { refresh?: boolean } = {}): Promise<ContactProfile> {
        const p = (await this.client.people.profile(userId, options)) as ContactProfile;
        if (p && p.isOnline !== undefined) this.client.people.seedPresence([{ _id: String(p._id), isOnline: p.isOnline, status: p.status, statusMessage: p.statusMessage }]);
        return p;
    }

    // ------------------------------------------------------------------ lookup by e-mail

    /**
     * Find an eligible person by exact e-mail (POST /v1/contacts/lookup, directory:read). `scope` only
     * matters in an organization ("external" needs the organization's policy; the personal context
     * refuses it with 400). Rate-limited per user (30 per 10 minutes by default).
     */
    lookup(email: string, options: { scope?: ContactScope } = {}): Promise<ContactLookupResult> {
        return this.client.http.post<ContactLookupResult>("/v1/contacts/lookup", { email, ...(options.scope ? { scope: options.scope } : {}) });
    }

    /** Open (or reuse) a direct conversation with the person behind this e-mail (contacts:write). 404 when not eligible. */
    startConversation(email: string, options: { scope?: ContactScope } = {}): Promise<StartedConversation> {
        return this.client.http.post<StartedConversation>("/v1/contacts/start", { email, ...(options.scope ? { scope: options.scope } : {}) });
    }

    // ------------------------------------------------------------------ blocking

    /**
     * People this user blocked or unblocked during this session, plus states read with
     * `blockedInConversation()`. The server has no "my block list" endpoint, so absence means unknown.
     */
    get blocked(): ReadableStore<ReadonlyMap<string, boolean>> {
        return this.blockedStore;
    }

    block(userId: string): Promise<BlockResult> {
        return this.setBlocked(userId, true);
    }

    unblock(userId: string): Promise<BlockResult> {
        return this.setBlocked(userId, false);
    }

    private async setBlocked(userId: string, blocked: boolean): Promise<BlockResult> {
        const ack = await this.socketRequest<{ userId: string; blocked: boolean }>(blocked ? "chat:block" : "chat:unblock", { userId }, "contacts:write");
        const result = { userId: String(ack?.userId || userId), blocked: !!ack?.blocked };
        this.blockedStore.set(new Map(this.blockedStore.value).set(result.userId, result.blocked));
        return result;
    }

    /**
     * Whether I blocked the other person of a direct conversation (GET /conversations/:id/state,
     * conversations:read). Only my own block is revealed, never whether they blocked me.
     */
    async blockedInConversation(conversationId: string): Promise<{ peerId: string | null; blockedByMe: boolean }> {
        const state = await this.client.http.get<{ peerId?: string | null; blockedByMe?: boolean }>(`/conversations/${encodeURIComponent(conversationId)}/state`);
        const peerId = state?.peerId ? String(state.peerId) : null;
        const blockedByMe = !!state?.blockedByMe;
        if (peerId) this.blockedStore.set(new Map(this.blockedStore.value).set(peerId, blockedByMe));
        return { peerId, blockedByMe };
    }

    // ------------------------------------------------------------------ me

    /** My profile with my real chosen status (GET /web/user/me). */
    get me(): ReadableStore<MyProfile | null> {
        return this.meStore;
    }

    loadMyProfile(options: { refresh?: boolean } = {}): Promise<MyProfile> {
        if (!this.meLoad || options.refresh) {
            const load = this.client.http.get<MyProfile>("/web/user/me").then((me) => {
                this.meStore.set(me);
                return me;
            });
            load.catch(() => {
                if (this.meLoad === load) this.meLoad = null;
            });
            this.meLoad = load;
        }
        return this.meLoad;
    }

    /**
     * Set my status and / or status message (socket `presence:set`, profile:write). Contacts see
     * "Appear offline" as offline. App connections never mark the user online, so `isOnline` in the
     * answer reflects the user's SpreeWe apps only.
     */
    async setPresence(update: { status?: PresenceStatus; statusMessage?: string }): Promise<MyPresence> {
        const payload: Record<string, unknown> = {};
        if (update.status !== undefined) {
            if (!(PRESENCE_STATUSES as readonly string[]).includes(update.status)) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Invalid status" });
            payload.status = update.status;
        }
        if (update.statusMessage !== undefined) {
            const text = update.statusMessage.replace(/\s+/g, " ").trim();
            if (text.length > STATUS_MESSAGE_MAX) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: `Status messages can be up to ${STATUS_MESSAGE_MAX} characters` });
            payload.statusMessage = text;
        }
        if (!Object.keys(payload).length) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Nothing to update" });
        const ack = await this.socketRequest<{ success: true; presence: MyPresence }>("presence:set", payload, "profile:write");
        const presence = ack.presence;
        const me = this.meStore.value;
        if (me) this.meStore.set({ ...me, status: presence.ownStatus, statusMessage: presence.statusMessage });
        return presence;
    }

    /** Report that the user is idle / back (socket `presence:idle`, profile:write): shown as Away while Available. */
    async setIdle(idle: boolean): Promise<void> {
        await this.requireScopes("profile:write", "realtime:connect");
        await this.client.realtime.connect();
        this.client.realtime.emit("presence:idle", { idle });
    }

    /** Change my name, bio, picture or discoverability (PATCH /web/user/profile, multipart, profile:write). */
    async updateProfile(update: ProfileUpdate): Promise<MyProfile> {
        const form = new FormData();
        if (update.username !== undefined) {
            const problem = validateUsername(update.username);
            if (problem) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: problem });
            form.append("username", update.username.replace(/\s+/g, " ").trim());
        }
        if (update.bio !== undefined) {
            if (update.bio.trim().length > BIO_MAX) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: `Bio is too long (max ${BIO_MAX} characters)` });
            form.append("bio", update.bio);
        }
        if (update.globalDiscoverable !== undefined) form.append("globalDiscoverable", update.globalDiscoverable ? "true" : "false");
        if (update.image) {
            const problem = validateAvatar(update.image);
            if (problem) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: problem });
            const name = (update.image as Blob & { name?: string }).name || `avatar.${update.image.type.split("/")[1] || "jpg"}`;
            form.append("image", update.image, name);
        }
        if (![...form.keys()].length) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Nothing to update" });
        const user = await this.client.http.patch<MyProfile>("/web/user/profile", undefined, { form });
        // PATCH answers with others' view of the status; keep my real one
        const prev = this.meStore.value;
        this.meStore.set({ ...(prev || {}), ...user, status: prev?.status ?? user.status });
        void this.client.people.profile(String(user._id), { refresh: true }).catch(() => undefined);
        void this.client.loadMe({ refresh: true }).catch(() => undefined);
        return this.meStore.value!;
    }

    // ------------------------------------------------------------------ internals

    private async requireScopes(...scopes: Scope[]): Promise<void> {
        const have = await this.client.scopes();
        if (!have) return;
        const missing = scopes.find((s) => !have.has(s));
        if (missing) throw new SpreeWeError({ code: "MISSING_SCOPE", message: `The token lacks the ${missing} scope` });
    }

    /** Socket request with a clear MISSING_SCOPE error (refused events are never acked by the server). */
    private async socketRequest<T>(event: string, payload: unknown, scope: Scope): Promise<T> {
        await this.requireScopes(scope, "realtime:connect");
        await this.client.realtime.connect();
        return this.client.realtime.request<T>(event, payload);
    }

    destroy(): void {
        this.meLoad = null;
    }
}

import {
    SpreeWeError,
    Store,
    getE2ee,
    isSpreeWeError,
    type Conversation,
    type DirectConversation,
    type E2eeEngine,
    type EncryptedPayload,
    type GroupConversation,
    type LastMessage,
    type Message,
    type ReadableStore,
    type SecureContent,
    type SpreeWeClient,
    type Unsubscribe,
    type UserSummary,
} from "@spreewe/core";
import type { AttachmentView, BodyState, ChatMessage, ConversationListState, ConversationSummary, MessagesState, SendBlocker, SendOptions } from "./types.js";

const CHAT_SERVICE = Symbol.for("spreewe.chat");
const PAGE_SIZE = 30;
const CONFIRM_TIMEOUT_MS = 20_000;

/** The client's chat service (created on first use). */
export function getChat(client: SpreeWeClient): ChatService {
    return client.service(CHAT_SERVICE, (c) => new ChatService(c));
}

/** Media kind the server files an encrypted attachment under (visible metadata, same rule as the SpreeWe apps). */
export function mediaKind(mime: string): "image" | "video" | "audio" | "pdf" | "file" {
    if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    return "file";
}

const MB = 1024 * 1024;
/** Client-side mirror of the server's upload rules (webrtc-BE file.service MEDIA_RULES) for instant feedback */
const UPLOAD_RULES: { kind: string; maxMb: number; test: (f: Blob & { name?: string }, ext: string) => boolean }[] = [
    { kind: "image", maxMb: 10, test: (f) => /^image\/(jpeg|png|gif|webp)$/.test(f.type) },
    { kind: "video", maxMb: 100, test: (f) => /^video\/(mp4|webm|quicktime)$/.test(f.type) },
    { kind: "audio", maxMb: 25, test: (f) => f.type.startsWith("audio/") },
    { kind: "pdf", maxMb: 25, test: (f, ext) => f.type === "application/pdf" || ext === "pdf" },
    { kind: "file", maxMb: 50, test: (_f, ext) => ["zip", "docx", "xlsx", "pptx", "doc", "xls", "ppt", "txt", "log", "csv", "md"].includes(ext) },
];
export const UPLOAD_ACCEPT =
    "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,.zip,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.txt,.log,.csv,.md";

/** Why a file can't be sent (null when it can) */
export function validateUpload(file: Blob & { name?: string }): { code: "type" | "empty" | "size"; maxMb?: number } | null {
    const ext = (file.name?.split(".").pop() || "").toLowerCase();
    const rule = UPLOAD_RULES.find((r) => r.test(file, ext));
    if (!rule) return { code: "type" };
    if (!file.size) return { code: "empty" };
    if (file.size > rule.maxMb * MB) return { code: "size", maxMb: rule.maxMb };
    return null;
}

/**
 * Headless chat: conversation list, message history and live updates over the shared socket,
 * decryption through the client's encryption device (@spreewe/e2ee), and sending.
 *
 * Scopes: conversations:read, groups:read, messages:read and realtime:connect to read;
 * messages:write + e2ee:device to send (messages are always end-to-end encrypted);
 * messages:react, messages:edit, messages:delete, files:write for the matching actions.
 */
export class ChatService {
    readonly client: SpreeWeClient;
    private readonly listStore = new Store<ConversationListState>({ items: [], loading: false, loaded: false, error: null, groupsUnavailable: false });
    private readonly sessions = new Map<string, { session: ConversationSession; refs: number }>();
    private listLoad: Promise<void> | null = null;
    private readonly offs: Unsubscribe[] = [];
    private me = "";
    private deliveredQueue = new Set<string>();
    private deliveredTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly previewCache = new Map<string, { text: string; state: BodyState }>();
    private wired = false;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    get conversations(): ReadableStore<ConversationListState> {
        return this.listStore;
    }

    /** Total unread across the listed conversations */
    get unreadTotal(): number {
        return this.listStore.value.items.reduce((n, c) => n + (c.isArchived ? 0 : c.unread), 0);
    }

    get e2ee(): E2eeEngine | null {
        return getE2ee(this.client);
    }

    /** Connect the socket and subscribe to live events (idempotent). Called by every read method. */
    async start(): Promise<void> {
        if (!this.me) this.me = await this.client.userId();
        if (!this.wired) {
            this.wired = true;
            this.wire();
        }
        this.wireE2ee();
        const e2ee = this.e2ee;
        if (e2ee && e2ee.status.value === "idle") void e2ee.start().catch(() => undefined);
        await this.client.realtime.connect();
    }

    get myUserId(): string {
        return this.me;
    }

    // ------------------------------------------------------------------ conversation list

    /** Load (or reload) direct chats and groups. Archived chats with `{ archived: true }`. */
    loadConversations(options: { archived?: boolean; refresh?: boolean } = {}): Promise<void> {
        if (this.listLoad && !options.refresh) return this.listLoad;
        this.listStore.update((s) => ({ ...s, loading: true, error: null }));
        this.listLoad = (async () => {
            try {
                await this.start();
                const query = options.archived ? { archived: "true" } : undefined;
                const [direct, groups] = await Promise.all([
                    this.client.http.get<DirectConversation[]>("/conversations", { query }),
                    this.client.http.get<GroupConversation[]>("/groupConversations", { query }).catch((e) => {
                        if (isSpreeWeError(e) && (e.status === 403 || e.status === 401)) return null;
                        throw e;
                    }),
                ]);
                const items = [...(direct || []).map((c) => this.summarize({ ...c, isGroup: false })), ...(groups || []).map((g) => this.summarize({ ...g, isGroup: true }))];
                items.sort(byRecent);
                this.listStore.set({ items, loading: false, loaded: true, error: null, groupsUnavailable: groups === null });
                void this.decryptPreviews();
            } catch (e) {
                this.listStore.update((s) => ({ ...s, loading: false, error: e as Error }));
                this.listLoad = null;
                throw e;
            }
        })();
        return this.listLoad;
    }

    findConversation(id: string): ConversationSummary | undefined {
        return this.listStore.value.items.find((c) => c.id === id);
    }

    private summarize(c: Conversation): ConversationSummary {
        const people = this.client.people;
        if (c.lastMessage) this.rawLast.set(String(c._id), c.lastMessage);
        if (c.isGroup) {
            people.remember(c.members || []);
            return {
                id: String(c._id),
                isGroup: true,
                title: c.groupName || "Group",
                avatar: c.groupAvatar || undefined,
                members: c.members || [],
                admins: (c.groupAdmins || []).map(String),
                description: c.groupDescription,
                scope: c.scope,
                unread: c.unreadCount || 0,
                isFavorite: !!c.isFavorite,
                isArchived: !!c.isArchived,
                ...this.previewOf(c.lastMessage, String(c._id)),
            };
        }
        const peer = c.receiver;
        people.remember([peer, c.sender]);
        return {
            id: String(c._id),
            isGroup: false,
            title: peer?.username || "Unknown",
            avatar: peer?.avatar || undefined,
            peer,
            scope: c.scope,
            unread: c.unreadCount || 0,
            isFavorite: !!c.isFavorite,
            isArchived: !!c.isArchived,
            ...this.previewOf(c.lastMessage, String(c._id)),
        };
    }

    private previewOf(m: LastMessage | Message | null | undefined, conversationId: string): Pick<ConversationSummary, "preview" | "previewState" | "lastMessageAt" | "lastMessageAuthorId" | "lastMessageStatus" | "lastMessageType"> {
        if (!m) return { preview: "", previewState: "ok" };
        const cached = this.previewCache.get(String(m._id));
        const base = { lastMessageAt: m.createdAt, lastMessageAuthorId: String(m.userId || ""), lastMessageStatus: m.status, lastMessageType: m.type };
        if (cached) return { ...base, preview: cached.text, previewState: cached.state };
        if (m.e2ee) return { ...base, preview: "", previewState: this.e2ee ? "pending" : "locked" };
        if ((m as Message).encrypted || m.content === null) return { ...base, preview: "", previewState: "withheld" };
        void conversationId;
        return { ...base, preview: m.type === "text" || m.type === "system" || m.type === "call" ? m.content || "" : "", previewState: "ok" };
    }

    private async decryptPreviews(): Promise<void> {
        const e2ee = this.e2ee;
        if (!e2ee) return;
        await e2ee.start().catch(() => undefined);
        if (e2ee.status.value !== "ready") return;
        for (const c of this.listStore.value.items) {
            if (c.previewState !== "pending") continue;
            const raw = this.rawLast.get(c.id);
            if (!raw?.e2ee) continue;
            const d = await e2ee.decrypt({ _id: String(raw._id), conversationId: c.id, e2ee: raw.e2ee, userId: String(raw.userId), createdAt: raw.createdAt });
            const text = d.state === "ok" ? d.content?.text || d.content?.file?.name || "" : "";
            const state: BodyState = d.state === "ok" ? "ok" : d.state;
            if (d.state !== "pending") this.previewCache.set(String(raw._id), { text, state });
            this.patchConversation(c.id, { preview: text, previewState: state });
        }
    }

    /** Last raw message per conversation (for preview decryption) */
    private readonly rawLast = new Map<string, LastMessage | Message>();

    private patchConversation(id: string, patch: Partial<ConversationSummary>): void {
        this.listStore.update((s) => ({ ...s, items: s.items.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    }

    /** Start (or reopen) a direct chat with a user id (POST /conversations, scope conversations:write). */
    async openDirect(userId: string): Promise<string> {
        const res = await this.client.http.post<{ conversationId: string }>("/conversations", { receiverId: userId });
        const id = String(res.conversationId);
        if (!this.findConversation(id)) void this.loadConversations({ refresh: true }).catch(() => undefined);
        return id;
    }

    /** Start a chat with someone by e-mail (POST /v1/contacts/start, scope contacts:write). */
    async openByEmail(email: string, scope?: "member" | "external"): Promise<{ conversationId: string; external: boolean }> {
        const res = await this.client.http.post<{ conversationId: string; external: boolean }>("/v1/contacts/start", { email, ...(scope ? { scope } : {}) });
        void this.loadConversations({ refresh: true }).catch(() => undefined);
        return res;
    }

    private async chatAction(event: string, conversationId: string): Promise<any> {
        await this.start();
        return this.client.realtime.request(event, { conversationId });
    }

    async setArchived(conversationId: string, archived: boolean): Promise<void> {
        await this.chatAction(archived ? "chat:archive" : "chat:unarchive", conversationId);
        this.patchConversation(conversationId, { isArchived: archived });
    }

    async setFavorite(conversationId: string, favorite: boolean): Promise<void> {
        await this.chatAction(favorite ? "chat:favorite" : "chat:unfavorite", conversationId);
        this.patchConversation(conversationId, { isFavorite: favorite });
    }

    /** Clear the chat for this user only (scope conversations:write) */
    async clear(conversationId: string): Promise<void> {
        await this.chatAction("chat:clear", conversationId);
        this.sessions.get(conversationId)?.session.resetAfterClear();
        this.patchConversation(conversationId, { preview: "", previewState: "ok", unread: 0 });
    }

    async setBlocked(userId: string, blocked: boolean): Promise<void> {
        await this.start();
        await this.client.realtime.request(blocked ? "chat:block" : "chat:unblock", { userId });
    }

    // ------------------------------------------------------------------ sessions

    /**
     * Open a conversation: history, live messages, typing and receipts. Reference-counted; call
     * `release()` on the returned session when the view closes.
     */
    open(conversationId: string): ConversationSession {
        let entry = this.sessions.get(conversationId);
        if (!entry) {
            entry = { session: new ConversationSession(this, conversationId), refs: 0 };
            this.sessions.set(conversationId, entry);
        }
        entry.refs++;
        const session = entry.session;
        session.activate();
        return session;
    }

    /** @internal */
    releaseSession(conversationId: string): void {
        const entry = this.sessions.get(conversationId);
        if (!entry) return;
        entry.refs--;
        if (entry.refs <= 0) {
            entry.session.dispose();
            this.sessions.delete(conversationId);
        }
    }

    /** Whether the user can send here, and if not, why */
    sendBlocker(): SendBlocker {
        const e2ee = this.e2ee;
        if (!e2ee) return { reason: "no-e2ee", message: "Sending needs an encryption device (@spreewe/e2ee)." };
        const s = e2ee.status.value;
        if (s === "starting" || s === "idle") return { reason: "e2ee-starting", message: "Setting up encryption…" };
        if (s !== "ready") return { reason: "e2ee-error", message: e2ee.statusMessage || "Encryption isn't available on this device." };
        return null;
    }

    // ------------------------------------------------------------------ live events

    private wire(): void {
        const rt = this.client.realtime;
        this.offs.push(
            rt.on<Message>("receiveMessage", (m) => this.onMessage(m)),
            rt.on<{ conversationId: string; reason: string; message?: string }>("message:rejected", (r) => {
                if (r?.conversationId) this.sessions.get(String(r.conversationId))?.session.onRejected(r.reason, r.message);
            }),
            rt.on<{ conversationId: string; messageId: string; e2ee?: EncryptedPayload; editedAt: string; mentions?: string[] }>("message:updated", (u) =>
                this.sessions.get(String(u?.conversationId))?.session.onUpdated(u),
            ),
            rt.on<{ conversationId: string; messageId: string }>("message:deleted", (d) => this.sessions.get(String(d?.conversationId))?.session.onDeleted(String(d.messageId))),
            rt.on<{ conversationId: string; messageId: string; reactions: Message["reactions"] }>("messageReactionUpdated", (r) =>
                this.sessions.get(String(r?.conversationId))?.session.onReactions(String(r.messageId), r.reactions || []),
            ),
            rt.on<{ conversationId: string; userId: string; isTyping: boolean }>("userTyping", (t) => this.sessions.get(String(t?.conversationId))?.session.onTyping(String(t.userId), !!t.isTyping)),
            rt.on<{ conversationId: string; userId: string; readAt?: string; deliveredAt?: string }>("receipts:updated", (r) => {
                this.sessions.get(String(r?.conversationId))?.session.onReceipt(r);
                if (r && String(r.userId) === this.me && r.readAt) this.patchConversation(String(r.conversationId), { unread: 0 });
            }),
            rt.on<{ conversationId: string; userId: string }>("messagesMarkedRead", (r) => {
                this.sessions.get(String(r?.conversationId))?.session.onReceipt({ userId: String(r.userId), readAt: new Date().toISOString() });
            }),
            rt.on("group:added", () => void this.loadConversations({ refresh: true }).catch(() => undefined)),
            rt.on<{ groupId: string }>("group:removed", (g) => {
                this.listStore.update((s) => ({ ...s, items: s.items.filter((c) => c.id !== String(g?.groupId)) }));
                this.sessions.get(String(g?.groupId))?.session.onRemoved();
            }),
            rt.on<{ groupId: string; group: GroupConversation }>("group:updated", (g) => {
                const id = String(g?.groupId || "");
                const current = this.findConversation(id);
                if (!current || !g.group) return;
                this.client.people.remember(g.group.members || []);
                this.patchConversation(id, {
                    title: g.group.groupName || current.title,
                    avatar: g.group.groupAvatar || undefined,
                    description: g.group.groupDescription,
                    members: Array.isArray(g.group.members) && typeof g.group.members[0] === "object" ? g.group.members : current.members,
                    admins: (g.group.groupAdmins || current.admins || []).map(String),
                });
            }),
            rt.onConnect(() => {
                // Missed events while offline: refresh the list and every open conversation
                if (this.listStore.value.loaded) void this.loadConversations({ refresh: true }).catch(() => undefined);
                for (const { session } of this.sessions.values()) void session.catchUp();
            }),
        );
    }

    private e2eeWired: E2eeEngine | null = null;

    /** Encryption can be enabled after chat started: attach to whichever device is registered now */
    private wireE2ee(): void {
        const e2ee = this.e2ee;
        if (e2ee && this.e2eeWired !== e2ee) {
            this.e2eeWired = e2ee;
            this.offs.push(
                e2ee.onKeysChanged(() => {
                    void this.decryptPreviews();
                    for (const { session } of this.sessions.values()) void session.retryPending();
                }),
                e2ee.status.subscribe((s) => {
                    if (s === "ready") {
                        void this.decryptPreviews();
                        for (const { session } of this.sessions.values()) void session.retryPending();
                    }
                }),
            );
        }
    }

    private seen = new Set<string>();

    private onMessage(m: Message): void {
        if (!m?._id) return;
        const id = String(m._id);
        const conversationId = String(m.conversationId);
        const session = this.sessions.get(conversationId)?.session;
        session?.onIncoming(m);
        // Delivered twice (room and per user): count once
        if (this.seen.has(id)) return;
        this.seen.add(id);
        if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-1000));
        this.rawLast.set(conversationId, m);
        const fromMe = String(m.userId) === this.me;
        const current = this.findConversation(conversationId);
        if (!current) {
            void this.loadConversations({ refresh: true }).catch(() => undefined);
        } else {
            const visible = !!session?.isVisible;
            this.listStore.update((s) => {
                const items = s.items.map((c) =>
                    c.id === conversationId
                        ? { ...c, ...this.previewOf(m, conversationId), unread: fromMe || visible ? (visible ? 0 : c.unread) : c.unread + 1, isArchived: fromMe ? c.isArchived : false }
                        : c,
                );
                items.sort(byRecent);
                return { ...s, items };
            });
            if (m.e2ee) void this.decryptPreviews();
        }
        if (!fromMe) this.queueDelivered(conversationId);
    }

    private queueDelivered(conversationId: string): void {
        this.deliveredQueue.add(conversationId);
        if (this.deliveredTimer) return;
        this.deliveredTimer = setTimeout(() => {
            this.deliveredTimer = null;
            const ids = [...this.deliveredQueue].slice(0, 50);
            this.deliveredQueue.clear();
            if (ids.length && this.client.realtime.connected) this.client.realtime.emit("message:delivered", { conversationIds: ids });
        }, 400);
    }

    /** @internal */
    markedRead(conversationId: string): void {
        this.patchConversation(conversationId, { unread: 0 });
    }

    /** @internal Decrypt (or describe) a message for display */
    async reveal(m: Message, previous?: ChatMessage): Promise<ChatMessage> {
        const out: ChatMessage = { ...m, _id: String(m._id), conversationId: String(m.conversationId), userId: String((m.userId as any)?._id || m.userId || m.user?._id || ""), text: "", bodyState: "ok" };
        if (out.user) this.client.people.remember([out.user]);
        if (m.isDeleted) return out;
        const e2ee = this.e2ee;
        if (m.e2ee) {
            if (!e2ee) {
                out.bodyState = "locked";
            } else {
                const d = await e2ee.decrypt({ _id: out._id, conversationId: out.conversationId, e2ee: m.e2ee, userId: out.userId, createdAt: m.createdAt });
                out.bodyState = d.state === "ok" ? "ok" : d.state;
                out.warning = d.warning;
                if (d.state === "ok") {
                    out.text = d.content?.text || "";
                    const f = d.content?.file;
                    if (f) {
                        const kind = mediaKind(f.mimeType);
                        const prev = previous?.attachment;
                        out.attachment =
                            prev && prev.secure?.sha256 === f.sha256
                                ? prev
                                : { name: f.name, size: f.size, mimeType: f.mimeType, kind, state: "idle", secure: f, sourceUrl: m.downloadUrl || m.fileUrl };
                    }
                }
            }
        } else if (m.encrypted || m.content === null) {
            out.bodyState = "withheld";
        } else {
            out.text = m.type === "text" || m.type === "system" || m.type === "call" ? m.content || "" : m.content && m.content !== m.type ? m.content : "";
            if (m.fileUrl || m.downloadUrl) {
                // Legacy plaintext attachment (sent before encryption): signed links, shown as they are
                const mime = m.mimeType || "";
                out.attachment = {
                    name: m.fileName || m.type,
                    size: m.fileSize,
                    mimeType: mime,
                    kind: m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "pdf" ? m.type : "file",
                    url: m.fileUrl || m.downloadUrl,
                    sourceUrl: m.downloadUrl || m.fileUrl,
                    state: "ready",
                };
            }
        }
        const q = m.replyTo;
        if (q && typeof q === "object") {
            let text = "";
            let state: BodyState = "ok";
            if (q.e2ee && e2ee) {
                const d = await e2ee.decrypt({ _id: String(q._id), conversationId: out.conversationId, e2ee: q.e2ee, userId: String(q.userId) });
                state = d.state === "ok" ? "ok" : d.state;
                text = d.state === "ok" ? d.content?.text || d.content?.file?.name || "" : "";
            } else if (q.e2ee) state = "locked";
            else if (q.encrypted || q.content === null) state = "withheld";
            else text = q.content || "";
            out.quote = { messageId: String(q._id), authorId: String(q.userId || ""), text, bodyState: state };
        }
        return out;
    }

    /** @internal Encrypt + send through the socket. Returns the ciphertext (used to confirm the echo). */
    async sendEncrypted(conversationId: string, content: SecureContent, extra: { type: string; storageKey?: string; replyTo?: string | null; mentions?: string[] }): Promise<EncryptedPayload> {
        const e2ee = this.e2ee;
        if (!e2ee) throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: "Sending needs an encryption device (@spreewe/e2ee)." });
        await e2ee.start();
        const payload = await e2ee.encrypt(conversationId, content);
        await this.start();
        this.client.realtime.emit("sendMessage", {
            user: { _id: this.me },
            conversationId,
            type: extra.type,
            content: "",
            e2ee: payload,
            ...(extra.storageKey ? { storageKey: extra.storageKey } : {}),
            replyTo: extra.replyTo || null,
            ...(extra.mentions?.length ? { mentions: extra.mentions } : {}),
        });
        return payload;
    }

    destroy(): void {
        this.offs.splice(0).forEach((off) => off());
        for (const { session } of this.sessions.values()) session.dispose();
        this.sessions.clear();
        if (this.deliveredTimer) clearTimeout(this.deliveredTimer);
    }
}

function byRecent(a: ConversationSummary, b: ConversationSummary): number {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    return (Date.parse(b.lastMessageAt || "") || 0) - (Date.parse(a.lastMessageAt || "") || 0);
}

interface Receipt {
    readAt: string | null;
    deliveredAt: string | null;
}

/**
 * One open conversation: messages (oldest first), typing users, receipts and actions. Obtain with
 * `getChat(client).open(id)`; call `release()` when done.
 */
export class ConversationSession {
    readonly conversationId: string;
    private readonly chat: ChatService;
    private readonly store = new Store<MessagesState>({ items: [], loading: false, loadingOlder: false, hasOlder: true, error: null });
    private readonly typingStore = new Store<string[]>([]);
    private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private page = 0;
    private leaveRoom: Unsubscribe | null = null;
    private loaded: Promise<void> | null = null;
    private readonly receipts = new Map<string, Receipt>();
    private memberIds: string[] = [];
    private readonly pending = new Map<string, { ciphertext: string; timer: ReturnType<typeof setTimeout> }>();
    private typingSent = 0;
    private stopTypingTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly objectUrls = new Set<string>();
    private disposed = false;
    private visible = false;
    private localSeq = 0;
    private readonly removedStore = new Store(false);

    constructor(chat: ChatService, conversationId: string) {
        this.chat = chat;
        this.conversationId = conversationId;
    }

    get messages(): ReadableStore<MessagesState> {
        return this.store;
    }

    /** User ids typing right now (not including me) */
    get typing(): ReadableStore<string[]> {
        return this.typingStore;
    }

    /** True once the user was removed from this group (or it was deleted) */
    get removed(): ReadableStore<boolean> {
        return this.removedStore;
    }

    get isVisible(): boolean {
        return this.visible;
    }

    /** Tell the session whether the user can see it; visible sessions mark new messages read. */
    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) this.markRead();
    }

    release(): void {
        this.chat.releaseSession(this.conversationId);
    }

    /** @internal */
    activate(): void {
        if (!this.loaded) {
            this.loaded = this.loadInitial().catch(() => undefined);
        }
    }

    private async loadInitial(): Promise<void> {
        this.store.update((s) => ({ ...s, loading: true, error: null }));
        try {
            await this.chat.start();
            if (this.disposed) return;
            this.leaveRoom ||= this.chat.client.realtime.joinConversation(this.conversationId);
            await Promise.all([this.fetchPage(1, true), this.loadReceipts()]);
        } catch (e) {
            this.store.update((s) => ({ ...s, loading: false, error: e as Error }));
            this.loaded = null;
            throw e;
        }
    }

    private async loadReceipts(): Promise<void> {
        try {
            const state = await this.chat.client.http.get<{ receipts?: { userId: string; readAt: string | null; deliveredAt: string | null }[] }>(
                `/conversations/${encodeURIComponent(this.conversationId)}/state`,
            );
            for (const r of state?.receipts || []) this.receipts.set(String(r.userId), { readAt: r.readAt, deliveredAt: r.deliveredAt });
            this.memberIds = (state?.receipts || []).map((r) => String(r.userId));
            this.recomputeStatuses();
        } catch {
            // Receipts are cosmetic: statuses from history stay as they are
        }
    }

    private async fetchPage(page: number, replace: boolean): Promise<void> {
        const raw = await this.chat.client.http.get<Message[]>(`/messages/${encodeURIComponent(this.conversationId)}`, { query: { page, limit: PAGE_SIZE } });
        const list = Array.isArray(raw) ? raw : [];
        const byId = new Map(this.store.value.items.map((m) => [m._id, m]));
        const revealed: ChatMessage[] = [];
        // In order: Megolm sessions ratchet forward, sequential decryption is cheapest
        for (const m of list) revealed.push(await this.chat.reveal(m, byId.get(String(m._id))));
        if (this.disposed) return;
        this.page = page;
        this.store.update((s) => {
            const merged = new Map<string, ChatMessage>();
            const base = replace ? s.items.filter((m) => m.local) : s.items;
            for (const m of [...revealed, ...base]) if (!merged.has(m._id)) merged.set(m._id, m);
            const items = [...merged.values()].sort(byCreated);
            return { ...s, items, loading: false, loadingOlder: false, hasOlder: list.length >= PAGE_SIZE, error: null };
        });
        if (this.visible) this.markRead();
    }

    /** Load the previous page of history */
    async loadOlder(): Promise<void> {
        const s = this.store.value;
        if (s.loadingOlder || !s.hasOlder || s.loading) return;
        this.store.update((x) => ({ ...x, loadingOlder: true }));
        try {
            await this.fetchPage(this.page + 1, false);
        } catch (e) {
            this.store.update((x) => ({ ...x, loadingOlder: false, error: e as Error }));
        }
    }

    /** @internal After a reconnect: fetch the newest page again (dedupes with what's loaded). */
    async catchUp(): Promise<void> {
        if (this.disposed || !this.loaded) return;
        try {
            const keepPage = this.page;
            await this.fetchPage(1, false);
            this.page = Math.max(keepPage, 1);
        } catch {
            // next reconnect retries
        }
    }

    /** @internal */
    resetAfterClear(): void {
        this.store.update((s) => ({ ...s, items: [], hasOlder: false }));
    }

    // ------------------------------------------------------------------ incoming

    /** @internal */
    async onIncoming(m: Message): Promise<void> {
        const id = String(m._id);
        if (this.store.value.items.some((x) => x._id === id && !x.local)) return;
        const revealed = await this.chat.reveal(m);
        if (this.disposed) return;
        // My own echo: replace the optimistic copy (matched by ciphertext)
        let localId: string | null = null;
        if (m.e2ee) for (const [lid, p] of this.pending) if (p.ciphertext === m.e2ee.ciphertext) localId = lid;
        if (localId) {
            clearTimeout(this.pending.get(localId)!.timer);
            this.pending.delete(localId);
        }
        this.store.update((s) => {
            if (s.items.some((x) => x._id === id)) return s;
            const items = s.items.filter((x) => x._id !== localId);
            const local = localId ? s.items.find((x) => x._id === localId) : undefined;
            if (local?.attachment?.url && revealed.attachment) revealed.attachment = { ...revealed.attachment, url: local.attachment.url, state: "ready" };
            items.push(revealed);
            items.sort(byCreated);
            return { ...s, items };
        });
        this.recomputeStatuses();
        if (String(m.userId) !== this.chat.myUserId) {
            this.onTyping(String(m.userId), false);
            if (this.visible) this.markRead();
        }
    }

    /** @internal */
    onRejected(reason: string, message?: string): void {
        // The oldest unconfirmed message in this conversation is the one refused
        const first = this.store.value.items.find((m) => m.local === "sending");
        if (!first) return;
        const p = this.pending.get(first._id);
        if (p) clearTimeout(p.timer);
        this.pending.delete(first._id);
        this.patchMessage(first._id, { local: "failed", failure: message || rejectionText(reason) });
    }

    /** @internal */
    async onUpdated(u: { messageId: string; e2ee?: EncryptedPayload; editedAt: string; mentions?: string[] }): Promise<void> {
        const current = this.store.value.items.find((m) => m._id === String(u.messageId));
        if (!current) return;
        const next = await this.chat.reveal({ ...current, e2ee: u.e2ee, editedAt: u.editedAt, mentions: u.mentions ?? current.mentions }, current);
        this.replace(next);
    }

    /** @internal */
    onDeleted(messageId: string): void {
        this.patchMessage(messageId, { isDeleted: true, text: "", attachment: undefined, e2ee: undefined });
    }

    /** @internal */
    onReactions(messageId: string, reactions: NonNullable<Message["reactions"]>): void {
        this.patchMessage(messageId, { reactions });
    }

    /** @internal */
    onTyping(userId: string, isTyping: boolean): void {
        if (userId === this.chat.myUserId) return;
        clearTimeout(this.typingTimers.get(userId));
        this.typingTimers.delete(userId);
        const set = new Set(this.typingStore.value);
        if (isTyping) {
            set.add(userId);
            // A lost stopTyping must not leave the indicator on
            this.typingTimers.set(userId, setTimeout(() => this.onTyping(userId, false), 6000));
        } else set.delete(userId);
        this.typingStore.set([...set]);
    }

    /** @internal */
    onReceipt(r: { userId: string; readAt?: string | null; deliveredAt?: string | null }): void {
        const prev = this.receipts.get(String(r.userId)) || { readAt: null, deliveredAt: null };
        this.receipts.set(String(r.userId), { readAt: r.readAt ?? prev.readAt, deliveredAt: r.deliveredAt ?? r.readAt ?? prev.deliveredAt });
        if (!this.memberIds.includes(String(r.userId))) this.memberIds.push(String(r.userId));
        this.recomputeStatuses();
    }

    /** @internal */
    onRemoved(): void {
        this.removedStore.set(true);
    }

    /** @internal Keys arrived: re-reveal messages that were waiting for one */
    async retryPending(): Promise<void> {
        const waiting = this.store.value.items.filter((m) => m.bodyState === "pending" || m.bodyState === "locked" || m.quote?.bodyState === "pending");
        for (const m of waiting) {
            const next = await this.chat.reveal(m, m);
            if (this.disposed) return;
            this.replace(next);
        }
    }

    private recomputeStatuses(): void {
        const me = this.chat.myUserId;
        const others = this.memberIds.filter((id) => id !== me);
        if (!others.length) return;
        this.store.update((s) => {
            let changed = false;
            const items = s.items.map((m) => {
                if (m.userId !== me || m.local || m.type === "system") return m;
                const t = Date.parse(m.createdAt);
                const all = (k: keyof Receipt) => others.every((o) => {
                    const v = this.receipts.get(o)?.[k];
                    return !!v && Date.parse(v) >= t;
                });
                const status: ChatMessage["status"] = all("readAt") ? "seen" : all("deliveredAt") ? "delivered" : m.status === "seen" || m.status === "delivered" ? m.status : "sent";
                if (status === m.status) return m;
                changed = true;
                return { ...m, status };
            });
            return changed ? { ...s, items } : s;
        });
    }

    private patchMessage(id: string, patch: Partial<ChatMessage>): void {
        this.store.update((s) => ({ ...s, items: s.items.map((m) => (m._id === id ? { ...m, ...patch } : m)) }));
    }

    private replace(next: ChatMessage): void {
        this.store.update((s) => ({ ...s, items: s.items.map((m) => (m._id === next._id ? next : m)) }));
    }

    // ------------------------------------------------------------------ actions

    /** Mark everything read (scope messages:read). Safe to call often. */
    markRead(): void {
        const rt = this.chat.client.realtime;
        if (!rt.connected) return;
        const last = this.store.value.items[this.store.value.items.length - 1];
        if (!last || this.lastMarked === last._id) return;
        this.lastMarked = last._id;
        rt.emit("markMessagesRead", this.conversationId);
        this.chat.markedRead(this.conversationId);
    }
    private lastMarked = "";

    /** Typing indicator: call on every keystroke (throttled), and `stopTyping()` when done. */
    typingStarted(): void {
        const rt = this.chat.client.realtime;
        if (!rt.connected) return;
        const now = Date.now();
        if (now - this.typingSent > 3000) {
            this.typingSent = now;
            rt.emit("typing", this.conversationId);
        }
        if (this.stopTypingTimer) clearTimeout(this.stopTypingTimer);
        this.stopTypingTimer = setTimeout(() => this.stopTyping(), 4000);
    }

    stopTyping(): void {
        if (this.stopTypingTimer) clearTimeout(this.stopTypingTimer);
        this.stopTypingTimer = null;
        if (!this.typingSent) return;
        this.typingSent = 0;
        if (this.chat.client.realtime.connected) this.chat.client.realtime.emit("stopTyping", this.conversationId);
    }

    private addLocal(partial: Partial<ChatMessage>): string {
        const id = `local-${Date.now().toString(36)}-${++this.localSeq}`;
        const me = this.chat.myUserId;
        const local: ChatMessage = {
            _id: id,
            conversationId: this.conversationId,
            userId: me,
            content: "",
            type: "text",
            createdAt: new Date().toISOString(),
            text: "",
            bodyState: "ok",
            local: "sending",
            ...partial,
        };
        this.store.update((s) => ({ ...s, items: [...s.items, local] }));
        return id;
    }

    private track(localId: string, ciphertext: string): void {
        const timer = setTimeout(() => {
            this.pending.delete(localId);
            this.patchMessage(localId, { local: "failed", failure: "Not confirmed by the server. Check the connection and try again." });
        }, CONFIRM_TIMEOUT_MS);
        this.pending.set(localId, { ciphertext, timer });
    }

    /**
     * Send a text message. It's encrypted on this device for the conversation's current members;
     * shown immediately as "sending" and confirmed when the server echoes it. Throws when it can't
     * be encrypted (nothing is sent in plaintext).
     */
    async send(text: string, options: SendOptions = {}): Promise<void> {
        const body = text.trim();
        if (!body) return;
        this.stopTyping();
        const quote = options.replyTo ? this.store.value.items.find((m) => m._id === options.replyTo) : undefined;
        const localId = this.addLocal({ text: body, replyTo: null, quote: quote ? { messageId: quote._id, authorId: quote.userId, text: quote.text, bodyState: quote.bodyState } : undefined, mentions: options.mentions });
        try {
            const payload = await this.chat.sendEncrypted(this.conversationId, { text: body }, { type: "text", replyTo: options.replyTo, mentions: options.mentions });
            this.track(localId, payload.ciphertext);
        } catch (e) {
            this.patchMessage(localId, { local: "failed", failure: e instanceof Error ? e.message : "Couldn't send." });
            throw e;
        }
    }

    /**
     * Send a file: encrypted on this device (AES-256-GCM), only the ciphertext is uploaded
     * (POST /upload, scope files:write), then the key travels inside the encrypted message.
     */
    async sendFile(file: File | (Blob & { name?: string }), options: SendOptions & { caption?: string; onProgress?: (fraction: number) => void } = {}): Promise<void> {
        const invalid = validateUpload(file);
        if (invalid) {
            throw new SpreeWeError({
                code: "INVALID_ARGUMENT",
                message: invalid.code === "type" ? "This file type isn't supported." : invalid.code === "empty" ? "The file is empty." : `The file is too large (max ${invalid.maxMb} MB).`,
                details: invalid,
            });
        }
        const e2ee = this.chat.e2ee;
        if (!e2ee) throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: "Sending needs an encryption device (@spreewe/e2ee)." });
        const kind = mediaKind(file.type);
        const preview = kind === "image" || kind === "video" || kind === "audio" ? URL.createObjectURL(file) : undefined;
        if (preview) this.objectUrls.add(preview);
        const localId = this.addLocal({
            type: kind,
            text: options.caption?.trim() || "",
            attachment: { name: file.name || "file", size: file.size, mimeType: file.type, kind, url: preview, state: preview ? "ready" : "idle" },
        });
        try {
            await e2ee.start();
            const { ciphertext, info } = await e2ee.encryptFile(file);
            const form = new FormData();
            form.append("purpose", "message");
            form.append("conversationId", this.conversationId);
            form.append("encrypted", "1");
            form.append("kind", kind);
            form.append("file", ciphertext, "encrypted.bin");
            const uploaded = await this.chat.client.http.post<{ storageKey: string; type: string }>("/upload", undefined, { form, onUploadProgress: options.onProgress, timeoutMs: 0 });
            const payload = await this.chat.sendEncrypted(
                this.conversationId,
                { text: options.caption?.trim() || "", file: { ...info, storageKey: uploaded.storageKey } },
                { type: uploaded.type || kind, storageKey: uploaded.storageKey, replyTo: options.replyTo, mentions: options.mentions },
            );
            this.track(localId, payload.ciphertext);
        } catch (e) {
            this.patchMessage(localId, { local: "failed", failure: e instanceof Error ? e.message : "Couldn't send the file." });
            throw e;
        }
    }

    /** Remove a failed local message */
    discard(localId: string): void {
        this.store.update((s) => ({ ...s, items: s.items.filter((m) => m._id !== localId) }));
    }

    /** Edit my own message (re-encrypted; scope messages:edit). */
    async edit(messageId: string, text: string, mentions?: string[]): Promise<void> {
        const e2ee = this.chat.e2ee;
        if (!e2ee) throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: "Editing needs an encryption device (@spreewe/e2ee)." });
        const current = this.store.value.items.find((m) => m._id === messageId);
        const payload = await e2ee.encrypt(this.conversationId, { text: text.trim(), ...(current?.attachment?.secure ? { file: current.attachment.secure } : {}) });
        await this.chat.client.realtime.request("message:edit", { messageId, e2ee: payload, ...(mentions ? { mentions } : {}) });
    }

    /** Delete my own message for everyone (DELETE /messages/:id, scope messages:delete). */
    async delete(messageId: string): Promise<void> {
        await this.chat.client.http.delete(`/messages/${encodeURIComponent(messageId)}`);
        this.onDeleted(messageId);
    }

    /** Toggle a reaction (scope messages:react). */
    react(messageId: string, emoji: string): void {
        this.chat.client.realtime.emit("reactToMessage", { conversationId: this.conversationId, messageId, emoji });
    }

    /** Pin or unpin (scope messages:react). */
    async pin(messageId: string, pinned = true): Promise<void> {
        await this.chat.client.realtime.request("message:pin", { messageId, pinned });
    }

    /** Save ("star") for me (scope messages:react). */
    async save(messageId: string, saved = true): Promise<void> {
        await this.chat.client.http.put(`/messages/${encodeURIComponent(messageId)}/save`, { saved });
        this.patchMessage(messageId, { saved });
    }

    /**
     * Download and decrypt an attachment into an object URL (kept until the session closes).
     * Images are loaded by the message list automatically; other files on demand.
     */
    async loadAttachment(messageId: string): Promise<AttachmentView | undefined> {
        const m = this.store.value.items.find((x) => x._id === messageId);
        const a = m?.attachment;
        if (!a || a.state === "ready" || a.state === "loading") return a;
        if (!a.secure) return a;
        const e2ee = this.chat.e2ee;
        if (!e2ee) return a;
        this.patchMessage(messageId, { attachment: { ...a, state: "loading" } });
        try {
            const blob = await e2ee.decryptFile(await this.downloadCiphertext(messageId), a.secure);
            const url = URL.createObjectURL(blob);
            this.objectUrls.add(url);
            const next: AttachmentView = { ...a, url, state: "ready", error: undefined };
            this.patchMessage(messageId, { attachment: next });
            return next;
        } catch {
            const next: AttachmentView = { ...a, state: "error", error: "This attachment couldn't be downloaded or decrypted." };
            this.patchMessage(messageId, { attachment: next });
            return next;
        }
    }

    /**
     * Attachments always come through the SpreeWe API (GET /v1/messages/:id/attachment), never straight
     * from the storage bucket, so the bucket can stay closed to every browser origin.
     */
    private downloadCiphertext(messageId: string): Promise<ArrayBuffer> {
        return this.chat.client.http.binary(`/v1/messages/${encodeURIComponent(messageId)}/attachment`, { timeoutMs: 120_000 });
    }

    /** People in this conversation (from the conversation list), for mentions and receipts */
    get members(): UserSummary[] {
        const c = this.chat.findConversation(this.conversationId);
        if (!c) return [];
        return c.isGroup ? c.members || [] : [c.peer].filter(Boolean) as UserSummary[];
    }

    /** @internal */
    dispose(): void {
        this.disposed = true;
        this.stopTyping();
        this.leaveRoom?.();
        for (const t of this.typingTimers.values()) clearTimeout(t);
        for (const p of this.pending.values()) clearTimeout(p.timer);
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.objectUrls.clear();
    }
}

function byCreated(a: ChatMessage, b: ChatMessage): number {
    return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
}

function rejectionText(reason: string): string {
    switch (reason) {
        case "policy":
            return "Your workspace doesn't allow this message.";
        case "blocked":
            return "You can't message this person.";
        case "attachment":
            return "The attachment couldn't be used.";
        case "unencrypted":
            return "The message wasn't encrypted correctly.";
        case "e2ee":
            return "This app's encryption device isn't active.";
        case "quota":
            return "This app's daily message limit is used up.";
        default:
            return "The message was refused.";
    }
}

import {
    SpreeWeError,
    isSpreeWeError,
    Store,
    getE2ee,
    type E2eeEngine,
    type EncryptedPayload,
    type ReadableStore,
    type SpreeWeClient,
    type Unsubscribe,
} from "@spreewe/core";
import { FILE_KINDS, type FileCollectionState, type FileItem, type FileKind, type RawLibraryFile, type RawSharedMedia } from "./types.js";

const FILES_SERVICE = Symbol.for("spreewe.files");
/** GET /files: server default 30, maximum 50 (SearchService.files) */
const PAGE_SIZE = 30;
/** Decrypted image previews kept as object URLs (oldest revoked first) */
const PREVIEW_CACHE = 120;
/** Images are at most 10 MB (file.service MEDIA_RULES); bigger ciphertext isn't previewed */
const PREVIEW_MAX_BYTES = 12 * 1024 * 1024;
const LIVE_REFRESH_MS = 1500;
const PREVIEW_CONCURRENCY = 3;

/** The client's files service (created on first use). */
export function getFiles(client: SpreeWeClient): FilesService {
    return client.service(FILES_SERVICE, (c) => new FilesService(c));
}

export type LibraryKind = FileKind | "all";

/**
 * Headless files: the files shared in the user's chats (GET /files, paged, filterable by kind) and
 * one conversation's shared media (GET /conversations/:id/media).
 *
 * Chat attachments are end-to-end encrypted: the server stores ciphertext and the file's name, type
 * and key travel inside the encrypted message. With an encryption device (@spreewe/e2ee, scope
 * e2ee:device) this service decrypts the message to name the file, and `download()` decrypts the
 * file itself on this device. Without one, encrypted items are listed honestly as encrypted
 * (state "locked" / "withheld") and can't be opened. Older plaintext attachments use their signed links.
 *
 * Scopes: files:read (lists and downloads), e2ee:device (decrypting). Uploading belongs to
 * @spreewe/chat (`session.sendFile()`), which encrypts before upload.
 */
export class FilesService {
    readonly client: SpreeWeClient;
    private readonly libraries = new Map<LibraryKind, FileCollection>();
    private readonly conversations = new Map<string, FileCollection>();
    /** Message id → ciphertext (null: the server withheld it) */
    private readonly payloads = new Map<string, EncryptedPayload | null>();
    /** Conversations whose media list was read to find ciphertext for GET /files items */
    private readonly lookedUp = new Set<string>();
    private readonly mediaLoads = new Map<string, Promise<RawSharedMedia[]>>();
    /** Final decryption results per message id */
    private readonly resolved = new Map<string, Partial<FileItem>>();
    private readonly previews = new Map<string, string>();
    private readonly previewLoads = new Map<string, Promise<string | null>>();
    private readonly downloadUrls = new Set<string>();
    private readonly offs: Unsubscribe[] = [];
    private e2eeWired: E2eeEngine | null = null;
    private ciphertextAllowed: Promise<boolean> | null = null;
    private wired = false;
    private destroyed = false;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    get e2ee(): E2eeEngine | null {
        return getE2ee(this.client);
    }

    /** Files shared in the user's chats, newest first; `kind` narrows to one media type. */
    library(kind: LibraryKind = "all"): FileCollection {
        const k: LibraryKind = kind === "all" || (FILE_KINDS as readonly string[]).includes(kind) ? kind : "all";
        let c = this.libraries.get(k);
        if (!c) {
            c = new FileCollection(this, { source: "library", kind: k });
            this.libraries.set(k, c);
        }
        this.wire();
        return c;
    }

    /** A conversation's shared media and files, newest first (the server returns the latest 300). */
    conversation(conversationId: string): FileCollection {
        const id = String(conversationId);
        if (!id) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "conversationId is required" });
        let c = this.conversations.get(id);
        if (!c) {
            c = new FileCollection(this, { source: "conversation", conversationId: id });
            this.conversations.set(id, c);
        }
        this.wire();
        return c;
    }

    /**
     * The file's bytes: plaintext attachments as stored, encrypted ones downloaded and decrypted on
     * this device (integrity-checked against the SHA-256 inside the message). Throws SpreeWeError
     * E2EE_UNAVAILABLE when the item can't be decrypted here, MEDIA_ERROR when the download fails.
     */
    async download(item: FileItem, options: { signal?: AbortSignal } = {}): Promise<Blob> {
        if (item.encrypted) {
            const current = this.latest(item);
            const e2ee = this.e2ee;
            if (current.state !== "ok" || !current.secure || !e2ee) {
                throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: current.reason || "This file is end-to-end encrypted and can't be opened on this device.", details: { state: current.state } });
            }
            const bytes = await this.fetchFile(current, options.signal);
            try {
                return await e2ee.decryptFile(await bytes.arrayBuffer(), current.secure);
            } catch (cause) {
                throw new SpreeWeError({ code: "E2EE_FAILED", message: cause instanceof Error && cause.message ? cause.message : "This file couldn't be decrypted.", cause });
            }
        }
        const blob = await this.fetchFile(item, options.signal);
        return item.mimeType && !blob.type ? new Blob([blob], { type: item.mimeType }) : blob;
    }

    /** Download (and decrypt) the file and hand it to the browser as a file download. */
    async save(item: FileItem, filename?: string): Promise<void> {
        if (typeof document === "undefined") throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "save() needs a browser; use download() to get the bytes." });
        const blob = await this.download(item);
        const url = URL.createObjectURL(blob);
        this.downloadUrls.add(url);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || this.latest(item).name || fallbackName(item);
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Give the browser time to start the download before the URL is released
        setTimeout(() => {
            URL.revokeObjectURL(url);
            this.downloadUrls.delete(url);
        }, 60_000);
    }

    /**
     * An image URL for thumbnails: the signed link for plaintext images, a decrypted object URL for
     * encrypted ones (cached; revoked by `releasePreviews()` / `destroy()` or when the cache is full).
     * Null for non-images and items that can't be decrypted here.
     */
    preview(item: FileItem): Promise<string | null> {
        const current = this.latest(item);
        if (!isImage(current)) return Promise.resolve(null);
        if (!current.encrypted) return Promise.resolve(this.client.mediaUrl(current.thumbnailUrl || current.url || "") || null);
        if (current.state !== "ok" || !current.secure) return Promise.resolve(null);
        if (current.size && current.size > PREVIEW_MAX_BYTES) return Promise.resolve(null);
        const cached = this.previews.get(current.id);
        if (cached) {
            // Most recently used last
            this.previews.delete(current.id);
            this.previews.set(current.id, cached);
            return Promise.resolve(cached);
        }
        let load = this.previewLoads.get(current.id);
        if (!load) {
            load = this.queued(() => this.download(current))
                .then((blob) => {
                    if (this.destroyed) return null;
                    const url = URL.createObjectURL(blob);
                    this.previews.set(current.id, url);
                    while (this.previews.size > PREVIEW_CACHE) {
                        const [oldId, oldUrl] = this.previews.entries().next().value as [string, string];
                        URL.revokeObjectURL(oldUrl);
                        this.previews.delete(oldId);
                    }
                    return url;
                })
                .catch(() => null)
                .finally(() => this.previewLoads.delete(current.id));
            this.previewLoads.set(current.id, load);
        }
        return load;
    }

    private active = 0;
    private readonly waiting: (() => void)[] = [];

    /** At most PREVIEW_CONCURRENCY preview downloads at once */
    private async queued<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= PREVIEW_CONCURRENCY) await new Promise<void>((r) => this.waiting.push(r));
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }

    /** Revoke every decrypted preview URL (images showing them keep their pixels). */
    releasePreviews(): void {
        for (const url of this.previews.values()) URL.revokeObjectURL(url);
        this.previews.clear();
    }

    /** The newest copy of an item in any loaded collection (states change as keys arrive). */
    latest(item: FileItem): FileItem {
        for (const c of [...this.libraries.values(), ...this.conversations.values()]) {
            const hit = c.state.value.items.find((x) => x.id === item.id);
            if (hit && hit.state === "ok") return hit;
        }
        return item;
    }

    // ------------------------------------------------------------------ internals

    /** @internal Raw media of one conversation (deduplicated while in flight). */
    fetchConversationMedia(conversationId: string, fresh = false): Promise<RawSharedMedia[]> {
        let load = fresh ? undefined : this.mediaLoads.get(conversationId);
        if (!load) {
            load = this.client.http.get<RawSharedMedia[]>(`/conversations/${encodeURIComponent(conversationId)}/media`).then((list) => {
                const items = Array.isArray(list) ? list : [];
                for (const m of items) {
                    if (m?.encrypted) this.payloads.set(String(m._id), m.e2ee || null);
                }
                this.lookedUp.add(conversationId);
                return items;
            });
            this.mediaLoads.set(conversationId, load);
            load.catch(() => this.mediaLoads.delete(conversationId));
        }
        return load;
    }

    /** @internal Forget cached media lists (refresh) */
    invalidate(conversationId?: string): void {
        if (conversationId) {
            this.mediaLoads.delete(conversationId);
            this.lookedUp.delete(conversationId);
        } else {
            this.mediaLoads.clear();
            this.lookedUp.clear();
        }
    }

    /** @internal First view of an item, before decryption */
    describe(raw: RawLibraryFile | RawSharedMedia, conversationTitle?: string): FileItem {
        const id = String(raw._id);
        const sender = "user" in raw && raw.user ? { _id: String(raw.user._id), username: raw.user.username, avatar: raw.user.avatar } : undefined;
        const senderId = sender?._id || String((raw as RawSharedMedia).userId || "");
        const kind: FileKind = (FILE_KINDS as readonly string[]).includes(raw.type) ? raw.type : "file";
        // Ciphertext of media-list items was recorded by fetchConversationMedia()
        const encrypted = !!raw.encrypted;
        const base: FileItem = {
            id,
            conversationId: String(raw.conversationId),
            conversationTitle: (raw as RawLibraryFile).conversationTitle ?? conversationTitle,
            kind,
            createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : "",
            senderId,
            sender,
            encrypted,
            state: encrypted ? "pending" : "ok",
            name: encrypted ? "" : raw.fileName || "",
            mimeType: encrypted ? "" : raw.mimeType || "",
            size: raw.fileSize,
            url: raw.fileUrl || undefined,
            downloadUrl: raw.downloadUrl || raw.fileUrl || undefined,
            thumbnailUrl: raw.thumbnailUrl || undefined,
        };
        const done = this.resolved.get(id);
        return done ? { ...base, ...done } : base;
    }

    /** @internal Work out what an encrypted item is (name, type, key). Never throws. */
    async resolve(item: FileItem): Promise<FileItem> {
        if (!item.encrypted) return item;
        const done = this.resolved.get(item.id);
        if (done) return { ...item, ...done };
        try {
            const e2ee = this.e2ee;
            if (!(await this.mayReadCiphertext())) {
                return { ...item, state: "withheld", reason: "This file is end-to-end encrypted. This app isn't allowed to decrypt it (e2ee:device)." };
            }
            if (!e2ee) return { ...item, state: "locked", reason: "This file is end-to-end encrypted. Enable encryption on this device (@spreewe/e2ee) to open it." };
            this.wireE2ee();
            if (!this.payloads.has(item.id) && !this.lookedUp.has(item.conversationId)) {
                // GET /files doesn't include the message ciphertext: read it from the conversation's media list
                await this.fetchConversationMedia(item.conversationId);
            }
            if (!this.payloads.has(item.id)) {
                return { ...item, state: "unavailable", reason: "This file's encrypted message wasn't found (only a conversation's latest 300 media items are available)." };
            }
            const payload = this.payloads.get(item.id);
            if (!payload) return { ...item, state: "withheld", reason: "This file is end-to-end encrypted and its key isn't shared with this app." };
            if (e2ee.status.value === "idle") await e2ee.start().catch(() => undefined);
            if (e2ee.status.value !== "ready") {
                return { ...item, state: "locked", reason: e2ee.statusMessage || "Encryption isn't ready on this device." };
            }
            const d = await e2ee.decrypt({ _id: item.id, conversationId: item.conversationId, e2ee: payload, userId: item.senderId, createdAt: item.createdAt });
            if (d.state === "pending") return { ...item, state: "pending", reason: "Waiting for this file's key…" };
            if (d.state === "failed") return this.finish(item, { state: "failed", reason: d.warning || "This file can't be decrypted on this device." });
            const f = d.content?.file;
            if (!f) return this.finish(item, { state: "failed", reason: "The message has no file key." });
            return this.finish(item, {
                state: "ok",
                reason: undefined,
                name: f.name || "",
                mimeType: f.mimeType || "",
                size: f.size || item.size,
                caption: d.content?.text || undefined,
                secure: f,
            });
        } catch (e) {
            // e.g. the media list couldn't be read; refresh() tries again
            return { ...item, state: "unavailable", reason: e instanceof Error && e.message ? e.message : "Couldn't read this file's details." };
        }
    }

    private finish(item: FileItem, patch: Partial<FileItem>): FileItem {
        this.resolved.set(item.id, patch);
        return { ...item, ...patch };
    }

    private mayReadCiphertext(): Promise<boolean> {
        this.ciphertextAllowed ||= this.client.hasScopes("e2ee:device").catch(() => false);
        return this.ciphertextAllowed;
    }

    /** Through the SpreeWe API (GET /v1/messages/:id/attachment), never straight from the storage bucket. */
    private async fetchFile(item: FileItem, signal?: AbortSignal): Promise<Blob> {
        try {
            const bytes = await this.client.http.binary(`/v1/messages/${encodeURIComponent(item.id)}/attachment`, { signal, timeoutMs: 120_000 });
            return new Blob([bytes], item.mimeType && !item.secure ? { type: item.mimeType } : {});
        } catch (cause) {
            if (isSpreeWeError(cause) && ["ABORTED", "NETWORK_ERROR", "TIMEOUT"].includes(cause.code)) throw cause;
            const status = isSpreeWeError(cause) ? cause.status : undefined;
            throw new SpreeWeError({ code: "MEDIA_ERROR", message: status ? `Couldn't download the file (${status}).` : "Couldn't download the file.", status, cause });
        }
    }

    private allCollections(): FileCollection[] {
        return [...this.libraries.values(), ...this.conversations.values()];
    }

    /** Keys arrived or encryption became ready: retry items that were waiting */
    private retryWaiting(): void {
        for (const c of this.allCollections()) void c.reresolve((x) => x.state === "pending" || x.state === "locked");
    }

    private wireE2ee(): void {
        const e2ee = this.e2ee;
        if (!e2ee || this.e2eeWired === e2ee) return;
        this.e2eeWired = e2ee;
        let first = true;
        this.offs.push(
            e2ee.onKeysChanged(() => this.retryWaiting()),
            e2ee.status.subscribe((s) => {
                // The first call reports the current status (the caller is already resolving)
                if (s === "ready" && !first) this.retryWaiting();
                first = false;
            }),
        );
    }

    /**
     * New or deleted attachments while the socket is connected (by chat or another module; this
     * service never connects it): loaded lists refresh. Events need messages:read on app tokens.
     */
    private wire(): void {
        if (this.wired) return;
        this.wired = true;
        const rt = this.client.realtime;
        this.offs.push(
            rt.on<{ _id?: string; conversationId?: string; type?: string; fileUrl?: string; e2ee?: unknown; encrypted?: boolean }>("receiveMessage", (m) => {
                if (!m?.conversationId || !(FILE_KINDS as readonly string[]).includes(String(m.type))) return;
                const id = String(m.conversationId);
                this.invalidate(id);
                this.conversations.get(id)?.scheduleRefresh(LIVE_REFRESH_MS);
                for (const c of this.libraries.values()) c.scheduleRefresh(LIVE_REFRESH_MS);
            }),
            rt.on<{ conversationId?: string; messageId?: string }>("message:deleted", (d) => {
                if (!d?.messageId) return;
                for (const c of this.allCollections()) c.removeItem(String(d.messageId));
            }),
        );
    }

    /** Release listeners, cached data and every object URL this service created. */
    destroy(): void {
        this.destroyed = true;
        this.offs.splice(0).forEach((off) => off());
        for (const c of this.allCollections()) c.dispose();
        this.releasePreviews();
        for (const url of this.downloadUrls) URL.revokeObjectURL(url);
        this.downloadUrls.clear();
        this.libraries.clear();
        this.conversations.clear();
    }
}

type CollectionSource = { source: "library"; kind: LibraryKind } | { source: "conversation"; conversationId: string };

/** A list of files with its loading state. Obtain from `getFiles(client).library()` / `.conversation(id)`. */
export class FileCollection {
    readonly source: CollectionSource;
    private readonly service: FilesService;
    private readonly store = new Store<FileCollectionState>({ items: [], loading: false, loadingMore: false, loaded: false, hasMore: false, error: null });
    private cursor: string | null = null;
    private loadToken: object | null = null;
    private loading: Promise<void> | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(service: FilesService, source: CollectionSource) {
        this.service = service;
        this.source = source;
    }

    get state(): ReadableStore<FileCollectionState> {
        return this.store;
    }

    /** First page. Concurrent calls share one request unless `refresh`. */
    load(options: { refresh?: boolean } = {}): Promise<void> {
        if (this.loading && !options.refresh) return this.loading;
        if (this.store.value.loaded && !options.refresh) return Promise.resolve();
        const token = {};
        this.loadToken = token;
        const current = () => this.loadToken === token && !this.disposed;
        this.store.update((s) => ({ ...s, loading: true, error: null }));
        const run = (async () => {
            try {
                if (options.refresh) this.service.invalidate(this.source.source === "conversation" ? this.source.conversationId : undefined);
                const page = await this.fetchPage(null);
                if (!current()) return;
                this.cursor = page.nextCursor;
                this.store.update((s) => ({ ...s, items: page.items, loading: false, loaded: true, hasMore: !!page.nextCursor, error: null }));
                void this.reresolve((x) => x.encrypted && x.state === "pending");
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

    /** Reload from the server */
    refresh(): Promise<void> {
        return this.load({ refresh: true });
    }

    /** The next (older) page (GET /files only; a conversation's media arrives in one response) */
    async loadMore(): Promise<void> {
        const s = this.store.value;
        if (!s.loaded || s.loading || s.loadingMore || !s.hasMore || !this.cursor) return;
        this.store.update((x) => ({ ...x, loadingMore: true, error: null }));
        try {
            const page = await this.fetchPage(this.cursor);
            if (this.disposed) return;
            this.cursor = page.nextCursor;
            this.store.update((x) => {
                const have = new Set(x.items.map((i) => i.id));
                return { ...x, items: [...x.items, ...page.items.filter((i) => !have.has(i.id))], loadingMore: false, hasMore: !!page.nextCursor };
            });
            void this.reresolve((x) => x.encrypted && x.state === "pending");
        } catch (e) {
            this.store.update((x) => ({ ...x, loadingMore: false, error: e as Error }));
            throw e;
        }
    }

    /** @internal Re-run decryption for matching items and patch them in place */
    async reresolve(match: (item: FileItem) => boolean): Promise<void> {
        const targets = this.store.value.items.filter(match);
        // One conversation at a time keeps the media-list lookups to one request per conversation
        for (const item of targets) {
            if (this.disposed) return;
            const next = await this.service.resolve(item);
            if (next !== item) this.patchItem(item.id, (x) => (x.state === "ok" && next.state !== "ok" ? x : { ...x, ...next }));
        }
    }

    /** @internal */
    patchItem(id: string, fn: (item: FileItem) => FileItem): void {
        const s = this.store.value;
        let changed = false;
        const items = s.items.map((x) => {
            if (x.id !== id) return x;
            const next = fn(x);
            if (next !== x) changed = true;
            return next;
        });
        if (changed) this.store.set({ ...s, items });
    }

    /** @internal */
    removeItem(id: string): void {
        const s = this.store.value;
        if (s.items.some((x) => x.id === id)) this.store.set({ ...s, items: s.items.filter((x) => x.id !== id) });
    }

    /** @internal Debounced refresh of a loaded collection (live events) */
    scheduleRefresh(ms: number): void {
        if (!this.store.value.loaded || this.refreshTimer || this.disposed) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.catchUp().catch(() => undefined);
        }, ms);
    }

    /** Newest page again, merged with what's loaded (older pages kept) */
    private async catchUp(): Promise<void> {
        const page = await this.fetchPage(null);
        if (this.disposed) return;
        const s = this.store.value;
        const fresh = new Set(page.items.map((i) => i.id));
        const oldest = page.items.length ? Date.parse(page.items[page.items.length - 1].createdAt) || 0 : Infinity;
        const older = page.nextCursor ? s.items.filter((i) => !fresh.has(i.id) && (Date.parse(i.createdAt) || 0) < oldest) : [];
        if (!older.length) this.cursor = page.nextCursor;
        // Keep already decrypted copies
        const known = new Map(s.items.map((i) => [i.id, i]));
        const items = page.items.map((i) => (known.get(i.id)?.state === "ok" ? { ...i, ...pickResolved(known.get(i.id)!) } : i));
        this.store.set({ ...s, items: [...items, ...older], hasMore: older.length ? s.hasMore : !!page.nextCursor, error: null });
        void this.reresolve((x) => x.encrypted && x.state === "pending");
    }

    private async fetchPage(before: string | null): Promise<{ items: FileItem[]; nextCursor: string | null }> {
        const http = this.service.client.http;
        if (this.source.source === "library") {
            const res = await http.get<{ items?: RawLibraryFile[]; nextCursor?: string | null }>("/files", {
                query: { type: this.source.kind === "all" ? undefined : this.source.kind, before: before || undefined, limit: PAGE_SIZE },
            });
            return { items: (res?.items || []).map((r) => this.service.describe(r)), nextCursor: res?.nextCursor || null };
        }
        const list = await this.service.fetchConversationMedia(this.source.conversationId, true);
        return { items: list.map((r) => this.service.describe(r)), nextCursor: null };
    }

    /** @internal */
    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
    }
}

function pickResolved(i: FileItem): Partial<FileItem> {
    return { state: i.state, reason: i.reason, name: i.name, mimeType: i.mimeType, size: i.size, caption: i.caption, secure: i.secure };
}

function isImage(i: FileItem): boolean {
    return i.kind === "image" || (!!i.mimeType && /^image\//.test(i.mimeType));
}

/** Name for an item whose real name isn't known */
export function fallbackName(item: Pick<FileItem, "kind" | "createdAt">): string {
    const day = (item.createdAt || "").slice(0, 10);
    const ext = item.kind === "pdf" ? ".pdf" : "";
    return `${item.kind}${day ? `-${day}` : ""}${ext}`;
}

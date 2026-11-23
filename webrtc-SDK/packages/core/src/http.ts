import { SpreeWeError, errorFromResponse } from "./errors.js";
import type { TokenProvider } from "./auth/types.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
    query?: Record<string, QueryValue | QueryValue[]>;
    /** JSON body */
    body?: unknown;
    /** Multipart body (uploads). Content-Type is set by the browser. */
    form?: FormData;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Override the client's default timeout (ms); 0 disables it */
    timeoutMs?: number;
    /** Send without Authorization (public endpoints such as /config) */
    anonymous?: boolean;
    /** Upload progress 0..1 (uses XMLHttpRequest when available) */
    onUploadProgress?: (fraction: number) => void;
}

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

export interface HttpClientOptions {
    baseUrl: string;
    auth: TokenProvider;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

/**
 * REST client for the SpreeWe backend. It:
 * - sends `Authorization: Bearer <token>` from the TokenProvider (fresh per request);
 * - retries once with a force-refreshed token after a 401;
 * - retries once after a 429 when Retry-After is ≤ 10 s (a rate-limited request was not processed, so
 *   this is safe for every method). Developer apps share ONE request budget across all their users
 *   (quotas.rateLimitPerMinute, default 60/min); see docs/production.md;
 * - unwraps both response envelopes ({ data } on /v1, { status|success, data, message } on session routes);
 * - throws SpreeWeError for every failure (network, timeout, HTTP status, server error body).
 */
export class HttpClient {
    readonly baseUrl: string;
    private readonly auth: TokenProvider;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;

    constructor(options: HttpClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.auth = options.auth;
        const f = options.fetch || (globalThis.fetch as typeof fetch | undefined);
        if (!f) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "No fetch implementation available" });
        this.fetchImpl = f.bind(globalThis);
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    url(path: string, query?: RequestOptions["query"]): string {
        const u = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        if (!query) return u;
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            for (const item of Array.isArray(v) ? v : [v]) if (item !== undefined && item !== null && item !== "") q.append(k, String(item));
        }
        const s = q.toString();
        return s ? `${u}?${s}` : u;
    }

    get<T>(path: string, options?: RequestOptions): Promise<T> {
        return this.request<T>("GET", path, options);
    }
    post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
        return this.request<T>("POST", path, { ...options, body });
    }
    put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
        return this.request<T>("PUT", path, { ...options, body });
    }
    patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
        return this.request<T>("PATCH", path, { ...options, body });
    }
    delete<T>(path: string, options?: RequestOptions): Promise<T> {
        return this.request<T>("DELETE", path, options);
    }

    /** A cursor page from a paginated /v1 route ({ data: [...], page: { nextCursor } }). */
    async page<T>(path: string, options?: RequestOptions): Promise<Page<T>> {
        const raw = await this.raw("GET", path, options);
        const body = raw as { data?: T[]; page?: { nextCursor?: string | null } };
        return { items: Array.isArray(body?.data) ? body.data : [], nextCursor: body?.page?.nextCursor ?? null };
    }

    /** Request and unwrap the `data` envelope (bodies without one are returned as they are). */
    async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
        const body = await this.raw(method, path, options);
        if (body && typeof body === "object" && "data" in (body as object)) return (body as { data: T }).data;
        return body as T;
    }

    /** GET binary content (e.g. an encrypted attachment) with the same auth and retry rules. */
    async binary(path: string, options: Omit<RequestOptions, "body" | "form"> = {}): Promise<ArrayBuffer> {
        let retriedAuth = false;
        for (;;) {
            const token = options.anonymous ? null : await this.auth.getToken({ forceRefresh: retriedAuth });
            const res = (await this.send("GET", path, { ...options, headers: { ...options.headers, Accept: "application/octet-stream" } }, token)) as ResponseLike & { arrayBuffer(): Promise<ArrayBuffer> };
            if (res.status === 401 && !options.anonymous && !retriedAuth) {
                retriedAuth = true;
                continue;
            }
            if (!res.ok) {
                const text = await res.text();
                throw errorFromResponse(res.status, text ? safeJson(text) : null, parseRetryAfter(res.headers.get("Retry-After")));
            }
            return res.arrayBuffer();
        }
    }

    /** Request without unwrapping. */
    async raw(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<unknown> {
        let retriedAuth = false;
        let retriedRate = false;
        for (;;) {
            const token = options.anonymous ? null : await this.auth.getToken({ forceRefresh: retriedAuth });
            const res = await this.send(method, path, options, token);
            if (res.status === 401 && !options.anonymous && !retriedAuth) {
                retriedAuth = true;
                continue;
            }
            const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
            if (res.status === 429 && !retriedRate && retryAfterMs !== undefined && retryAfterMs <= 10_000) {
                retriedRate = true;
                await sleep(retryAfterMs, options.signal);
                continue;
            }
            const text = res.status === 204 ? "" : await res.text();
            const parsed = text ? safeJson(text) : null;
            if (!res.ok) throw errorFromResponse(res.status, parsed, retryAfterMs);
            // Some session routes answer 200 with { status: false } for refusals
            if (parsed && typeof parsed === "object" && ((parsed as any).status === false || (parsed as any).success === false)) {
                throw errorFromResponse(res.status === 200 ? 400 : res.status, parsed);
            }
            return parsed;
        }
    }

    private async send(method: HttpMethod, path: string, options: RequestOptions, token: string | null): Promise<ResponseLike> {
        const url = this.url(path, options.query);
        const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
        if (token) headers.Authorization = `Bearer ${token}`;
        let payload: BodyInit | undefined;
        if (options.form) payload = options.form;
        else if (options.body !== undefined && method !== "GET") {
            headers["Content-Type"] = "application/json";
            payload = JSON.stringify(options.body);
        }
        const timeout = options.timeoutMs ?? this.timeoutMs;
        if (options.onUploadProgress && options.form && typeof XMLHttpRequest !== "undefined") {
            return xhrSend(method, url, headers, options.form, options.onUploadProgress, timeout, options.signal);
        }
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
        try {
            const res = await this.fetchImpl(url, { method, headers, body: payload, signal: controller.signal });
            return res;
        } catch (cause) {
            if (options.signal?.aborted) throw new SpreeWeError({ code: "ABORTED", message: "The request was cancelled.", cause });
            if (controller.signal.aborted) throw new SpreeWeError({ code: "TIMEOUT", message: "SpreeWe didn't answer in time.", cause });
            throw new SpreeWeError({ code: "NETWORK_ERROR", message: "Couldn't reach SpreeWe. Check the connection.", cause });
        } finally {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        }
    }
}

interface ResponseLike {
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}

function xhrSend(
    method: string,
    url: string,
    headers: Record<string, string>,
    form: FormData,
    onProgress: (f: number) => void,
    timeout: number,
    signal?: AbortSignal,
): Promise<ResponseLike> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        if (timeout > 0) xhr.timeout = timeout;
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total) onProgress(Math.min(1, e.loaded / e.total));
        };
        xhr.onload = () =>
            resolve({
                status: xhr.status,
                ok: xhr.status >= 200 && xhr.status < 300,
                headers: { get: (n) => xhr.getResponseHeader(n) },
                text: () => Promise.resolve(xhr.responseText),
            });
        xhr.onerror = () => reject(new SpreeWeError({ code: "NETWORK_ERROR", message: "Couldn't reach SpreeWe. Check the connection." }));
        xhr.ontimeout = () => reject(new SpreeWeError({ code: "TIMEOUT", message: "The upload took too long." }));
        xhr.onabort = () => reject(new SpreeWeError({ code: "ABORTED", message: "The upload was cancelled." }));
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(form);
    });
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 500) };
    }
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(t);
                reject(new SpreeWeError({ code: "ABORTED", message: "Cancelled." }));
            },
            { once: true },
        );
    });
}

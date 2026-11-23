import http from "http";
import https from "https";
import net from "net";
import { BlockedDestinationError, parseDestination, pinnedLookup } from "./ssrf";

/**
 * One HTTP POST to a webhook endpoint, through the SSRF-safe path:
 *   - destination re-validated (syntax / policy) on every send;
 *   - the connection's DNS lookup is pinnedLookup(): validated addresses only (no rebinding);
 *   - no redirects (3xx = failure), no proxy, no keep-alive reuse;
 *   - total timeout (WEBHOOK_TIMEOUT_MS, default 10 s), response body read ≤ 4 KB.
 * Returns a safe error category, never the response body or internal addresses.
 */
export interface SendResult {
    ok: boolean;
    statusCode: number | null;
    error: string | null;
    /** First bytes of the response (used only for the verification challenge) */
    body: string;
}

const MAX_RESPONSE_BYTES = 4096;

function timeoutMs(): number {
    const n = Number(process.env.WEBHOOK_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 1000 ? Math.min(30_000, n) : 10_000;
}

function category(error: any): string {
    if (error instanceof BlockedDestinationError) return "blocked_destination";
    const code = String(error?.code || "");
    if (error?.message === "timeout" || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
    if (code === "ECONNREFUSED") return "connection_refused";
    if (code === "ECONNRESET" || code === "EPIPE") return "connection_reset";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_failed";
    if (/CERT|SSL|TLS|SELF_SIGNED|ERR_TLS/.test(code)) return "tls_error";
    return "network_error";
}

export function postWebhook(url: string, environment: "development" | "production", body: string, headers: Record<string, string>): Promise<SendResult> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r: SendResult) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(r);
            }
        };
        let dest;
        try {
            dest = parseDestination(url, environment);
        } catch (error) {
            return finish({ ok: false, statusCode: null, error: category(error), body: "" });
        }
        const client = dest.protocol === "https:" ? https : http;
        const req = client.request({
            host: dest.hostname,
            port: dest.port,
            path: `${dest.url.pathname}${dest.url.search}`,
            method: "POST",
            lookup: pinnedLookup as any,
            agent: false,
            ...(dest.protocol === "https:" && !net.isIP(dest.hostname) ? { servername: dest.hostname } : {}),
            headers: { ...headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "SpreeWe-Webhooks/1" },
        }, (res) => {
            const status = res.statusCode || 0;
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                if (size < MAX_RESPONSE_BYTES) {
                    chunks.push(chunk.subarray(0, MAX_RESPONSE_BYTES - size));
                    size += chunk.length;
                }
                if (size >= MAX_RESPONSE_BYTES) res.destroy();
            });
            const done = () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (status >= 200 && status < 300) return finish({ ok: true, statusCode: status, error: null, body: text });
                finish({ ok: false, statusCode: status, error: status >= 300 && status < 400 ? "redirect_not_followed" : `http_${status}`, body: "" });
            };
            res.on("end", done);
            res.on("close", done);
            res.on("error", () => done());
        });
        const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs());
        req.on("error", (error) => finish({ ok: false, statusCode: null, error: category(error), body: "" }));
        req.end(body);
    });
}

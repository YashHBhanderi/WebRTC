/**
 * Minimal browser-side integration. It never sees the app credential: it asks YOUR backend for a
 * short-lived SpreeWe user token, calls the REST API with it, and opens a Socket.IO connection
 * that is re-established with a fresh token when the old one expires.
 *
 * Exercised by webrtc-BE/test/examples.test.ts against a running SpreeWe server.
 */
import { io, Socket } from "socket.io-client";

export type TokenSource = () => Promise<{ accessToken: string; expiresAt: string }>;

/** e.g. () => fetch("/spreewe/token", { method: "POST", credentials: "include" }).then((r) => r.json()) */
export class SpreeWeBrowserClient {
    private token: { accessToken: string; expiresAt: string } | null = null;
    private socket: Socket | null = null;

    constructor(private readonly apiBase: string, private readonly socketUrl: string, private readonly getToken: TokenSource) {}

    private async bearer(): Promise<string> {
        if (!this.token || new Date(this.token.expiresAt).getTime() - Date.now() < 30_000) {
            this.token = await this.getToken();
        }
        return this.token.accessToken;
    }

    /** GET a /v1 endpoint; retries once with a fresh token on 401 (expired / revoked). */
    async get<T = any>(path: string): Promise<{ data: T; page?: { nextCursor: string | null } }> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(`${this.apiBase}${path}`, { headers: { Authorization: `Bearer ${await this.bearer()}` } });
            if (res.status === 401 && attempt === 0) {
                this.token = null;
                continue;
            }
            const json: any = await res.json();
            if (!res.ok) throw new Error(`${res.status} ${json?.error?.code}: ${json?.error?.message}`);
            return json;
        }
        throw new Error("Unauthorized");
    }

    /**
     * Realtime: app tokens are short-lived and the server closes the socket when the token expires,
     * so reconnect with a fresh one. Only text messages can be sent; only message and presence
     * events are received (per the token's scopes).
     */
    async connect(onMessage: (message: any) => void): Promise<Socket> {
        const open = async (): Promise<Socket> => {
            const socket = io(this.socketUrl, { auth: { token: await this.bearer() }, transports: ["websocket"], reconnection: false });
            socket.on("receiveMessage", onMessage);
            socket.on("disconnect", (reason) => {
                if (reason !== "io client disconnect") {
                    this.token = null; // probably expired: fetch a new one and reconnect
                    setTimeout(() => void open().then((s) => (this.socket = s)).catch(() => undefined), 1000);
                }
            });
            await new Promise<void>((resolve, reject) => {
                socket.once("connect", () => resolve());
                socket.once("connect_error", reject);
            });
            return socket;
        };
        this.socket = await open();
        return this.socket;
    }

    // No sendText(): every SpreeWe message is end-to-end encrypted on the user's own devices. An app
    // holds no device keys, so it can't send messages, and it receives incoming ones only as
    // { encrypted: true } notices (no content, no ciphertext). See docs/security/end-to-end-encryption.md.

    close(): void {
        this.socket?.disconnect();
        this.socket = null;
    }
}

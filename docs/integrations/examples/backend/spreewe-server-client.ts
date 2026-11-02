/**
 * SpreeWe server-side helper for YOUR backend (Node.js 18+, TypeScript).
 *
 * Holds the app's server credential (keyId + secret) and exchanges it for short-lived user tokens.
 * This file must only ever run on your server: never bundle it into a browser or mobile app.
 *
 * Exercised by webrtc-BE/test/examples.test.ts against a running SpreeWe server.
 */
export interface UserToken {
    accessToken: string;
    expiresAt: string;
    scopes: string[];
    tenantId: string | null;
}

export class SpreeWeApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message);
        this.name = "SpreeWeApiError";
    }
}

export class SpreeWeServerClient {
    private readonly authorization: string;
    private readonly cache = new Map<string, UserToken>();

    /**
     * @param baseUrl  e.g. "https://api.example.com/api" (the SpreeWe API root, without /v1)
     * @param keyId    swk_live_… / swk_test_…   (from POST /v1/apps/{appId}/credentials)
     * @param secret   sws_…  (shown once at creation; load it from your secret store / env)
     */
    constructor(private readonly baseUrl: string, keyId: string, secret: string) {
        if (!keyId || !secret) throw new Error("SpreeWe credentials are missing");
        this.authorization = `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`;
    }

    /**
     * Token for one of YOUR users who has authorised the app in SpreeWe (consent), identified by the
     * externalUserRef they consented with. Cached until 60 s before expiry.
     */
    async userToken(externalUserRef: string, scopes?: string[]): Promise<UserToken> {
        const key = `${externalUserRef}|${(scopes || []).join(",")}`;
        const hit = this.cache.get(key);
        if (hit && new Date(hit.expiresAt).getTime() - Date.now() > 60_000) return hit;
        const body = await this.call("/v1/app-tokens", { externalUserRef, ...(scopes ? { scopes } : {}) });
        const token: UserToken = { accessToken: body.accessToken, expiresAt: body.expiresAt, scopes: body.scopes, tenantId: body.tenantId };
        this.cache.set(key, token);
        return token;
    }

    /**
     * Start the consent flow for one of YOUR users: returns the SpreeWe URL to redirect them to.
     * `state` must be unguessable and tied to your user's session; check it when SpreeWe redirects
     * back to `redirectUri` (which must exactly match a callback URL registered for your app).
     */
    async startConsent(externalUserRef: string, scopes: string[], redirectUri: string, state: string): Promise<{ consentUrl: string; expiresAt: string }> {
        const body = await this.call("/v1/consent-requests", { externalUserRef, scopes, redirectUri, state });
        return { consentUrl: body.consentUrl, expiresAt: body.expiresAt };
    }

    /** Revoke a token you handed out (e.g. when your user signs out). */
    async revoke(accessToken: string): Promise<void> {
        await this.call("/v1/app-tokens/revoke", { token: accessToken });
        for (const [k, v] of this.cache) if (v.accessToken === accessToken) this.cache.delete(k);
    }

    private async call(path: string, payload: unknown): Promise<any> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { Authorization: this.authorization, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) {
            // 401 bad credential · 403 user hasn't authorised / scope not granted / app suspended · 429 slow down
            throw new SpreeWeApiError(res.status, json?.error?.code || "ERROR", json?.error?.message || res.statusText);
        }
        return json.data;
    }
}

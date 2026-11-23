import { expect } from "vitest";
import { api, legacyGlobal, makeUser, startSocketServer, uniq, type Session } from "../../webrtc-BE/test/helpers";
import { backendTokenProvider, createClient, type SpreeWeClient, type TokenProvider } from "@spreewe/core";

export { api, makeUser, uniq, startSocketServer, type Session };

export interface TestApp {
    appId: string;
    name: string;
    keyId: string;
    secret: string;
}

/**
 * Register a developer app (as `owner`, a SpreeWe session) and create its server credential.
 *
 * By default the app is turned into a LEGACY GLOBAL app (SpreeWe accounts link to it by consent /
 * OAuth), which is what the consent-based suites here exercise; such apps can no longer be created
 * through the API but existing ones keep working. `{ dedicated: true }` keeps the app as the API
 * creates it today: with its own tenant and its own registered users (app-users.test.ts).
 */
export async function registerApp(owner: Session, scopes: string[], extra: Record<string, unknown> = {}, options: { dedicated?: boolean } = {}): Promise<TestApp> {
    const created = await api(owner)
        .post("/v1/apps")
        .send({ name: uniq("SDK"), environment: "development", callbackUrls: ["http://localhost:8787/oauth/callback"], scopes, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.data;
    if (!options.dedicated) await legacyGlobal(app._id);
    const cred = await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name });
    expect(cred.status, JSON.stringify(cred.body)).toBe(201);
    return { appId: String(app._id), name: app.name, keyId: cred.body.data.credential.keyId, secret: cred.body.data.secret };
}

/** The user approves the app (what the SpreeWe consent page does). */
export async function grant(user: Session, app: TestApp, scopes: string[]): Promise<void> {
    const res = await api(user).post(`/v1/apps/${app.appId}/grants`).send({ scopes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/**
 * What a developer's backend does: POST /v1/app-tokens with the credential (HTTP Basic). Here it
 * runs in the test process; in production it runs on the developer's server, never in the browser.
 */
export function serverExchange(baseUrl: string, app: TestApp, userId: string, opts: { ttlSeconds?: number; scopes?: string[] } = {}) {
    return async () => {
        const res = await fetch(`${baseUrl}/v1/app-tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${app.keyId}:${app.secret}`).toString("base64")}` },
            body: JSON.stringify({ userId, ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}), ...(opts.scopes ? { scopes: opts.scopes } : {}) }),
        });
        const body = await res.json();
        if (res.status !== 201) throw new Error(`token exchange ${res.status}: ${JSON.stringify(body)}`);
        return { accessToken: body.data.accessToken as string, expiresAt: body.data.expiresAt as string };
    };
}

export function clientFor(baseUrl: string, auth: TokenProvider): SpreeWeClient {
    return createClient({ baseUrl, auth, socket: { transports: ["websocket"] } });
}

export function appClient(baseUrl: string, app: TestApp, userId: string): SpreeWeClient {
    return clientFor(baseUrl, backendTokenProvider({ fetchToken: serverExchange(baseUrl, app, userId) }));
}

/** Wait until `check` passes (polling), or fail with its last error. */
export async function eventually<T>(check: () => T | Promise<T>, ms = 8000, step = 50): Promise<T> {
    const end = Date.now() + ms;
    let last: unknown;
    for (;;) {
        try {
            return await check();
        } catch (e) {
            last = e;
        }
        if (Date.now() > end) throw last;
        await new Promise((r) => setTimeout(r, step));
    }
}

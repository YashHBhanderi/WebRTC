import { describe, expect, it } from "vitest";
import request from "supertest";
import { api, makeUser, Session, testApp, uniq } from "./helpers";

/**
 * Backend behaviour the Developer Portal relies on: app description / website, enable / disable,
 * delete (revoke), credential regeneration, and usage with error counts. Ownership is enforced on
 * every management call (other users get 404, as for the rest of /v1/apps).
 */
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());

async function registerApp(owner: Session, body: Record<string, unknown> = {}) {
    const created = await api(owner).post("/v1/apps").send({ name: uniq("Portal app"), environment: "development", callbackUrls: ["https://example.com/cb"], ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.data;
    const cred = await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name });
    expect(cred.status, JSON.stringify(cred.body)).toBe(201);
    return { app, keyId: cred.body.data.credential.keyId as string, credentialId: cred.body.data.credential._id as string, secret: cred.body.data.secret as string };
}

async function userToken(owner: Session, user: Session, scopes: string[]) {
    const reg = await registerApp(owner, { scopes });
    const granted = await api(user).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    const tok = await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ userId: String(user.user._id) });
    expect(tok.status, JSON.stringify(tok.body)).toBe(201);
    return { ...reg, accessToken: tok.body.data.accessToken as string };
}

describe("Developer Portal backend: app details", () => {
    it("stores description and website on create, updates and clears them, and validates the URL", async () => {
        const owner: Session = { user: await makeUser() };
        const { app } = await registerApp(owner, { description: "  Support desk integration  ", websiteUrl: "https://acme.example/support" });
        expect(app.description).toBe("Support desk integration");
        expect(app.websiteUrl).toBe("https://acme.example/support");

        const updated = await api(owner).patch(`/v1/apps/${app._id}`).send({ description: "New text", websiteUrl: "" });
        expect(updated.status).toBe(200);
        expect(updated.body.data).toMatchObject({ description: "New text", websiteUrl: "" });
        expect((await api(owner).get(`/v1/apps/${app._id}`)).body.data.description).toBe("New text");

        for (const bad of ["not a url", "ftp://acme.example", "javascript:alert(1)", "https://user:pw@acme.example"]) {
            const res = await api(owner).patch(`/v1/apps/${app._id}`).send({ websiteUrl: bad });
            expect(res.status, bad).toBe(400);
        }
        expect((await api(owner).patch(`/v1/apps/${app._id}`).send({ description: "x".repeat(501) })).status).toBe(400);
    });
});

describe("Developer Portal backend: ownership of every portal action", () => {
    it("another user can't disable, enable, delete, regenerate, configure webhooks or read usage", async () => {
        const owner: Session = { user: await makeUser() };
        const other: Session = { user: await makeUser() };
        const { app, credentialId } = await registerApp(owner);
        const as = api(other);
        expect((await as.post(`/v1/apps/${app._id}/suspend`).send({ confirm: app.name })).status).toBe(404);
        expect((await as.post(`/v1/apps/${app._id}/reactivate`).send({ confirm: app.name })).status).toBe(404);
        expect((await as.post(`/v1/apps/${app._id}/revoke`).send({ confirm: app.name })).status).toBe(404);
        expect((await as.post(`/v1/apps/${app._id}/credentials/${credentialId}/rotate`).send({ confirm: app.name })).status).toBe(404);
        expect((await as.post(`/v1/apps/${app._id}/credentials/${credentialId}/revoke`).send({ confirm: app.name })).status).toBe(404);
        expect((await as.get(`/v1/apps/${app._id}/credentials`)).status).toBe(404);
        expect((await as.get(`/v1/apps/${app._id}/webhooks`)).status).toBe(404);
        expect((await as.post(`/v1/apps/${app._id}/webhooks`).send({ url: "https://hooks.example/x", events: ["message.created"], confirm: app.name })).status).toBe(404);
        expect((await as.get(`/v1/apps/${app._id}/usage`)).status).toBe(404);
        expect((await as.get(`/v1/apps/${app._id}/audit`)).status).toBe(404);
        // Nothing changed for the owner
        expect((await api(owner).get(`/v1/apps/${app._id}`)).body.data.status).toBe("active");
    });
});

describe("Developer Portal backend: enable, disable, delete, regenerate", () => {
    it("disabling stops credentials and tokens; enabling restores them; deleting is permanent", async () => {
        const owner: Session = { user: await makeUser() };
        const user: Session = { user: await makeUser() };
        const reg = await userToken(owner, user, ["profile:read"]);
        expect((await http().get("/v1/me").set(bearer(reg.accessToken))).status).toBe(200);

        expect((await api(owner).post(`/v1/apps/${reg.app._id}/suspend`).send({ confirm: reg.app.name })).status).toBe(201);
        expect((await api(owner).get(`/v1/apps/${reg.app._id}`)).body.data.status).toBe("suspended");
        expect((await http().get("/v1/me").set(bearer(reg.accessToken))).status).toBe(401);
        expect((await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ userId: String(user.user._id) })).status).toBeGreaterThanOrEqual(400);

        expect((await api(owner).post(`/v1/apps/${reg.app._id}/reactivate`).send({ confirm: reg.app.name })).status).toBe(201);
        const fresh = await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ userId: String(user.user._id) });
        expect(fresh.status).toBe(201);
        expect((await http().get("/v1/me").set(bearer(fresh.body.data.accessToken))).status).toBe(200);

        expect((await api(owner).post(`/v1/apps/${reg.app._id}/revoke`).send({ confirm: reg.app.name })).status).toBe(201);
        expect((await api(owner).get(`/v1/apps/${reg.app._id}`)).body.data.status).toBe("revoked");
        expect((await api(owner).post(`/v1/apps/${reg.app._id}/reactivate`).send({ confirm: reg.app.name })).status).toBe(409);
        expect((await api(owner).patch(`/v1/apps/${reg.app._id}`).send({ name: "Back again" })).status).toBe(409);
        expect((await http().get("/v1/me").set(bearer(fresh.body.data.accessToken))).status).toBe(401);
    });

    it("irreversible actions (delete, regenerate) need the app's exact name; disable/enable are reversible and don't", async () => {
        const owner: Session = { user: await makeUser() };
        const { app, credentialId } = await registerApp(owner);
        expect((await api(owner).post(`/v1/apps/${app._id}/revoke`).send({})).status).toBe(400);
        expect((await api(owner).post(`/v1/apps/${app._id}/revoke`).send({ confirm: "wrong" })).status).toBe(400);
        expect((await api(owner).post(`/v1/apps/${app._id}/credentials/${credentialId}/rotate`).send({ confirm: "wrong" })).status).toBe(400);
        expect((await api(owner).get(`/v1/apps/${app._id}`)).body.data.status).toBe("active");
    });

    it("regenerating a secret returns the new secret once; the list never contains secrets", async () => {
        const owner: Session = { user: await makeUser() };
        const { app, credentialId, secret } = await registerApp(owner);
        const rotated = await api(owner).post(`/v1/apps/${app._id}/credentials/${credentialId}/rotate`).send({ confirm: app.name });
        expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
        const newSecret = rotated.body.data.secret as string;
        expect(newSecret).toMatch(/^sws_/);
        expect(newSecret).not.toBe(secret);
        const list = JSON.stringify((await api(owner).get(`/v1/apps/${app._id}/credentials`)).body);
        expect(list).not.toContain(secret);
        expect(list).not.toContain(newSecret);
        expect(list).toContain("rotated");
    });
});

describe("Developer Portal backend: usage with errors", () => {
    it("counts authenticated app requests and the ones that failed (status >= 400)", async () => {
        const owner: Session = { user: await makeUser() };
        const user: Session = { user: await makeUser() };
        const reg = await userToken(owner, user, ["profile:read"]);
        expect((await http().get("/v1/me").set(bearer(reg.accessToken))).status).toBe(200);
        // Not granted: conversations:read → refused
        expect((await http().get("/v1/conversations").set(bearer(reg.accessToken))).status).toBe(403);
        expect((await http().get("/v1/conversations").set(bearer(reg.accessToken))).status).toBe(403);
        // Usage is written asynchronously
        let today: any = null;
        for (let i = 0; i < 20 && !(today?.apiErrors >= 2); i++) {
            await new Promise((r) => setTimeout(r, 100));
            const usage = await api(owner).get(`/v1/apps/${reg.app._id}/usage?days=1`);
            expect(usage.status).toBe(200);
            today = usage.body.data[0] ?? null;
        }
        expect(today).toBeTruthy();
        expect(today.apiErrors).toBe(2);
        expect(today.apiRequests).toBeGreaterThanOrEqual(4); // token exchange (credential) + 3 API calls
        expect(today.tokensIssued).toBe(1);
    });
});

describe("Developer Portal backend: permission catalogue", () => {
    it("GET /v1/scopes lists every scope with a description; messages:write is marked unavailable; app tokens are refused", async () => {
        const { ALL_SCOPES } = await import("../src/developer/scopes");
        const owner: Session = { user: await makeUser() };
        const res = await api(owner).get("/v1/scopes");
        expect(res.status).toBe(200);
        const rows = res.body.data as { scope: string; description: string; sensitive: boolean; available: boolean }[];
        expect(rows.map((r) => r.scope).sort()).toEqual([...ALL_SCOPES].sort());
        expect(rows.every((r) => r.description.length > 10)).toBe(true);
        expect(rows.find((r) => r.scope === "messages:write")).toMatchObject({ available: false, sensitive: true });
        expect(rows.filter((r) => !r.available).map((r) => r.scope)).toEqual(["messages:write"]);

        const reg = await userToken(owner, { user: await makeUser() }, ["profile:read"]);
        expect((await http().get("/v1/scopes").set(bearer(reg.accessToken))).status).toBe(403);
    });
});

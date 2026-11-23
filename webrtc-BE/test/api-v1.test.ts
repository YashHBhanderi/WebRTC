import fs from "fs";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Call from "../src/models/callModel";
import Recording from "../src/models/recordingModel";
import { runAsSystem } from "../src/tenancy/context";
import { routes } from "../src/api/v1/registry";
import { OPENAPI_FILE, buildOpenApi, renderOpenApi, securityFor } from "../src/api/v1/openapi";
import { addMessage, api, enter, makeUser, newOrg, oid, Session, testApp } from "./helpers";

const ID = "0123456789abcdef01234567";
const concrete = (path: string) => "/v1" + path.replace(/:[A-Za-z]+/g, ID);
const idOf = (b: any) => String(b?.data?._id ?? b?.conversation?._id ?? b?._id ?? b?.conversationId);

// Requirement 11: /v1 endpoints enforce the same security as legacy endpoints
describe("/v1 security baseline", () => {
    it("every registered route rejects unauthenticated requests with the v1 error envelope", async () => {
        expect(routes.length).toBeGreaterThanOrEqual(10);
        for (const def of routes) {
            for (const prefix of ["", "/api"]) {
                const res = await (request(testApp()) as any)[def.method](prefix + concrete(def.path)).send({});
                expect({ route: `${def.method} ${def.path}`, status: res.status }).toEqual({ route: `${def.method} ${def.path}`, status: 401 });
                expect(res.body.error?.code).toBe("AUTHENTICATION_ERROR");
            }
        }
        // Unknown /v1 paths are not public either
        expect((await request(testApp()).get("/v1/not-a-route")).status).toBe(401);
    });

    it("unknown paths 404 and invalid input 400 with field details", async () => {
        const u = await makeUser();
        const s: Session = { user: u };
        const missing = await api(s).get("/v1/not-a-route");
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe("NOT_FOUND_ERROR");

        const badLimit = await api(s).get("/v1/conversations?limit=1000");
        expect(badLimit.status).toBe(400);
        expect(badLimit.body.error.details[0].path).toBe("limit");
        expect((await api(s).get("/v1/conversations?cursor=nope")).status).toBe(400);
        expect((await api(s).get("/v1/conversations/not-an-id/messages")).status).toBe(400);
        expect((await api(s).get("/v1/directory?unknown=1")).status).toBe(400);
    });

    it("workspace endpoints need an active workspace; policies need owner/admin; unknown body fields are rejected", async () => {
        const org = newOrg();
        const [admin, member] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: admin, org, role: "org:admin" });
        await enter({ user: member, org });
        expect((await api({ user: admin }).get("/v1/workspace")).status).toBe(400);
        expect((await api({ user: member, org }).patch("/v1/workspace/policies").send({ allowExternalChat: true })).status).toBe(403);
        const mass = await api({ user: admin, org, role: "org:admin" }).patch("/v1/workspace/policies").send({ allowExternalChat: true, status: "active" });
        expect(mass.status).toBe(400);
        expect(mass.body.error.details.some((d: any) => d.path === "status")).toBe(true);
        expect((await api({ user: admin, org, role: "org:admin" }).patch("/v1/workspace/policies").send({})).status).toBe(400);
        const ok = await api({ user: admin, org, role: "org:admin" }).patch("/v1/workspace/policies").send({ allowExternalChat: true });
        expect(ok.status).toBe(200);
        expect(ok.body.data.policies.allowExternalChat).toBe(true);
    });
});

describe("/v1 tenant isolation and pagination", () => {
    const orgA = newOrg();
    const orgB = newOrg();
    let a1: any, a2: any, b1: any;
    let convA: string;

    beforeAll(async () => {
        [a1, a2, b1] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter({ user: a1, org: orgA });
        await enter({ user: a2, org: orgA });
        await enter({ user: b1, org: orgB });
        convA = idOf((await api({ user: a1, org: orgA }).post("/conversations").send({ receiverId: String(a2._id) })).body);
        for (let i = 0; i < 3; i++) await addMessage(convA, i % 2 ? a2 : a1, `m${i}`);
    });

    it("messages paginate with a cursor for members", async () => {
        const first = await api({ user: a2, org: orgA }).get(`/v1/conversations/${convA}/messages?limit=2`);
        expect(first.status).toBe(200);
        expect(first.body.data.map((m: any) => m.content)).toEqual(["m2", "m1"]);
        expect(first.body.page.nextCursor).toBeTruthy();
        expect(first.body.data[0].author.email).toBeUndefined();
        const second = await api({ user: a2, org: orgA }).get(`/v1/conversations/${convA}/messages?limit=2&cursor=${first.body.page.nextCursor}`);
        expect(second.body.data.map((m: any) => m.content)).toEqual(["m0"]);
        expect(second.body.page.nextCursor).toBeNull();
    });

    it("other workspaces, the global context and non-members get 404 (never the data)", async () => {
        for (const s of [{ user: b1, org: orgB }, { user: a1 }, { user: b1 }] as Session[]) {
            const res = await api(s).get(`/v1/conversations/${convA}/messages`);
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).not.toContain("m0");
        }
        const listB = await api({ user: b1, org: orgB }).get("/v1/conversations");
        expect(JSON.stringify(listB.body)).not.toContain(convA);
        const listA = await api({ user: a1, org: orgA }).get("/v1/conversations");
        expect(listA.body.data.map((c: any) => c._id)).toContain(convA);
        expect(listA.body.data.find((c: any) => c._id === convA).scope).toBe("tenant");
    });

    it("directory paginates within the context and never returns emails", async () => {
        const page1 = await api({ user: a1, org: orgA }).get("/v1/directory?limit=1");
        expect(page1.status).toBe(200);
        expect(page1.body.data.map((u: any) => u._id)).toEqual([String(a2._id)]);
        expect(page1.body.data[0].email).toBeUndefined();
        expect(page1.body.page.nextCursor).toBeNull();
        const fromB = await api({ user: b1, org: orgB }).get("/v1/directory");
        expect(fromB.body.data.map((u: any) => u._id)).not.toContain(String(a1._id));
    });

    it("recordings follow the same rules as legacy routes", async () => {
        const call = await runAsSystem(() => Call.create({ conversationId: oid(convA), initiatedBy: a1._id, callType: "audio", participants: [{ userId: a1._id, status: "joined" }] } as any), "test-fixture");
        const rec = await runAsSystem(() => Recording.create({ callId: call._id, conversationId: oid(convA), title: "R", startedBy: a1._id, startedAt: new Date(), status: "processing" } as any), "test-fixture");
        expect((await api({ user: a2, org: orgA }).get(`/v1/recordings/${rec._id}`)).status).toBe(200);
        expect((await api({ user: b1, org: orgB }).get(`/v1/recordings/${rec._id}`)).status).toBe(404);
        expect((await api({ user: a2 }).get(`/v1/recordings/${rec._id}`)).status).toBe(404);
    });

    it("a revoked membership is refused on /v1 as on legacy routes", async () => {
        const org = newOrg();
        const u = await makeUser();
        await enter({ user: u, org });
        const TenantMembership = (await import("../src/models/tenantMembershipModel")).default;
        const Tenant = (await import("../src/models/tenantModel")).default;
        const { resetTenantCaches } = await import("../src/tenancy/tenant.service");
        await runAsSystem(async () => {
            const t = await Tenant.findOne({ clerkOrgId: org }).lean();
            await TenantMembership.updateOne({ tenantId: t!._id, userId: u._id }, { $set: { status: "removed", removedAt: new Date() } });
        }, "test-fixture");
        resetTenantCaches();
        const iat = Math.floor(Date.now() / 1000) - 10;
        expect((await api({ user: u, org, iat }).get("/v1/me")).status).toBe(403);
        expect((await api({ user: u, org, iat }).get("/conversations")).status).toBe(403);
    });
});

describe("OpenAPI document", () => {
    it("is generated from the registered routes and is up to date", () => {
        const doc: any = buildOpenApi();
        for (const def of routes) {
            const p = "/v1" + def.path.replace(/:([A-Za-z]+)/g, "{$1}");
            expect(doc.paths[p]?.[def.method]?.security).toEqual(securityFor(def));
            expect(doc.paths[p][def.method].security.length).toBeGreaterThan(0);
            expect(doc.paths[p][def.method].responses["401"]).toBeDefined();
            if (def.scope) expect(doc.paths[p][def.method]["x-required-scope"]).toBe(def.scope);
        }
        const rendered = renderOpenApi();
        if (process.env.OPENAPI_WRITE) {
            fs.writeFileSync(OPENAPI_FILE, rendered);
        }
        expect(fs.existsSync(OPENAPI_FILE)).toBe(true);
        // Committed file must match the code (regenerate with: npm run openapi)
        expect(fs.readFileSync(OPENAPI_FILE, "utf8").replace(/\r\n/g, "\n")).toBe(rendered);
    });
});

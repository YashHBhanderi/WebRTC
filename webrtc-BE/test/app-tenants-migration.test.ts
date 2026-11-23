import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import User from "../src/models/userModel";
import Tenant from "../src/models/tenantModel";
import { runMigrations } from "../src/migrations";
import { runAsSystem } from "../src/tenancy/context";
import { api, makeUser, Session, testApp, uniq } from "./helpers";

const basic = (r: { keyId: string; secret: string }) => ({ Authorization: `Basic ${Buffer.from(`${r.keyId}:${r.secret}`).toString("base64")}` });

async function newApp(owner: Session) {
    const app = (await api(owner).post("/v1/apps").send({ name: uniq("Migrated app "), environment: "development" })).body.data;
    const cred = (await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).body.data;
    return { app, keyId: cred.credential.keyId as string, secret: cred.secret as string };
}

async function register(reg: { keyId: string; secret: string }, externalUserId: string) {
    const res = await request(testApp()).post("/v1/app-users").set(basic(reg)).send({ externalUserId, name: `User ${externalUserId}` });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
}

describe("2026-11-16-app-tenants migration", () => {
    it("replaces the two all-document unique indexes without touching data, and is idempotent", async () => {
        const db = mongoose.connection.db!;
        // The state of a database from before this change
        // (earlier migrations already applied, this one not yet, the old indexes in place)
        await runMigrations();
        await db.collection("migrations").deleteOne({ _id: "2026-11-16-app-tenants" as any });
        // Let Mongoose finish building the current indexes first, so they aren't rebuilt under the test
        await Promise.all([User.init(), Tenant.init()]);
        for (const [coll, key] of [["users", "email"], ["tenants", "clerkOrgId"]] as const) {
            await db.collection(coll).dropIndex(`${key}_1`);
            await db.collection(coll).createIndex({ [key]: 1 }, { unique: true });
        }
        // Code deployed before its migration: existing features work, and the new ones answer 503 with
        // a clear message (never a misleading conflict, never a half-created app)
        const early: Session = { user: await makeUser() };
        const first = await api(early).post("/v1/apps").send({ name: uniq("Early app "), environment: "development" });
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const second = await api(early).post("/v1/apps").send({ name: uniq("Early app "), environment: "development" });
        expect(second.status).toBe(503);
        expect((await api(early).get("/v1/apps")).body.data).toHaveLength(1);
        const cred = (await api(early).post(`/v1/apps/${first.body.data._id}/credentials`).send({ confirm: first.body.data.name })).body.data;
        const earlyReg = { keyId: cred.credential.keyId as string, secret: cred.secret as string };
        await register(earlyReg, "e-1");
        const blocked = await request(testApp()).post("/v1/app-users").set(basic(earlyReg)).send({ externalUserId: "e-2", name: "User e-2" });
        expect(blocked.status).toBe(503);
        expect(await db.collection("users").countDocuments({ externalUserId: "e-2" })).toBe(0);
        expect((await api(early).get("/v1/me")).status).toBe(200);

        const before = { users: await db.collection("users").countDocuments(), tenants: await db.collection("tenants").countDocuments() };
        await runMigrations();
        await runMigrations();
        expect(await db.collection("migrations").countDocuments({ _id: "2026-11-16-app-tenants" as any })).toBe(1);
        const email = (await db.collection("users").indexes()).find((i) => i.name === "email_1") as any;
        expect(email.unique).toBe(true);
        expect(email.partialFilterExpression).toEqual({ email: { $type: "string" } });
        const org = (await db.collection("tenants").indexes()).find((i) => i.name === "clerkOrgId_1") as any;
        expect(org.unique).toBe(true);
        expect(org.partialFilterExpression).toEqual({ clerkOrgId: { $type: "string" } });
        expect((await db.collection("users").indexes()).some((i: any) => i.key.tenantId === 1 && i.key.externalUserId === 1 && i.unique)).toBe(true);
        expect({ users: await db.collection("users").countDocuments(), tenants: await db.collection("tenants").countDocuments() }).toEqual(before);
        // SpreeWe account emails and organization ids are still unique…
        const u = await makeUser();
        await expect(runAsSystem(() => User.collection.insertOne({ username: "Twin", email: u.email } as any), "test")).rejects.toMatchObject({ code: 11000 });
        // …and any number of application users / tenants can exist without them
        const owner: Session = { user: await makeUser() };
        const [X, Y] = [await newApp(owner), await newApp(owner)];
        await register(X, "m-1");
        await register(X, "m-2");
        await register(Y, "m-1");
        // What was refused before the migration works after it
        await register(earlyReg, "e-2");
        expect((await api(early).post("/v1/apps").send({ name: uniq("Early app "), environment: "development" })).status).toBe(201);
    });
});

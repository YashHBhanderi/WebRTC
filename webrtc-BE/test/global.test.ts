import { describe, expect, it } from "vitest";
import Conversation from "../src/models/conversationModel";
import { addMessage, api, makeUser, oid } from "./helpers";
import { runAsSystem } from "../src/tenancy/context";

// Requirement 1 and 8: global communication and historical data keep working
describe("global (personal) context", () => {
    it("two global users can start, list and read a 1:1 chat", async () => {
        const alice = await makeUser();
        const bob = await makeUser();

        const created = await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) });
        expect(created.status).toBe(200);
        const conversationId = String(created.body.data?._id ?? created.body.conversation?._id ?? created.body._id ?? created.body.conversationId);
        expect(conversationId).toMatch(/^[a-f0-9]{24}$/);

        const stored = await runAsSystem(() => Conversation.findById(conversationId).lean(), "test-inspection");
        expect(stored?.tenantId ?? null).toBeNull();
        expect(stored?.scope).toBe("global");

        await addMessage(conversationId, alice);
        const bobList = await api({ user: bob }).get("/conversations");
        expect(bobList.status).toBe(200);
        expect(JSON.stringify(bobList.body)).toContain(conversationId);

        const messages = await api({ user: bob }).get(`/messages/${conversationId}`);
        expect(messages.status).toBe(200);
    });

    it("legacy conversations without tenant fields stay readable by their members only", async () => {
        const alice = await makeUser();
        const bob = await makeUser();
        const stranger = await makeUser();
        // Written the way pre-tenancy code wrote it: no tenantId, no scope
        const raw = await Conversation.collection.insertOne({ members: [oid(alice._id), oid(bob._id)], messages: [], isGroup: false, createdAt: new Date() } as any);
        const id = String(raw.insertedId);
        await addMessage(id, alice);

        expect((await api({ user: alice }).get(`/messages/${id}`)).status).toBe(200);
        expect(JSON.stringify((await api({ user: bob }).get("/conversations")).body)).toContain(id);
        const denied = await api({ user: stranger }).get(`/messages/${id}`);
        expect([403, 404]).toContain(denied.status);
    });

    it("unauthenticated requests are rejected", async () => {
        expect((await api(null).get("/conversations")).status).toBe(401);
    });
});

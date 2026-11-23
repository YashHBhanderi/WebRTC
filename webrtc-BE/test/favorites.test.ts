import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { Team, TeamMembership } from "../src/organizations/models";
import { ack, addMessage, api, connect, makeUser, startSocketServer, uniq } from "./helpers";

/** Favorites: per user, only for conversations the user belongs to, shown on every list. */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, org: { clerkOrgId: string }) => api({ user: u, org: org.clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

beforeAll(() => Promise.all([Team, TeamMembership].map((m: any) => m.createIndexes())));

describe("favorites", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const sock = async (u: U, org?: string) => { const x = await connect(server.port, { user: u, org }); open.push(x); return x; };
    beforeAll(async () => { server = await startSocketServer(); });
    afterAll(async () => { open.forEach((s) => s.disconnect()); await server.close(); });

    it("marks a chat as favorite for me only, and lists show it", async () => {
        const [ann, bob, eve] = [await makeUser(), await makeUser(), await makeUser()];
        const chat = { _id: (await personal(ann).post("/conversations").send({ receiverId: String(bob._id) })).body.conversationId };
        await addMessage(chat._id, ann, "hi");
        const s = await sock(ann);
        const on = await ack(s, "chat:favorite", { conversationId: String(chat._id) });
        expect(on.success).toBe(true);
        expect(on.state.isFavorite).toBe(true);

        const mine = (await personal(ann).get("/conversations")).body.data.find((c: any) => String(c._id) === String(chat._id));
        expect(mine.isFavorite).toBe(true);
        const theirs = (await personal(bob).get("/conversations")).body.data.find((c: any) => String(c._id) === String(chat._id));
        expect(theirs.isFavorite).toBe(false);

        // Not a member: refused, nothing stored
        const outsider = await ack(await sock(eve), "chat:favorite", { conversationId: String(chat._id) });
        expect(outsider.error).toBeTruthy();

        expect((await ack(s, "chat:unfavorite", { conversationId: String(chat._id) })).state.isFavorite).toBe(false);
        expect((await personal(ann).get("/conversations")).body.data.find((c: any) => String(c._id) === String(chat._id)).isFavorite).toBe(false);
    });

    it("channels carry my favorite flag", async () => {
        const owner = await makeUser();
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Org " + uniq(""), slug: slug() })).body.data;
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Ops " + uniq("") })).body.data.teamId;
        const general = (await inOrg(owner, org).get(`/v1/teams/${teamId}/channels`)).body.data[0];
        expect(general.isFavorite).toBe(false);
        const s = await sock(owner, org.clerkOrgId);
        expect((await ack(s, "chat:favorite", { conversationId: general.channelId })).success).toBe(true);
        expect((await inOrg(owner, org).get(`/v1/teams/${teamId}/channels`)).body.data[0].isFavorite).toBe(true);
    });
});

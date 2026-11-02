import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { ack, api, connect, enc, makeUser, nextEvent, plainOf, Session, sleep, startSocketServer, uniq } from "./helpers";

/**
 * SEC-008 (group membership revocation): a member removed from (or leaving) a group loses the group's
 * realtime room on EVERY connection (each tab / device), not only the most recent one. Before the fix,
 * only the latest socket left the room and older tabs kept receiving messages, typing and reactions.
 */
describe("group membership revocation across all connections (SEC-008)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const G = (u: any): Session => ({ user: u });
    const sock = async (s: Session) => {
        const socket = await connect(server.port, s);
        open.push(socket);
        await sleep(150);
        return socket;
    };
    const join = async (socket: Socket, id: string) => {
        socket.emit("joinConversation", id);
        await sleep(150);
    };

    async function group(admin: any, members: any[]): Promise<string> {
        const res = await api(G(admin)).post("/conversations/group").send({ groupName: uniq("grp"), groupMembers: JSON.stringify(members.map((m) => String(m._id))) });
        expect(res.status).toBe(201);
        return String(res.body.data._id);
    }

    const send = (socket: Socket, user: any, conversationId: string, marker: string) =>
        socket.emit("sendMessage", { user: { _id: String(user._id) }, conversationId, content: "", type: "text", e2ee: enc(marker) });

    beforeAll(async () => {
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("a removed member's OLDER and newer tabs both stop receiving messages, typing and reactions", async () => {
        const [admin, bob, carol] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const id = await group(admin, [bob, carol]);
        const adminSock = await sock(G(admin));
        const carolTab1 = await sock(G(carol)); // older tab
        const carolTab2 = await sock(G(carol)); // latest tab (the only one the old code removed)
        for (const s of [adminSock, carolTab1, carolTab2]) await join(s, id);

        // Before removal: both of carol's tabs get the room's messages
        const before = [carolTab1, carolTab2].map((s) => nextEvent(s, "receiveMessage", 2000, (m) => plainOf(m) === "before"));
        send(adminSock, admin, id, "before");
        expect((await Promise.all(before)).every(Boolean)).toBe(true);

        // Remove carol; every tab is told
        const removedNotices = [carolTab1, carolTab2].map((s) => nextEvent(s, "group:removed", 2000, (p) => String(p.groupId) === id));
        const res = await api(G(admin)).put(`/conversations/group/${id}/remove-member`).send({ userId: String(carol._id) });
        expect(res.status).toBe(200);
        expect((await Promise.all(removedNotices)).every(Boolean)).toBe(true);
        await sleep(200);

        // After removal: neither tab receives messages, typing or reactions of the group
        const watch = (event: string) => [carolTab1, carolTab2].map((s) => nextEvent(s, event, 1200, (p) => String(p?.conversationId) === id));
        const messages = watch("receiveMessage");
        const typing = watch("userTyping");
        const reactions = watch("messageReactionUpdated");
        const adminGetsOwn = nextEvent(adminSock, "receiveMessage", 2000, (m) => plainOf(m) === "after");
        send(adminSock, admin, id, "after");
        const delivered = await adminGetsOwn;
        expect(delivered).not.toBeNull();
        adminSock.emit("typing", id);
        adminSock.emit("reactToMessage", { conversationId: id, messageId: String(delivered._id), emoji: "👍" });
        expect(await Promise.all(messages)).toEqual([null, null]);
        expect(await Promise.all(typing)).toEqual([null, null]);
        expect(await Promise.all(reactions)).toEqual([null, null]);
    });

    it("re-joining the room or reconnecting does not restore access", async () => {
        const [admin, carol] = await Promise.all([makeUser(), makeUser()]);
        const id = await group(admin, [carol, await makeUser()]);
        const adminSock = await sock(G(admin));
        const carolTab = await sock(G(carol));
        for (const s of [adminSock, carolTab]) await join(s, id);
        await api(G(admin)).put(`/conversations/group/${id}/remove-member`).send({ userId: String(carol._id) });
        await sleep(200);

        // The old tab asks to re-join; a brand-new connection asks too
        await join(carolTab, id);
        const fresh = await sock(G(carol));
        await join(fresh, id);
        const leaks = [carolTab, fresh].map((s) => nextEvent(s, "receiveMessage", 1200, (m) => String(m?.conversationId) === id));
        send(adminSock, admin, id, "still private");
        expect(await Promise.all(leaks)).toEqual([null, null]);
        // Nor can she read the history over REST
        expect((await api(G(carol)).get(`/messages/${id}`)).status).not.toBe(200);
    });

    it("a member who LEAVES loses the room on every tab too", async () => {
        const [admin, carol] = await Promise.all([makeUser(), makeUser()]);
        const id = await group(admin, [carol, await makeUser()]);
        const adminSock = await sock(G(admin));
        const tabs = [await sock(G(carol)), await sock(G(carol))];
        for (const s of [adminSock, ...tabs]) await join(s, id);

        // Leaving is a socket request from one of her tabs
        const leave = await ack<any>(tabs[0], "group:leave", { groupId: id });
        expect(leave.success).toBe(true);
        await sleep(200);
        const leaks = tabs.map((s) => nextEvent(s, "receiveMessage", 1200, (m) => String(m?.conversationId) === id));
        send(adminSock, admin, id, "after leaving");
        expect(await Promise.all(leaks)).toEqual([null, null]);
    });

    it("deleting a group empties its room for every member connection", async () => {
        const [admin, bob] = await Promise.all([makeUser(), makeUser()]);
        const id = await group(admin, [bob, await makeUser()]);
        const adminSock = await sock(G(admin));
        const bobTabs = [await sock(G(bob)), await sock(G(bob))];
        for (const s of [adminSock, ...bobTabs]) await join(s, id);

        expect((await api(G(admin)).delete(`/conversations/${id}`)).status).toBe(200);
        await sleep(200);
        const typing = bobTabs.map((s) => nextEvent(s, "userTyping", 1200, (p) => String(p?.conversationId) === id));
        adminSock.emit("typing", id);
        expect(await Promise.all(typing)).toEqual([null, null]);
    });
});

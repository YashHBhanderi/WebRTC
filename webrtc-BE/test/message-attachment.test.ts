import { Readable } from "stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import Conversation from "../src/models/conversationModel";
import Message from "../src/models/messageModel";
import storage from "../src/services/storage.service";
import { RequestContext, runWithContext } from "../src/tenancy/context";

const ctx = (userId: unknown): RequestContext => ({ kind: "user", userId: String(userId), tenantId: null, clerkOrgId: null, role: null, isPlatformAdmin: false });
import { api, makeUser } from "./helpers";

/** GET /v1/messages/:id/attachment streams encrypted attachments through the API (no bucket CORS). */
async function fixture(mimeType = "application/octet-stream") {
    const [a, b, outsider] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const conv = await runWithContext(ctx(a._id), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
    const msg = await runWithContext(ctx(a._id), () => Message.create({
        conversationId: conv._id, userId: a._id, type: "file", content: "file", fileUrl: "", thumbnailUrl: "",
        file: { storageKey: `messages/${conv._id}/files/x.bin`, storageProvider: "s3", mimeType, size: 5 },
    }));
    return { a, b, outsider, msg };
}

const binary = (r: any) => r.buffer(true).parse((res: any, cb: any) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
});

describe("v1 message attachment download", () => {
    afterEach(() => vi.restoreAllMocks());

    it("streams the ciphertext to a conversation member", async () => {
        const { b, msg } = await fixture();
        const open = vi.spyOn(storage, "openStream").mockResolvedValue({ body: Readable.from([Buffer.from("CIPHR")]), length: 5 });
        const res = await binary(api({ user: b }).get(`/v1/messages/${msg._id}/attachment`));
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("application/octet-stream");
        expect(res.headers["cache-control"]).toContain("no-store");
        expect(Buffer.from(res.body).toString()).toBe("CIPHR");
        expect(open).toHaveBeenCalledWith(`messages/${msg.conversationId}/files/x.bin`);
    });

    it("answers 404 to non-members without touching storage", async () => {
        const { outsider, msg } = await fixture();
        const open = vi.spyOn(storage, "openStream");
        const res = await api({ user: outsider }).get(`/v1/messages/${msg._id}/attachment`);
        expect(res.status).toBe(404);
        expect(open).not.toHaveBeenCalled();
    });

    it("serves older unencrypted files only as a sandboxed download", async () => {
        const { b, msg } = await fixture("text/html");
        vi.spyOn(storage, "openStream").mockResolvedValue({ body: Readable.from([Buffer.from("<b>x</b>")]), length: 8 });
        const res = await binary(api({ user: b }).get(`/v1/messages/${msg._id}/attachment`));
        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
        expect(res.headers["content-security-policy"]).toContain("sandbox");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("404 for an unknown message id", async () => {
        const { b } = await fixture();
        const open = vi.spyOn(storage, "openStream");
        expect((await api({ user: b }).get(`/v1/messages/${"0".repeat(24)}/attachment`)).status).toBe(404);
        expect(open).not.toHaveBeenCalled();
    });

    it("requires authentication", async () => {
        const { msg } = await fixture();
        expect((await api(null).get(`/v1/messages/${msg._id}/attachment`)).status).toBe(401);
    });
});

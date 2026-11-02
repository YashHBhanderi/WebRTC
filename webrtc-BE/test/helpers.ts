import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import mongoose from "mongoose";
import { io as ioClient, Socket } from "socket.io-client";
import User from "../src/models/userModel";
import { createApp } from "../src/app";

let counter = 0;
/** Unique per call so no in-memory cache (identity, tenant) ever sees a reused id. */
export const uniq = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function makeUser(name = uniq("usr"), extra: Record<string, unknown> = {}) {
    const clean = name.replace(/[^a-z0-9]/gi, "");
    return User.create({ username: clean, email: `${clean}@example.test`, clerkId: `user_${clean}`, ...extra });
}

export const newOrg = () => `org_${uniq("o")}`;

export interface Session {
    user: any;
    org?: string;
    role?: string;
    /** Token issue time (seconds); defaults to now */
    iat?: number;
    /** Clerk fva claim: [minutes since first factor, second factor] */
    fva?: [number, number];
}

export const authHeader = (s: Session) => ({
    "x-test-auth": JSON.stringify({ sub: s.user.clerkId, org: s.org, role: s.role, iat: s.iat, fva: s.fva }),
});

let app: ReturnType<typeof createApp> | null = null;
export function testApp() {
    app = app || createApp("*");
    return app;
}

export function api(s: Session | null) {
    const agent = request(testApp());
    const wrap = (m: "get" | "post" | "put" | "patch" | "delete") => (url: string) => {
        const r = agent[m](url);
        return s ? r.set(authHeader(s)) : r;
    };
    return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

/** Make Clerk-style membership known locally (what happens on a member's first request). */
export async function enter(s: Session): Promise<void> {
    const res = await api(s).get("/tenant/current");
    if (res.status !== 200) {
        throw new Error(`enter failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
}

export const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));

// ------------------------------------------------------------------ sockets

export async function startSocketServer() {
    const { startRealtime } = await import("../src/realtime");
    const server = http.createServer(testApp());
    startRealtime(server, "*");
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        port,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

export function connect(port: number, s: Session): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(`http://localhost:${port}`, {
            auth: { token: JSON.stringify({ sub: s.user.clerkId, org: s.org, role: s.role, iat: s.iat }), deviceId: uniq("device") },
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
        });
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
    });
}

/** Resolve with the first matching event, or `null` after `ms` (used to prove an event did NOT arrive). */
export function nextEvent<T = any>(socket: Socket, event: string, ms = 800, match: (p: any) => boolean = () => true): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            resolve(null);
        }, ms);
        const handler = (payload: any) => {
            if (match(payload)) {
                clearTimeout(timer);
                socket.off(event, handler);
                resolve(payload);
            }
        };
        socket.on(event, handler);
    });
}

export function ack<T = any>(socket: Socket, event: string, payload: unknown, ms = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), ms);
        socket.emit(event, payload, (response: T) => {
            clearTimeout(timer);
            resolve(response);
        });
    });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stored text message (written directly; the chat list hides chats with no messages). */
export async function addMessage(conversationId: unknown, user: any, content = "hello") {
    const Message = (await import("../src/models/messageModel")).default;
    const { runAsSystem } = await import("../src/tenancy/context");
    // Stamped from its conversation by the scope plugin
    return runAsSystem(() => Message.create({ conversationId: oid(conversationId), userId: user._id, content, type: "text", fileUrl: "", thumbnailUrl: "" }), "test-fixture");
}

// ------------------------------------------------------------------ end-to-end encryption (test doubles)

/**
 * An encrypted-message payload with the shape the server accepts. Real encryption happens in browsers
 * (and is tested there); here the "ciphertext" just carries a marker so tests can tell messages apart.
 */
export const enc = (marker: string) => ({
    algorithm: "m.megolm.v1.aes-sha2",
    ciphertext: Buffer.from(marker).toString("base64").replace(/=+$/, ""),
    session_id: "c2Vzc2lvbg",
    sender_key: "c2VuZGVya2V5",
    device_id: "TESTDEVICE",
});

/** The marker of a message built with enc() (or a legacy message's plaintext). */
export const plainOf = (m: any): string | undefined => (m?.e2ee?.ciphertext ? Buffer.from(m.e2ee.ciphertext, "base64").toString() : m?.content);

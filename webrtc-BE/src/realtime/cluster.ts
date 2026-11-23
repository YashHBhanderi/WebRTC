import os from "os";
import crypto from "crypto";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/mongo-adapter";
import { safeError } from "../utils/safe-log";

/**
 * Multi-instance Socket.IO.
 *
 *   SOCKET_ADAPTER=mongo   share events between backend instances through MongoDB change streams
 *                          (@socket.io/mongo-adapter; needs a replica set — Atlas always is one).
 *   SOCKET_ADAPTER unset   single instance. Every instance records a heartbeat; if another live
 *                          instance is seen without the adapter, readiness fails (GET /health/ready
 *                          → 503) and an error is logged, so a second instance cannot silently split
 *                          real-time delivery.
 *
 * The adapter is only a transport. Authorization stays where it was: per-user events are re-published
 * to the other instances as "deliver to user X", and each instance delivers only to ITS OWN sockets
 * after the same checks as before (the socket's verified workspace, conversation visibility, app
 * scopes). Room broadcasts (conversation / call rooms) cross instances through the adapter; rooms are
 * joined only after the existing membership checks.
 */
export const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;

const EVENTS_COLLECTION = "socket_io_events";
const INSTANCES_COLLECTION = "runtime_instances";
const DELIVER = "spreewe:deliver";

/** A cross-instance delivery request; each kind has one local handler (see onCluster). */
export type ClusterMessage = { kind: string; [field: string]: unknown };

const handlers = new Map<string, (message: ClusterMessage) => void | Promise<void>>();

/** Register how THIS instance applies a message published by another instance. */
export function onCluster(kind: string, handler: (message: ClusterMessage) => void | Promise<void>): void {
    handlers.set(kind, handler);
}

let clustered = false;
let ioRef: Server | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let peersWithoutAdapter = 0;

export const isClustered = (): boolean => clustered;

export function adapterMode(env: NodeJS.ProcessEnv = process.env): "mongo" | "none" {
    const v = String(env.SOCKET_ADAPTER || "").trim().toLowerCase();
    if (v === "mongo") return "mongo";
    if (v && v !== "none") throw new Error(`SOCKET_ADAPTER must be "mongo" or unset (got "${v}")`);
    return "none";
}

/** Attach the MongoDB adapter (if configured) and the local handler for cross-instance deliveries. */
export async function setUpCluster(io: Server): Promise<void> {
    ioRef = io;
    if (adapterMode() === "mongo") {
        const db = mongoose.connection.db;
        if (!db) throw new Error("MongoDB must be connected before the Socket.IO adapter is set up");
        const hello = await db.admin().command({ hello: 1 });
        if (!hello.setName && hello.msg !== "isdbgrid") {
            throw new Error("SOCKET_ADAPTER=mongo needs a MongoDB replica set or sharded cluster (change streams)");
        }
        const collection = db.collection(EVENTS_COLLECTION);
        // Events are only needed for seconds; the TTL index keeps the collection small
        await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
        io.adapter(createAdapter(collection as any, { addCreatedAtField: true }) as any);
        clustered = true;
        console.log(`[cluster] Socket.IO MongoDB adapter enabled (instance ${instanceId})`);
    }
    io.on(DELIVER, (message: ClusterMessage) => {
        const handler = handlers.get(String(message?.kind));
        if (!handler) return;
        Promise.resolve()
            .then(() => handler(message))
            .catch((error) => console.error(`[cluster] ${message.kind} delivery failed:`, safeError(error)));
    });
    await beat();
    heartbeat = setInterval(() => void beat(), 10_000);
    heartbeat.unref();
}

/** Tell the other instances (never this one) to deliver locally. No-op on a single instance. */
export function publish(message: ClusterMessage): void {
    if (!clustered || !ioRef) return;
    // JSON round trip = exactly what a client would receive, and safe to store as a MongoDB document
    const plain = JSON.parse(JSON.stringify(message));
    try {
        ioRef.serverSideEmit(DELIVER, plain);
    } catch (error) {
        console.error("[cluster] publish failed:", safeError(error));
    }
}

/** Sockets of a user on ANY instance (cluster-wide when the adapter is on). */
export async function userConnectedAnywhere(userId: string, localConnected: boolean): Promise<boolean> {
    if (localConnected || !clustered || !ioRef) return localConnected;
    try {
        return (await ioRef.in(userRoom(userId)).fetchSockets()).length > 0;
    } catch {
        // Other instances did not answer in time: assume connected rather than flapping presence
        return true;
    }
}

export const userRoom = (userId: string) => `user:${userId}`;

/** Record this instance and re-check its peers now (also runs every 10 s). */
export async function heartbeatNow(): Promise<void> {
    return beat();
}

async function beat(): Promise<void> {
    const db = mongoose.connection.db;
    if (!db) return;
    try {
        const col = db.collection(INSTANCES_COLLECTION);
        await col.createIndex({ seenAt: 1 }, { expireAfterSeconds: 60 });
        await col.updateOne({ _id: instanceId as any }, { $set: { seenAt: new Date(), adapter: clustered ? "mongo" : "none", startedAt: startedAt } }, { upsert: true });
        const others = await col.find({ _id: { $ne: instanceId as any }, seenAt: { $gt: new Date(Date.now() - 30_000) } }).project({ adapter: 1 }).toArray();
        const unsafe = others.filter((o) => !clustered || o.adapter !== "mongo").length;
        if (unsafe && !peersWithoutAdapter) {
            console.error(`[cluster] ${others.length} other live instance(s) share this database but real-time events are not shared (SOCKET_ADAPTER=mongo on every instance). Readiness now fails.`);
        }
        peersWithoutAdapter = unsafe;
    } catch (error) {
        console.error("[cluster] heartbeat failed:", safeError(error));
    }
}

const startedAt = new Date();

/** Readiness problems for GET /health/ready (empty = ready). */
export function clusterProblems(): string[] {
    return peersWithoutAdapter ? ["multiple instances without a shared Socket.IO adapter"] : [];
}

export async function stopCluster(): Promise<void> {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    await mongoose.connection.db?.collection(INSTANCES_COLLECTION).deleteOne({ _id: instanceId as any }).catch(() => undefined);
}

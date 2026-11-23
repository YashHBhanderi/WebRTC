import { MongoMemoryReplSet } from "mongodb-memory-server";

// Single-node replica set: same behaviour as a standalone server for ordinary tests, and it supports
// change streams (Socket.IO MongoDB adapter, multi-instance tests)
let server: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    process.env.TEST_MONGO_URI = server.getUri();
}

export async function teardown(): Promise<void> {
    await server?.stop();
}

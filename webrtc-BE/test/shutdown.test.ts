import http from "http";
import { AddressInfo } from "net";
import { describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { createShutdown } from "../src/shutdown";
import { connect, makeUser, testApp } from "./helpers";

// Operational readiness: graceful shutdown closes sockets, HTTP, media and the database
describe("graceful shutdown", () => {
    it("disconnects clients, stops accepting connections, closes media and MongoDB (idempotent)", async () => {
        const { startRealtime } = await import("../src/realtime");
        const { io } = await import("../src/realtime/io");
        const server = http.createServer(testApp());
        startRealtime(server, "*");
        await new Promise<void>((r) => server.listen(0, r));
        const port = (server.address() as AddressInfo).port;
        const user = await makeUser();
        const client = await connect(port, { user });
        const disconnected = new Promise<boolean>((resolve) => {
            client.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
        });

        const stopTimers = vi.fn();
        const closeMedia = vi.fn();
        const shutdown = createShutdown({ server, io, stopTimers, closeMedia }, () => undefined);
        const first = shutdown("SIGTERM");
        const second = shutdown("SIGTERM");
        expect(second).toBe(first);
        await first;

        expect(await disconnected).toBe(true);
        expect(stopTimers).toHaveBeenCalledTimes(1);
        expect(closeMedia).toHaveBeenCalledTimes(1);
        expect(mongoose.connection.readyState).toBe(0);
        await expect(connect(port, { user })).rejects.toBeTruthy();
    });
});

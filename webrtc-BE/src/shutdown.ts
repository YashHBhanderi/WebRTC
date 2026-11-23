import http from "http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { safeError } from "./utils/safe-log";

/**
 * Graceful shutdown (SIGTERM from systemd / pm2 / docker, SIGINT locally):
 *   1. stop timers (meeting reminders)
 *   2. close Socket.IO: disconnects clients (they reconnect to the next instance) and stops the
 *      HTTP server from accepting new connections; in-flight HTTP requests may finish
 *   3. wait briefly for disconnect handlers (presence offline, call cleanup) to write
 *   4. close the mediasoup worker (all routers / transports / producers / consumers)
 *   5. disconnect MongoDB
 * Forced exit after SHUTDOWN_TIMEOUT_MS (default 15 s) if something hangs.
 *
 * Live recordings are NOT finalised on shutdown (FFmpeg processing can take minutes); on the next
 * start recoverOnStartup() marks them failed. Drain traffic before restarting during meetings.
 */
export interface ShutdownDeps {
    server: http.Server;
    io: () => Server;
    stopTimers: () => void;
    closeMedia: () => void;
    /** Wait after closing sockets so their disconnect handlers can finish (default 750 ms) */
    settleMs?: number;
}

export function createShutdown(deps: ShutdownDeps, log: (msg: string) => void = console.log) {
    let running: Promise<void> | null = null;
    return (signal: string): Promise<void> => {
        if (running) return running;
        running = (async () => {
            log(`[shutdown] ${signal} received, shutting down`);
            deps.stopTimers();
            await new Promise<void>((resolve) => {
                try {
                    deps.io().close(() => resolve());
                } catch {
                    // Socket.IO not started: close the HTTP server directly
                    deps.server.close(() => resolve());
                }
            });
            // Disconnect handlers (presence offline, call cleanup) write to MongoDB asynchronously:
            // give them a moment before the database closes
            await new Promise((r) => setTimeout(r, deps.settleMs ?? 750));
            deps.closeMedia();
            await mongoose.disconnect().catch(() => undefined);
            log("[shutdown] done");
        })();
        return running;
    };
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
    const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0 ? Number(process.env.SHUTDOWN_TIMEOUT_MS) : 15_000;
    const shutdown = createShutdown(deps);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.once(signal, () => {
            const force = setTimeout(() => {
                console.error(`[shutdown] still running after ${timeoutMs} ms, forcing exit`);
                process.exit(1);
            }, timeoutMs);
            force.unref();
            shutdown(signal).then(() => process.exit(0), (error) => {
                console.error("[shutdown] failed:", safeError(error));
                process.exit(1);
            });
        });
    }
}

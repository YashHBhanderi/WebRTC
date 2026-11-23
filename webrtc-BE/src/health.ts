import { Request, Response } from "express";
import mongoose from "mongoose";
import { clusterProblems } from "./realtime/cluster";
import { lastClockReading } from "./config/clock";

/**
 * Load-balancer probes (no authentication, no internal details beyond short reason codes).
 *   GET /health/live   the process is up
 *   GET /health/ready  it should receive traffic: database connected, not shutting down, and not
 *                      running beside other instances without a shared Socket.IO adapter
 */
let shuttingDown = false;

export function markShuttingDown(): void {
    shuttingDown = true;
}

export function readinessProblems(): string[] {
    const problems: string[] = [];
    if (shuttingDown) problems.push("shutting down");
    if (mongoose.connection.readyState !== 1) problems.push("database not connected");
    problems.push(...clusterProblems());
    return problems;
}

export function liveness(_req: Request, res: Response): void {
    res.json({ status: "ok" });
}

export function readiness(_req: Request, res: Response): void {
    const problems = readinessProblems();
    // Clock drift is reported, not used to fail readiness (it usually affects every host at once)
    const clock = lastClockReading();
    res.status(problems.length ? 503 : 200).json({ status: problems.length ? "not-ready" : "ready", problems, clock: clock ? { level: clock.level, offsetMs: clock.offsetMs, at: clock.at } : null });
}

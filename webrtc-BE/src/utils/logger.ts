import { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";

const COLORS = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    red: "\x1b[31m"
};

const getISTTimestamp = (): string => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);

    return istTime.toISOString().replace('T', ' ').split('.')[0];
};


const logsDir = path.join(__dirname, "..", "..", "logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

export const logger = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    const start = Date.now();

    res.on("finish", () => {
        const duration = Date.now() - start;
        const timestamp = getISTTimestamp();

        let color = COLORS.green;
        if (res.statusCode >= 500) color = COLORS.red;
        else if (res.statusCode >= 400) color = COLORS.yellow;
        else if (res.statusCode >= 300) color = COLORS.cyan;

        const logLine = `[${timestamp}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration} ms - IP: ${req.ip || req.connection.remoteAddress} - Host: ${req.headers.host}`;

        console.log(`${color}${logLine}${COLORS.reset}`);
        const logLineWithNewline = logLine + "\n";

        const dateStr = new Date().toISOString().split("T")[0];
        const logFilePath = path.join(logsDir, `${dateStr}.log`);

        fs.appendFile(logFilePath, logLineWithNewline, (error) => {
            if (error) console.error("Failed to write log:", error)
        });
    });

    next();
};

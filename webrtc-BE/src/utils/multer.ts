import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import multer from "multer";
import { NextFunction, Request, Response } from "express";
import { MAX_UPLOAD_BYTES } from "../services/file.service";

/**
 * Single multer setup for every upload route. Files are spooled to a temp directory (not RAM),
 * streamed to S3 by file.service, and the temp file is always removed afterwards.
 * Per-type size/format rules are enforced in file.service; this is only the outer cap.
 */
const tempDir = path.join(os.tmpdir(), "chat-app-uploads");

const uploader = multer({
    storage: multer.diskStorage({
        // Re-created on demand: OS temp cleaners may remove it while the server is running
        destination: (_req, _file, cb) => {
            fs.promises.mkdir(tempDir, { recursive: true }).then(() => cb(null, tempDir), (error) => cb(error, tempDir));
        },
        filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 },
});

/** multer.single() with JSON errors (413 for oversized files) instead of an HTML error page. */
export function uploadSingle(field: string) {
    const handler = uploader.single(field);
    return (req: Request, res: Response, next: NextFunction) => {
        handler(req, res, (error: unknown) => {
            if (!error) {
                next();
                return;
            }
            const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
            if (!(error instanceof multer.MulterError)) {
                console.error("Upload could not be received:", error);
            }
            const message = tooLarge
                ? `File is too large (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`
                : error instanceof multer.MulterError
                    ? `Upload rejected: ${error.message}`
                    : "Upload failed";
            res.status(tooLarge ? 413 : error instanceof multer.MulterError ? 400 : 500).json({ status: false, data: null, message });
        });
    };
}

/** Remove a spooled upload; safe to call more than once. */
export async function discardTempFile(file: Express.Multer.File | undefined): Promise<void> {
    if (file?.path) {
        await fs.promises.rm(file.path, { force: true }).catch(() => undefined);
    }
}

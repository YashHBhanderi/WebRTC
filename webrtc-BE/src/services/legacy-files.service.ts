import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Request, Response } from "express";

/**
 * Legacy local uploads (files written to disk before object storage existed).
 *
 * They used to be served by a public `express.static("/uploads")` — anyone with (or guessing) a
 * file name could download private attachments. Now:
 *   - nothing is served without a valid, unexpired HMAC signature for that exact file name;
 *   - signed links are only produced when a message that references the file is returned to a
 *     user who is allowed to read that message (see messageMedia in file.service.ts);
 *   - links expire (LEGACY_FILE_URL_TTL_SECONDS, default 900 s) — like S3 presigned URLs, a link is
 *     a bearer credential until then.
 * Files are never deleted or modified here.
 *
 *   LEGACY_UPLOADS_DIR       directory of the old files (default: src/uploads next to this code)
 *   LEGACY_FILES_SECRET      HMAC key (32+ chars). Required in production; shared by all instances.
 *   LEGACY_FILE_URL_TTL_SECONDS  link lifetime (60–3600, default 900)
 */
const NAME = /^[^/\\\0]{1,255}$/;
let ephemeralSecret: string | null = null;

function secret(): string {
    const configured = process.env.LEGACY_FILES_SECRET;
    if (configured && configured.length >= 32) {
        return configured;
    }
    if (process.env.NODE_ENV === "production") {
        throw new Error("LEGACY_FILES_SECRET (32+ characters) must be set in production");
    }
    // Development: per-process key (links stop working after a restart / on other instances)
    ephemeralSecret = ephemeralSecret || crypto.randomBytes(32).toString("hex");
    return ephemeralSecret;
}

export function legacyDir(): string {
    return path.resolve(process.env.LEGACY_UPLOADS_DIR || path.join(__dirname, "..", "uploads"));
}

function ttlSeconds(): number {
    const n = Number(process.env.LEGACY_FILE_URL_TTL_SECONDS);
    return Number.isFinite(n) ? Math.min(3600, Math.max(60, Math.floor(n))) : 900;
}

function signature(name: string, exp: number): string {
    return crypto.createHmac("sha256", secret()).update(`legacy-file\n${name}\n${exp}`).digest("base64url");
}

/** File name referenced by a legacy `/uploads/<name>` link (absolute or relative), or null. */
export function legacyNameFromUrl(url: string | undefined | null): string | null {
    if (!url || typeof url !== "string") return null;
    const match = /(?:^|\/\/[^/]+|^)\/(?:api\/)?uploads\/([^?#]+)/.exec(url);
    if (!match) return null;
    let name: string;
    try {
        name = decodeURIComponent(match[1]);
    } catch {
        return null;
    }
    return NAME.test(name) && name !== "." && name !== ".." ? name : null;
}

/** Short-lived signed link for a legacy file, keeping the original URL's origin / prefix. */
export function signLegacyUrl(originalUrl: string, nowMs = Date.now()): string | null {
    const name = legacyNameFromUrl(originalUrl);
    if (!name) return null;
    const exp = Math.floor(nowMs / 1000) + ttlSeconds();
    const base = originalUrl.split(/[?#]/)[0];
    return `${base}?exp=${exp}&sig=${signature(name, exp)}`;
}

/** GET /uploads/:name — only with a valid signature; everything else is an indistinguishable 404. */
export function serveLegacyFile(req: Request, res: Response): void {
    const notFound = () => {
        res.status(404).json({ success: false, message: "Not found" });
    };
    const name = String(req.params.name || "");
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (!NAME.test(name) || !Number.isInteger(exp) || !sig || exp < Math.floor(Date.now() / 1000)) {
        return notFound();
    }
    let expected: Buffer;
    let given: Buffer;
    try {
        expected = Buffer.from(signature(name, exp));
        given = Buffer.from(sig);
    } catch {
        return notFound();
    }
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return notFound();
    }
    const dir = legacyDir();
    const file = path.resolve(dir, name);
    // Defence against traversal even though the name can't contain separators; lstat so a symlink
    // placed in the directory cannot expose a file outside it
    if (path.dirname(file) !== dir || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) {
        return notFound();
    }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Never render active content inline from this origin
    if (!/\.(jpe?g|jfif|png|gif|webp|mp4|webm|mp3|m4a|ogg)$/i.test(name)) {
        res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\w.\- ]+/g, "_")}"`);
    }
    res.sendFile(file, { dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) notFound();
    });
}

/**
 * Safe configuration check for LEGACY_UPLOADS_DIR: never lists, reads, moves or deletes files.
 * Only stats the directory itself and checks read access. Messages never include the path.
 */
export function legacyDirProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    const dir = path.resolve(env.LEGACY_UPLOADS_DIR || path.join(__dirname, "..", "uploads"));
    if (!env.LEGACY_UPLOADS_DIR && env.NODE_ENV === "production") return ["LEGACY_UPLOADS_DIR is not set (the default inside the app directory is used)"];
    if (path.parse(dir).root === dir) return ["LEGACY_UPLOADS_DIR must not be a filesystem root"];
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); } catch { return ["LEGACY_UPLOADS_DIR does not exist"]; }
    if (stat.isSymbolicLink()) return ["LEGACY_UPLOADS_DIR must not be a symlink (point it at the real directory)"];
    if (!stat.isDirectory()) return ["LEGACY_UPLOADS_DIR is not a directory"];
    try { fs.accessSync(dir, fs.constants.R_OK); } catch { return ["LEGACY_UPLOADS_DIR is not readable by the server user"]; }
    return [];
}

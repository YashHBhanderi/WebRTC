import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import mongoose from "mongoose";
import connectDB from "../config/database";
import User from "../models/userModel";
import Conversation from "../models/conversationModel";
import Message from "../models/messageModel";
import { MediaKind, MEDIA_RULES, storeUpload, UploadTarget } from "../services/file.service";
import { compatibleMimeTypes, readHead } from "../utils/file-signature";

/**
 * One-off copy of media that still lives at external URLs (the former Cloudinary uploads) into
 * S3, then links each document to its stored copy. Manual only — never runs at server start.
 *
 *   npm run migrate:media             dry run: lists what would be copied, changes nothing
 *   npm run migrate:media -- --apply  copy + update the database
 *
 * Safe to re-run: only documents without a stored file are picked up. Messages keep their old
 * fileUrl as a fallback; users/groups get their avatar URL replaced by the stored copy's link.
 * The source files are not deleted (that is a manual step once the copy is verified).
 */
const APPLY = process.argv.includes("--apply");
const EXTERNAL = /^https?:\/\//i;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_BYTES = 100 * 1024 * 1024;

interface Totals { found: number; copied: number; failed: number }
const totals: Record<string, Totals> = {};
const tally = (bucket: string, field: keyof Totals) => {
    totals[bucket] ??= { found: 0, copied: 0, failed: 0 };
    totals[bucket][field] += 1;
};

/** Download to a temp file and present it like a multer upload, typed by its content. */
async function download(url: string, allowed: string[]): Promise<Express.Multer.File> {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
    }
    const tempPath = path.join(os.tmpdir(), `legacy-media-${crypto.randomUUID()}`);
    let size = 0;
    const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            cb(size > MAX_BYTES ? new Error("file too large") : null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(response.body as never), limit, fs.createWriteStream(tempPath));
        const sniffed = compatibleMimeTypes(await readHead(tempPath));
        const mimetype = allowed.find((t) => sniffed.has(t));
        if (!mimetype) {
            throw new Error("unrecognised or unsupported content");
        }
        const originalname = decodeURIComponent(path.basename(new URL(url).pathname)) || "file";
        return { path: tempPath, size, mimetype, originalname } as Express.Multer.File;
    } catch (error) {
        await fs.promises.rm(tempPath, { force: true });
        throw error;
    }
}

async function copy(bucket: string, label: string, url: string, allowed: string[], target: UploadTarget, ownerId: string, save: (stored: Awaited<ReturnType<typeof storeUpload>>) => Promise<unknown>) {
    tally(bucket, "found");
    if (!APPLY) {
        console.log(`[dry-run] ${bucket} ${label}: ${url}`);
        return;
    }
    try {
        const file = await download(url, allowed);
        const result = await storeUpload(file, target, ownerId);
        await save(result);
        tally(bucket, "copied");
        console.log(`[copied] ${bucket} ${label} → ${result.stored.storageKey}`);
    } catch (error) {
        tally(bucket, "failed");
        console.warn(`[failed] ${bucket} ${label} (${url}): ${error instanceof Error ? error.message : error}`);
    }
}

async function run(): Promise<void> {
    const imageTypes = Object.keys(MEDIA_RULES.image.types);

    for await (const user of User.find({ avatar: EXTERNAL, avatarFile: { $exists: false } }).select("avatar").cursor()) {
        const id = String(user._id);
        await copy("users", id, user.avatar, imageTypes, { purpose: "avatar", userId: id }, id, ({ stored }) =>
            User.updateOne({ _id: user._id, avatarFile: { $exists: false } }, { $set: { avatar: stored.storageKey, avatarFile: stored } }));
    }

    for await (const group of Conversation.find({ isGroup: true, groupAvatar: EXTERNAL, groupAvatarFile: { $exists: false } }).select("groupAvatar groupAdmin").cursor()) {
        const id = String(group._id);
        await copy("groups", id, group.groupAvatar!, imageTypes, { purpose: "group-avatar", groupId: id }, String(group.groupAdmin || id), ({ stored }) =>
            Conversation.updateOne({ _id: group._id, groupAvatarFile: { $exists: false } }, { $set: { groupAvatar: stored.storageKey, groupAvatarFile: stored } }));
    }

    const media = Object.keys(MEDIA_RULES) as MediaKind[];
    const cursor = Message.find({ type: { $in: media }, fileUrl: EXTERNAL, file: { $exists: false }, isDeleted: { $ne: true }, conversationId: { $exists: true } })
        .select("type fileUrl userId conversationId")
        .cursor();
    for await (const message of cursor) {
        const kind = message.type as MediaKind;
        await copy("messages", String(message._id), message.fileUrl, Object.keys(MEDIA_RULES[kind].types),
            { purpose: "message", conversationId: String(message.conversationId) }, String(message.userId),
            // Allowed types are this kind's only, so the stored kind always matches the message type
            ({ stored }) => Message.updateOne({ _id: message._id, file: { $exists: false } }, { $set: { file: stored } }));
    }

    console.log(`\n${APPLY ? "Copied" : "Dry run — would copy"}:`);
    console.table(totals);
    if (!APPLY) {
        console.log("Re-run with --apply to copy these files into S3.");
    }
}

connectDB()
    .then(run)
    .then(() => mongoose.disconnect())
    .catch(async (error) => {
        console.error("[migrate:media] failed:", error);
        await mongoose.disconnect().catch(() => undefined);
        process.exit(1);
    });

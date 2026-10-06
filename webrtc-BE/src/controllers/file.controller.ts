import { Request, Response } from "express";
import { isManagedKey, isPublicKey, storageRedirect, verifySignedFileUrl } from "../services/file.service";
import { AppError, publicMessage } from "../utils/errors";

/**
 * GET /files/{key} — the only way clients read stored files. Works from <img>/<video> tags
 * (no Authorization header), so access is proven by the link itself:
 *   profile/group pictures  unguessable key, no signature needed
 *   chat attachments        ?exp&sig issued only to conversation members, expires
 * Responds with a redirect to a short-lived S3 pre-signed URL; the bucket stays private.
 */
export default async function serveFile(req: Request, res: Response): Promise<void> {
    const key = String(req.params[0] || "");
    if (!isManagedKey(key)) {
        res.status(404).json({ status: false, data: null, message: "File not found" });
        return;
    }
    if (!isPublicKey(key) && !verifySignedFileUrl(key, req.query.exp, req.query.sig)) {
        res.status(403).json({ status: false, data: null, message: "This link has expired or is invalid" });
        return;
    }
    try {
        const { url, cacheSeconds } = await storageRedirect(key);
        res.set("Cache-Control", `private, max-age=${cacheSeconds}`);
        res.redirect(302, url);
    } catch (error) {
        res.status(error instanceof AppError ? error.status : 500).json({ status: false, data: null, message: publicMessage(error, "File unavailable") });
    }
}

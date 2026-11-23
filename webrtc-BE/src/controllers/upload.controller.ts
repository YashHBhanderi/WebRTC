import { assertExternalAllowed } from "../tenancy/tenant.service";
import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import blockService from "../services/block.service";
import { directPeerId, getConversationForMember, getGroupForAdmin } from "../services/authorization.service";
import { storeEncryptedUpload, storeUpload, UploadTarget } from "../services/file.service";
import { discardTempFile } from "../utils/multer";
import { AppError, ForbiddenError, publicMessage } from "../utils/errors";
import { safeError } from "../utils/safe-log";

/**
 * POST /upload (multipart: file, purpose, conversationId | groupId). Requires a logged-in user.
 *   purpose=message       chat attachment for a conversation the user belongs to
 *   purpose=group-avatar  new photo for a group the user administers
 * Returns the storage key the client sends back with sendMessage / group:update, plus what to
 * preview it with: a pre-signed URL for an attachment, the key itself for a group photo (public
 * object, the client prefixes its S3 base URL). Profile pictures go through PATCH /web/user/profile instead.
 */
export default async function uploadFile(req: Request, res: Response) {
    const userId = String((req as CustomRequest).userId);
    try {
        const purpose = req.body?.purpose || "message";
        let target: UploadTarget;
        if (purpose === "message") {
            const conversation = await getConversationForMember(req.body?.conversationId, userId);
            const peerId = directPeerId(conversation, userId);
            if (peerId && (await blockService.isBlockedEitherWay(userId, peerId))) {
                throw new ForbiddenError("You can't send files in this chat");
            }
            await assertExternalAllowed(conversation._id, "file");
            // Mandatory end-to-end encryption: chat attachments arrive as ciphertext only
            if (req.body?.encrypted !== "1") throw new AppError("Attachments must be end-to-end encrypted", 400);
            const { stored, kind } = await storeEncryptedUpload(req.file, String(conversation._id), req.body?.kind, userId);
            res.status(200).json({ storageKey: stored.storageKey, type: kind, size: stored.size, encrypted: true });
            return;
        } else if (purpose === "group-avatar") {
            const group = await getGroupForAdmin(req.body?.groupId, userId);
            target = { purpose, groupId: String(group._id) };
        } else {
            throw new AppError("Unknown upload purpose");
        }

        const { stored, kind } = await storeUpload(req.file, target, userId);
        // Group photo (public object): the client prefixes its storage base URL
        const url = stored.storageKey;
        res.status(200).json({
            storageKey: stored.storageKey,
            fileUrl: url,
            thumbnailUrl: url,
            type: kind,
            mimeType: stored.mimeType,
            originalName: stored.originalName,
            size: stored.size,
        });
    } catch (error) {
        await discardTempFile(req.file);
        if (!(error instanceof AppError)) {
            console.error("Upload failed:", safeError(error));
        }
        res.status(error instanceof AppError ? error.status : 500).json({ status: false, data: null, message: publicMessage(error, "Upload failed") });
    }
}

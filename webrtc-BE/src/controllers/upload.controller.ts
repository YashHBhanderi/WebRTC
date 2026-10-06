import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import blockService from "../services/block.service";
import { directPeerId, getConversationForMember, getGroupForAdmin } from "../services/authorization.service";
import { publicFileUrl, signedFileUrl, storeUpload, UploadTarget } from "../services/file.service";
import { discardTempFile } from "../utils/multer";
import { AppError, ForbiddenError, publicMessage } from "../utils/errors";

/**
 * POST /upload (multipart: file, purpose, conversationId | groupId). Requires a logged-in user.
 *   purpose=message       chat attachment for a conversation the user belongs to
 *   purpose=group-avatar  new photo for a group the user administers
 * Returns the storage key the client sends back with sendMessage / group:update, plus a URL for
 * an immediate preview. Profile pictures go through PATCH /web/user/profile instead.
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
            target = { purpose, conversationId: String(conversation._id) };
        } else if (purpose === "group-avatar") {
            const group = await getGroupForAdmin(req.body?.groupId, userId);
            target = { purpose, groupId: String(group._id) };
        } else {
            throw new AppError("Unknown upload purpose");
        }

        const { stored, kind } = await storeUpload(req.file, target, userId);
        const url = target.purpose === "message" ? signedFileUrl(stored.storageKey) : publicFileUrl(stored.storageKey);
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
            console.error("Upload failed:", error);
        }
        res.status(error instanceof AppError ? error.status : 500).json({ status: false, data: null, message: publicMessage(error, "Upload failed") });
    }
}

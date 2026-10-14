import { Request, Response } from "express";
import MessageService from "../services/message.service";
import CustomRequest from "../types/customRequest";
import { sendError } from "../utils/errors";
import Conversation from "../models/conversationModel";
import messageActions from "../services/message-actions.service";
import { emitToUsers } from "../realtime/io";

export default class MessageController {
    public static async deleteMessage(req: Request, res: Response): Promise<void> {
        try {
            const { messageId } = req.params;
            const userId = (req as CustomRequest).userId;

            const result = await MessageService.deleteMessageById(messageId, userId!);
            if (result.conversationId) {
                // Gone for everyone right away (and no longer pinned)
                await messageActions.unpinDeleted(result.conversationId, messageId);
                const conversation = await Conversation.findById(result.conversationId).select("members").lean();
                emitToUsers(conversation?.members, "message:deleted", { conversationId: result.conversationId, messageId });
                emitToUsers(conversation?.members, "message:pins", {
                    conversationId: result.conversationId,
                    pins: await messageActions.pins(result.conversationId),
                });
            }
            res.status(200).json({ status: result.success, data: null, message: 'Message deleted' });
        } catch (error) {
            sendError(res, error, "We couldn't delete the message. Please try again.");
        }
    };

    /** PUT /messages/:messageId/save  { saved: boolean } */
    public static async setSaved(req: Request, res: Response): Promise<void> {
        try {
            const data = await messageActions.setSaved(req.params.messageId, String((req as CustomRequest).userId), req.body?.saved !== false);
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't save the message. Please try again.");
        }
    }

    /** GET /saved-messages?before= */
    public static async listSaved(req: Request, res: Response): Promise<void> {
        try {
            const data = await messageActions.listSaved(String((req as CustomRequest).userId), req.query.before, Number(req.query.limit) || undefined);
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load your saved messages. Please try again.");
        }
    }
}

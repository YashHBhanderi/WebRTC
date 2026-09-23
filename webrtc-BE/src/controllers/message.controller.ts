import { Request, Response } from "express";
import MessageService from "../services/message.service";
import CustomRequest from "../types/customRequest";

export default class MessageController {
    public static async deleteMessage(req: Request, res: Response): Promise<void> {
        try {
            const { messageId } = req.params;
            const userId = (req as CustomRequest).userId;

            const result = await MessageService.deleteMessageById(messageId, userId!);
            res.status(200).json({ status: result.success, data: null, message: 'Messgae deleted successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    };
}

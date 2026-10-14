import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import notificationService from "../services/notification.service";
import { sendError } from "../utils/errors";

const uid = (req: Request) => String((req as CustomRequest).userId);

export default class NotificationController {
    /** GET /notifications?before=&limit= */
    static async list(req: Request, res: Response): Promise<void> {
        try {
            const data = await notificationService.list(uid(req), req.query.before, Number(req.query.limit) || undefined, req.query.view);
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load your activity. Please try again.");
        }
    }

    /** GET /notifications/unread-count */
    static async unreadCount(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json({ status: true, data: { unread: await notificationService.unreadCount(uid(req)) }, message: "" });
        } catch (error) {
            sendError(res, error);
        }
    }

    /** POST /notifications/read  { ids?: string[] }  (no ids = all) */
    static async markRead(req: Request, res: Response): Promise<void> {
        try {
            const updated = await notificationService.markRead(uid(req), req.body?.ids);
            res.status(200).json({ status: true, data: { updated }, message: "" });
        } catch (error) {
            sendError(res, error);
        }
    }
}

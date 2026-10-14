import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import callHistory from "../services/call-history.service";
import { sendError } from "../utils/errors";

export default class CallHistoryController {
    /** GET /calls?filter=missed&before=&limit= */
    static async list(req: Request, res: Response): Promise<void> {
        try {
            const data = await callHistory.list(String((req as CustomRequest).userId), {
                before: req.query.before,
                filter: req.query.filter,
                limit: Number(req.query.limit) || undefined,
            });
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load your calls. Please try again.");
        }
    }
}

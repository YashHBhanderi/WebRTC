import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import meetingService from "../services/meeting.service";
import { sendError } from "../utils/errors";

const uid = (req: Request) => String((req as CustomRequest).userId);
const ok = (res: Response, data: unknown) => res.status(200).json({ status: true, data, message: "" });

export default class MeetingController {
    /** GET /meetings?from=&to= — occurrences in a range (calendar) */
    static async range(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.range(uid(req), req.query.from, req.query.to));
        } catch (error) {
            sendError(res, error, "We couldn't load your calendar. Please try again.");
        }
    }

    /** POST /meetings */
    static async create(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.create(uid(req), req.body || {}));
        } catch (error) {
            sendError(res, error, "We couldn't create the meeting. Please try again.");
        }
    }

    /** GET /meetings/:id */
    static async get(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.get(req.params.id, uid(req)));
        } catch (error) {
            sendError(res, error, "We couldn't load the meeting. Please try again.");
        }
    }

    /** PATCH /meetings/:id (organizer) */
    static async update(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.update(req.params.id, uid(req), req.body || {}));
        } catch (error) {
            sendError(res, error, "We couldn't update the meeting. Please try again.");
        }
    }

    /** DELETE /meetings/:id?occurrence= (organizer) — whole series or one occurrence */
    static async cancel(req: Request, res: Response): Promise<void> {
        try {
            await meetingService.cancel(req.params.id, uid(req), req.query.occurrence);
            ok(res, null);
        } catch (error) {
            sendError(res, error, "We couldn't cancel the meeting. Please try again.");
        }
    }

    /** GET /meetings/code/:code — what a join link shows */
    static async preview(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.preview(req.params.code, uid(req)));
        } catch (error) {
            sendError(res, error, "We couldn't find that meeting.");
        }
    }

    /** POST /meetings/code/:code/join { password? } */
    static async join(req: Request, res: Response): Promise<void> {
        try {
            ok(res, await meetingService.joinByCode(req.params.code, uid(req), req.body?.password));
        } catch (error) {
            sendError(res, error, "We couldn't join the meeting. Please try again.");
        }
    }
}

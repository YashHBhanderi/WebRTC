import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import recordingService from "../services/recording.service";
import { sendError } from "../utils/errors";

const uid = (req: Request) => String((req as CustomRequest).userId);

export default class RecordingController {
    /** GET /recordings/:id — details + short-lived private playback / download links */
    static async get(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json({ status: true, data: await recordingService.get(req.params.id, uid(req)), message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load the recording. Please try again.");
        }
    }

    /** GET /recordings/:id/transcript */
    static async transcript(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json({ status: true, data: await recordingService.transcript(req.params.id, uid(req)), message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load the transcript. Please try again.");
        }
    }

    /** POST /recordings/:id/transcript/retry */
    static async retryTranscript(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json({ status: true, data: await recordingService.retryTranscript(req.params.id, uid(req)), message: "Transcription started" });
        } catch (error) {
            sendError(res, error, "We couldn't retry the transcript. Please try again.");
        }
    }

    /** GET /recordings/:id/transcript/export?format=txt|srt|vtt — a download */
    static async exportTranscript(req: Request, res: Response): Promise<void> {
        try {
            const file = await recordingService.exportTranscript(req.params.id, uid(req), req.query.format);
            res.setHeader("Content-Type", file.contentType);
            res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`);
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.status(200).send(file.body);
        } catch (error) {
            sendError(res, error, "We couldn't export the transcript. Please try again.");
        }
    }

    /** GET /conversations/:conversationId/recordings */
    static async list(req: Request, res: Response): Promise<void> {
        try {
            res.status(200).json({ status: true, data: await recordingService.listForConversation(req.params.conversationId, uid(req)), message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load the recordings. Please try again.");
        }
    }
}

import { Request, Response } from "express";
import CustomRequest from "../types/customRequest";
import searchService, { SEARCH_CATEGORIES, SearchCategory } from "../services/search.service";
import { sendError } from "../utils/errors";

export default class SearchController {
    /** GET /search?q=&types=users,chats,messages,files&from=&to=&sender=&limit= */
    static async search(req: Request, res: Response): Promise<void> {
        try {
            const types = String(req.query.types || "")
                .split(",")
                .map((t) => t.trim())
                .filter((t): t is SearchCategory => (SEARCH_CATEGORIES as string[]).includes(t));
            const data = await searchService.search(String((req as CustomRequest).userId), {
                q: req.query.q,
                types,
                from: req.query.from,
                to: req.query.to,
                senderId: req.query.sender,
                limit: Number(req.query.limit) || undefined,
            });
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't complete the search. Please try again.");
        }
    }

    /** GET /files?type=image|video|audio|pdf|file&before=&limit= — files shared in my chats */
    static async files(req: Request, res: Response): Promise<void> {
        try {
            const data = await searchService.files(String((req as CustomRequest).userId), {
                kind: req.query.type,
                before: req.query.before,
                limit: Number(req.query.limit) || undefined,
            });
            res.status(200).json({ status: true, data, message: "" });
        } catch (error) {
            sendError(res, error, "We couldn't load your files. Please try again.");
        }
    }
}

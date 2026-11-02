import { Request, Response, Router } from "express";
import { requireUser } from "../middleware/authMiddleware";
import CustomRequest from "../types/customRequest";
import { sendError } from "../utils/errors";
import {
    createExternalConversation, directory, myWorkspaces, tenantSummary,
} from "../tenancy/tenant.service";
import { updateWorkspacePolicies } from "../organizations/workspace-policies";

/**
 * Workspace endpoints. The workspace is always the caller's active Clerk organization (from the
 * verified session) — no endpoint takes a tenant id, so one cannot be forged.
 */
const router = Router();
const ctx = (req: Request) => (req as CustomRequest).ctx!;

const handle = (fn: (req: Request) => Promise<unknown>, fallback: string) => async (req: Request, res: Response) => {
    try {
        res.status(200).json({ status: true, data: await fn(req), message: "" });
    } catch (error) {
        sendError(res, error, fallback);
    }
};

/** Active workspace: name, my role, policies and what I may change */
router.get("/tenant/current", requireUser("organizations:read"), handle((req) => tenantSummary(ctx(req)), "We couldn't load the workspace."));

/** Owner / admin: switch external chat, calls, files and who may start external chats */
router.patch("/tenant/current/policies", requireUser("organizations:manage"), handle((req) => updateWorkspacePolicies(ctx(req), req.body), "We couldn't update the workspace policies."));

/** Workspaces I've used (switching happens in Clerk; the new session token carries the org) */
router.get("/tenant/workspaces", requireUser("organizations:read"), handle((req) => myWorkspaces(ctx(req)), "We couldn't load your workspaces."));

/** People I can start a conversation with in the active context */
router.get("/directory", requireUser("directory:read"), handle((req) => directory(ctx(req), { q: req.query.q }), "We couldn't load the people list."));

/** Start (or reopen) an external 1:1 chat with someone outside the workspace (policy-gated) */
router.post("/tenant/external-conversations", requireUser("conversations:write"), handle(async (req) => {
    const conversation = await createExternalConversation(ctx(req), req.body?.userId);
    return { conversationId: String(conversation._id), scope: "external" };
}, "We couldn't start the external chat."));

export default router;

import mongoose from "mongoose";
import User from "../models/userModel";
import TenantMembership from "../models/tenantMembershipModel";
import Conversation from "../models/conversationModel";
import { RequestContext, runAsSystem, runWithContext } from "../tenancy/context";
import { can, createExternalConversation, guestContacts, isGuest, policiesOf } from "../tenancy/tenant.service";
import ConversationService from "../services/conversationService";
import blockService from "../services/block.service";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";

/**
 * Finding a person to talk to — by exact email, never by browsing a directory.
 *
 *   personal context        eligible SpreeWe accounts (not blocked either way, not opted out of
 *                           being found: User.globalDiscoverable)
 *   organization, "member"  active members of the verified active organization (guests: only people
 *                           they already share a conversation with)
 *   organization, "external" people outside it — only when the organization's policy allows the
 *                           caller to start external conversations; same eligibility as personal
 *
 * Every refusal about the RECIPIENT (unregistered, blocked, opted out, deleted, not a member) gets the
 * same answer, so a lookup can't tell "not registered" from "registered but unavailable". Lookups are
 * rate-limited per user. Starting a chat re-runs the lookup on the server: the client never supplies
 * the recipient's id.
 */
export type ContactScope = "member" | "external";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const NOT_FOUND_MESSAGE = "No eligible account found for this email.";

const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));

// ------------------------------------------------------------------ rate limit (per user, per instance)

const WINDOW_MS = 10 * 60_000;
const lookups = new Map<string, number[]>();

export function lookupLimit(): number {
    const n = Number(process.env.CONTACT_LOOKUP_PER_10MIN);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

function takeLookup(userId: string): void {
    const now = Date.now();
    const recent = (lookups.get(userId) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= lookupLimit()) {
        throw new AppError("Too many lookups. Please wait a few minutes and try again.", 429);
    }
    recent.push(now);
    lookups.set(userId, recent);
}

/** Tests only. */
export function resetLookupLimits(): void {
    lookups.clear();
}

// ------------------------------------------------------------------ lookup

export interface ContactLookup {
    found: boolean;
    message?: string;
    user?: { _id: string; username: string; avatar: string };
    /** The conversation would be (or is) an external one */
    external?: boolean;
    /** Already talking: the existing direct conversation */
    conversationId?: string | null;
}

export function normalizeEmail(raw: unknown): string {
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL.test(email)) {
        throw new AppError("Enter a valid email address");
    }
    return email;
}

async function eligibleRecipient(ctx: RequestContext, email: string, scope: ContactScope): Promise<{ user: { _id: unknown; username: string; avatar?: string }; external: boolean } | null> {
    // SpreeWe accounts are found by their account email; an application's users only by the email that
    // application supplied, and only inside its own tenant
    const who = ctx.realm ? { tenantId: oid(ctx.realm), contactEmail: email, deactivatedAt: null } : { email, tenantId: null };
    const user = await runAsSystem(() => User.findOne(who).select("_id username avatar globalDiscoverable clerkDeletedAt clerkBanned").lean(), "contact-lookup");
    if (!user || user.clerkDeletedAt || user.clerkBanned || String(user._id) === String(ctx.userId)) return null;
    if (await blockService.isBlockedEitherWay(String(ctx.userId), String(user._id))) return null;

    if (!ctx.tenantId) {
        return user.globalDiscoverable === false ? null : { user, external: false };
    }
    const member = await runAsSystem(() => TenantMembership.exists({ tenantId: oid(ctx.tenantId), userId: user._id, status: "active" }), "contact-lookup");
    if (scope === "member" || member) {
        // Inside the organization: members only; guests only reach people they already share a conversation with
        if (!member) return null;
        if (isGuest(ctx) && !(await guestContacts(ctx)).some((id) => String(id) === String(user._id))) return null;
        return { user, external: false };
    }
    return user.globalDiscoverable === false ? null : { user, external: true };
}

async function existingDirect(ctx: RequestContext, otherId: unknown): Promise<string | null> {
    // Read in the caller's context: only a conversation visible here counts
    const c = await runWithContext(ctx, () => Conversation.findOne({ isGroup: false, members: { $all: [oid(ctx.userId), oid(otherId)], $size: 2 } }).select("_id").lean());
    return c ? String(c._id) : null;
}

async function assertExternalAllowed(ctx: RequestContext): Promise<void> {
    if (!ctx.tenantId) throw new AppError("External contacts exist only in an organization", 400);
    const policies = await policiesOf(ctx.tenantId);
    if (!can(ctx, "external:start", policies)) {
        throw new ForbiddenError(policies.allowExternalChat
            ? "Only owners and admins can start external conversations in this organization."
            : "This organization's policy does not permit starting external conversations.");
    }
}

export async function lookupContact(ctx: RequestContext, input: { email: unknown; scope?: ContactScope }): Promise<ContactLookup> {
    const scope: ContactScope = input.scope === "external" ? "external" : "member";
    const email = normalizeEmail(input.email);
    if (scope === "external") await assertExternalAllowed(ctx);
    takeLookup(String(ctx.userId));
    const hit = await eligibleRecipient(ctx, email, scope);
    if (!hit) return { found: false, message: NOT_FOUND_MESSAGE };
    return {
        found: true,
        user: { _id: String(hit.user._id), username: hit.user.username, avatar: hit.user.avatar || "" },
        external: hit.external,
        conversationId: hit.external ? null : await existingDirect(ctx, hit.user._id),
    };
}

/** Open (or reuse) a direct conversation with the person behind this email, re-checking eligibility. */
export async function startConversation(ctx: RequestContext, input: { email: unknown; scope?: ContactScope }): Promise<{ conversationId: string; external: boolean }> {
    const scope: ContactScope = input.scope === "external" ? "external" : "member";
    const email = normalizeEmail(input.email);
    if (scope === "external") await assertExternalAllowed(ctx);
    takeLookup(String(ctx.userId));
    const hit = await eligibleRecipient(ctx, email, scope);
    if (!hit) throw new NotFoundError(NOT_FOUND_MESSAGE);
    if (hit.external) {
        const conversation = await createExternalConversation(ctx, String(hit.user._id));
        return { conversationId: String(conversation._id), external: true };
    }
    const conversation = await runWithContext(ctx, () => ConversationService.createOrGetConversation(String(ctx.userId), String(hit.user._id)));
    return { conversationId: String(conversation._id), external: false };
}

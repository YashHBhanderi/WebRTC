import { clerkClient } from "@clerk/express";
import User from "../models/userModel";
import { AppError, ForbiddenError } from "../utils/errors";
import { USERNAME_MAX, USERNAME_MIN } from "./userServices";

/**
 * Maps a Clerk user (session `sub`, e.g. "user_2abc…") to this app's MongoDB user, whose `_id`
 * every chat, message and call refers to. On first sign-in the user is linked to the existing
 * account with the same verified email, or a new account is created. Only verified emails are
 * linked, so nobody can take over an account by signing up with someone else's address.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { userId: string; at: number }>();
const inFlight = new Map<string, Promise<string>>();

export async function resolveLocalUserId(clerkUserId: string): Promise<string> {
    const hit = cache.get(clerkUserId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return hit.userId;
    }
    // Parallel first requests from one browser must not create two accounts
    let pending = inFlight.get(clerkUserId);
    if (!pending) {
        pending = lookupOrProvision(clerkUserId).finally(() => inFlight.delete(clerkUserId));
        inFlight.set(clerkUserId, pending);
    }
    const userId = await pending;
    cache.set(clerkUserId, { userId, at: Date.now() });
    return userId;
}

/** Drop a cached mapping (e.g. after the local account was deleted). */
export function forgetClerkUser(clerkUserId: string): void {
    cache.delete(clerkUserId);
}

async function lookupOrProvision(clerkUserId: string): Promise<string> {
    const linked = await User.findOne({ clerkId: clerkUserId }).select("_id").lean();
    if (linked) {
        return String(linked._id);
    }

    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const primary = clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId);
    if (!primary) {
        throw new AppError("Add an email address to your account to continue", 403);
    }
    if (primary.verification?.status !== "verified") {
        throw new AppError("Verify your email address to continue", 403);
    }
    const email = primary.emailAddress.trim().toLowerCase();

    try {
        const existing = await User.findOne({ email }).select("_id clerkId").lean();
        if (existing) {
            if (existing.clerkId && existing.clerkId !== clerkUserId) {
                throw new ForbiddenError("This email is already linked to a different sign-in");
            }
            // Link once; never overwrite a link made concurrently
            await User.updateOne({ _id: existing._id, clerkId: { $in: [null, clerkUserId] } }, { $set: { clerkId: clerkUserId } });
            return await confirmLink(clerkUserId);
        }
        const created = await User.create({
            username: displayName(clerkUser, email),
            email,
            avatar: clerkUser.hasImage ? clerkUser.imageUrl : "",
            clerkId: clerkUserId,
            isVerified: true,
        });
        return String(created._id);
    } catch (error) {
        // Another server process linked/created it at the same moment (unique email / clerkId)
        if ((error as { code?: number })?.code === 11000) {
            return confirmLink(clerkUserId);
        }
        throw error;
    }
}

async function confirmLink(clerkUserId: string): Promise<string> {
    const user = await User.findOne({ clerkId: clerkUserId }).select("_id").lean();
    if (!user) {
        throw new ForbiddenError("This email is already linked to a different sign-in");
    }
    return String(user._id);
}

/** A name that passes the app's username rules (3-30 chars, letters/digits/space . _ ' -). */
function displayName(user: { username: string | null; firstName: string | null; lastName: string | null }, email: string): string {
    const candidates = [
        user.username,
        [user.firstName, user.lastName].filter(Boolean).join(" "),
        email.split("@")[0],
    ];
    for (const raw of candidates) {
        const name = (raw || "")
            .replace(/[^\p{L}\p{M}\p{N} ._'-]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, USERNAME_MAX)
            .trim();
        if (name.length >= USERNAME_MIN) {
            return name;
        }
    }
    return "New user";
}

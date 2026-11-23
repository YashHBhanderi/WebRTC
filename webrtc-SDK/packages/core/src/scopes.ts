/**
 * Developer-app scopes, as defined by the backend (webrtc-BE/src/developer/scopes.ts). The live
 * catalogue with descriptions is GET /v1/scopes. A token carries only scopes present in the app,
 * the user's grant and the token request; the server re-checks them on every request.
 */
export const SCOPES = [
    "profile:read",
    "profile:write",
    "directory:read",
    "contacts:write",
    "conversations:read",
    "conversations:write",
    "conversations:delete",
    "groups:read",
    "groups:write",
    "groups:manage",
    "messages:read",
    "messages:react",
    "messages:delete",
    "messages:write",
    "messages:edit",
    "e2ee:device",
    "files:read",
    "files:write",
    "calls:read",
    "calls:write",
    "calls:manage",
    "meetings:read",
    "meetings:write",
    "recordings:read",
    "recordings:write",
    "notifications:read",
    "notifications:write",
    "search:read",
    "organizations:read",
    "organizations:write",
    "organizations:manage",
    "realtime:connect",
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Scopes each feature module needs, split into what it can't work without and what unlocks extra
 * actions. Use these when you register the app and when you build the OAuth `scope` parameter, so
 * you ask users only for what you integrate.
 */
export const FEATURE_SCOPES = {
    contacts: {
        required: ["realtime:connect", "directory:read", "profile:read"],
        optional: ["contacts:write", "profile:write"],
    },
    chat: {
        required: ["realtime:connect", "profile:read", "conversations:read", "groups:read", "messages:read"],
        // Sending and decrypting need the app's own encryption device (e2ee:device + messages:write)
        optional: ["e2ee:device", "messages:write", "messages:edit", "messages:react", "messages:delete", "conversations:write", "files:write", "contacts:write", "directory:read"],
    },
    groups: {
        required: ["realtime:connect", "profile:read", "groups:read"],
        optional: ["groups:write", "groups:manage", "conversations:delete", "files:write", "directory:read"],
    },
    calls: {
        required: ["realtime:connect", "profile:read", "calls:read", "calls:write"],
        optional: ["calls:manage", "recordings:read", "recordings:write"],
    },
    meetings: {
        required: ["profile:read", "meetings:read"],
        optional: ["meetings:write", "realtime:connect"],
    },
    files: {
        required: ["profile:read", "files:read"],
        optional: ["files:write", "e2ee:device"],
    },
    notifications: {
        required: ["notifications:read"],
        optional: ["notifications:write", "realtime:connect"],
    },
} as const satisfies Record<string, { required: readonly Scope[]; optional: readonly Scope[] }>;

export type FeatureName = keyof typeof FEATURE_SCOPES;

/** Union of the scopes the given features need (optionally including their optional scopes). */
export function scopesFor(features: readonly FeatureName[], opts: { includeOptional?: boolean } = {}): Scope[] {
    const out = new Set<Scope>();
    for (const f of features) {
        FEATURE_SCOPES[f].required.forEach((s) => out.add(s));
        if (opts.includeOptional) FEATURE_SCOPES[f].optional.forEach((s) => out.add(s));
    }
    return [...out];
}

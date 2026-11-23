import mongoose, { Schema } from "mongoose";

/**
 * Developer platform models. These are platform-level records (not tenant-scoped data): access is
 * checked explicitly in developer/app.service.ts (owner / tenant binding / platform admin).
 * Secrets are never stored in clear text.
 */
export type AppEnvironment = "development" | "production";
export type AppStatus = "active" | "suspended" | "revoked";

export interface AppQuotas {
    /** REST requests per minute for this app (per instance, see docs) */
    rateLimitPerMinute: number;
    /** Concurrent Socket.IO connections for this app (per instance, see docs) */
    maxConnections: number;
    /** Messages sent through this app per UTC day (global, MongoDB-backed) */
    messagesPerDay: number;
}

export interface IDeveloperApp {
    _id: mongoose.Types.ObjectId;
    name: string;
    /** Shown to the developer (and on the consent screen); plain text */
    description: string;
    /** The app's public website (absolute http(s) URL) or empty */
    websiteUrl: string;
    ownerUserId: mongoose.Types.ObjectId;
    /**
     * The only tenant this app can ever act in:
     *   dedicatedTenant true   the app's own tenant, created with the app (its users are registered
     *                          through the API and exist only there)
     *   dedicatedTenant false  an organization workspace (workspace app), or null for a legacy global
     *                          app created before dedicated tenants (consent / OAuth with SpreeWe accounts)
     */
    tenantId: mongoose.Types.ObjectId | null;
    dedicatedTenant: boolean;
    environment: AppEnvironment;
    status: AppStatus;
    /** Maximum scopes; users grant a subset, tokens carry a subset of that */
    scopes: string[];
    allowedOrigins: string[];
    /** Stored and validated; no redirect flow uses them yet */
    callbackUrls: string[];
    quotas: AppQuotas;
    /** Incremented to invalidate every token issued so far */
    tokenVersion: number;
    createdAt: Date;
    updatedAt: Date;
}

const AppSchema = new Schema<IDeveloperApp>({
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 500 },
    websiteUrl: { type: String, default: "", maxlength: 300 },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
    dedicatedTenant: { type: Boolean, default: false },
    environment: { type: String, enum: ["development", "production"], required: true },
    status: { type: String, enum: ["active", "suspended", "revoked"], default: "active" },
    scopes: { type: [String], default: [] },
    allowedOrigins: { type: [String], default: [] },
    callbackUrls: { type: [String], default: [] },
    quotas: {
        rateLimitPerMinute: { type: Number, default: 60 },
        maxConnections: { type: Number, default: 20 },
        messagesPerDay: { type: Number, default: 1000 },
    },
    tokenVersion: { type: Number, default: 1 },
}, { timestamps: true });
AppSchema.index({ ownerUserId: 1, createdAt: -1 });
AppSchema.index({ tenantId: 1 });

export const DeveloperApp = mongoose.model<IDeveloperApp>("DeveloperApp", AppSchema, "developer_apps");

// ------------------------------------------------------------------ credentials

export interface IAppCredential {
    _id: mongoose.Types.ObjectId;
    appId: mongoose.Types.ObjectId;
    /** Public identifier (safe to log): swk_test_… / swk_live_… */
    keyId: string;
    /** SHA-256 of the secret (256-bit random); the secret itself is shown once */
    secretHash: string;
    /** Last 4 characters, to help owners recognise a key */
    hint: string;
    status: "active" | "rotated" | "revoked";
    /** rotated credentials keep working until this time (rotation grace) */
    graceUntil: Date | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdBy: mongoose.Types.ObjectId;
    createdAt: Date;
}

const CredentialSchema = new Schema<IAppCredential>({
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    keyId: { type: String, required: true },
    secretHash: { type: String, required: true },
    hint: { type: String, default: "" },
    status: { type: String, enum: ["active", "rotated", "revoked"], default: "active" },
    graceUntil: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
CredentialSchema.index({ keyId: 1 }, { unique: true });
CredentialSchema.index({ appId: 1, createdAt: -1 });
CredentialSchema.set("toJSON", {
    transform: (_d: unknown, ret: Record<string, unknown>) => {
        delete ret.secretHash;
        return ret;
    },
});

export const AppCredential = mongoose.model<IAppCredential>("AppCredential", CredentialSchema, "app_credentials");

// ------------------------------------------------------------------ user grants (consent)

export interface IAppGrant {
    _id: mongoose.Types.ObjectId;
    appId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    /** Context the user granted in: the app's tenant, or null (global app) */
    tenantId: mongoose.Types.ObjectId | null;
    scopes: string[];
    /** Opaque id the integrating app uses for this user (set by the user's own consent call, or at registration) */
    externalUserRef: string | null;
    /**
     * true: the user was registered by the app in its dedicated tenant (no consent screen: the app
     * owns the account). Such a grant follows the app's scopes instead of storing its own.
     */
    managed?: boolean;
    status: "active" | "revoked";
    /** Incremented on change / revocation; tokens carry the version they were issued for */
    version: number;
    /** Last time a token was issued under this grant */
    lastUsedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const GrantSchema = new Schema<IAppGrant>({
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
    scopes: { type: [String], default: [] },
    externalUserRef: { type: String, default: null, maxlength: 200 },
    managed: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "revoked"], default: "active" },
    version: { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: null },
}, { timestamps: true });
GrantSchema.index({ appId: 1, userId: 1 }, { unique: true });
GrantSchema.index({ appId: 1, externalUserRef: 1 }, { unique: true, partialFilterExpression: { externalUserRef: { $type: "string" } } });
GrantSchema.index({ userId: 1 });

export const AppGrant = mongoose.model<IAppGrant>("AppGrant", GrantSchema, "app_grants");

// ------------------------------------------------------------------ token revocation list

export interface IRevokedToken {
    _id: string; // jti
    appId: mongoose.Types.ObjectId;
    expiresAt: Date;
}

const RevokedTokenSchema = new Schema<IRevokedToken>({
    _id: { type: String, required: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    expiresAt: { type: Date, required: true },
}, { versionKey: false });
// Entries are only needed until the token would have expired anyway
RevokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RevokedToken = mongoose.model<IRevokedToken>("RevokedToken", RevokedTokenSchema, "revoked_app_tokens");

// ------------------------------------------------------------------ usage + audit

export interface IAppUsage {
    appId: mongoose.Types.ObjectId;
    /** UTC day, YYYY-MM-DD */
    day: string;
    apiRequests: number;
    tokensIssued: number;
    messagesSent: number;
    socketConnections: number;
    /** API responses with status >= 400 to this app's authenticated requests */
    apiErrors: number;
    usersRegistered?: number;
}

const UsageSchema = new Schema<IAppUsage>({
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    day: { type: String, required: true },
    apiRequests: { type: Number, default: 0 },
    tokensIssued: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    socketConnections: { type: Number, default: 0 },
    apiErrors: { type: Number, default: 0 },
    usersRegistered: { type: Number, default: 0 },
}, { versionKey: false });
UsageSchema.index({ appId: 1, day: 1 }, { unique: true });

export const AppUsage = mongoose.model<IAppUsage>("AppUsage", UsageSchema, "app_usage");

export interface IAppAuditEvent {
    appId: mongoose.Types.ObjectId;
    actorUserId: mongoose.Types.ObjectId | null;
    actorKind: "owner" | "platform-admin" | "user" | "app";
    action: string;
    /** Non-secret details only (ids, scope names, key ids) */
    details: Record<string, unknown>;
    at: Date;
}

const AuditSchema = new Schema<IAppAuditEvent>({
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorKind: { type: String, enum: ["owner", "platform-admin", "user", "app"], required: true },
    action: { type: String, required: true, maxlength: 60 },
    details: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now },
}, { versionKey: false });
AuditSchema.index({ appId: 1, at: -1 });

export const AppAuditEvent = mongoose.model<IAppAuditEvent>("AppAuditEvent", AuditSchema, "app_audit_events");

// ------------------------------------------------------------------ consent requests (app-initiated)

/**
 * One-time consent request created by the app's SERVER (credential-authenticated). Binds the app,
 * the requested scopes, the external user reference and an exact registered redirect URI, so a
 * third-party site can't fabricate consent or link a reference to someone else's account.
 */
export interface IConsentRequest {
    _id: string;
    appId: mongoose.Types.ObjectId;
    scopes: string[];
    externalUserRef: string | null;
    redirectUri: string;
    state: string;
    /** OAuth 2.0 authorization-code flow: the PKCE S256 challenge (null = server consent flow) */
    codeChallenge: string | null;
    status: "pending" | "approved" | "denied";
    decidedBy: mongoose.Types.ObjectId | null;
    decidedAt: Date | null;
    expiresAt: Date;
    createdAt: Date;
}

const ConsentRequestSchema = new Schema<IConsentRequest>({
    _id: { type: String, required: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    scopes: { type: [String], default: [] },
    externalUserRef: { type: String, default: null, maxlength: 200 },
    redirectUri: { type: String, required: true, maxlength: 300 },
    state: { type: String, required: true, maxlength: 200 },
    codeChallenge: { type: String, default: null, maxlength: 128 },
    status: { type: String, enum: ["pending", "approved", "denied"], default: "pending" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
// Requests are deleted a day after expiry (kept briefly for support / audit correlation)
ConsentRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const ConsentRequest = mongoose.model<IConsentRequest>("ConsentRequest", ConsentRequestSchema, "app_consent_requests");

// ------------------------------------------------------------------ OAuth 2.0 (authorization code + PKCE)

/** One-time authorization code (stored as its SHA-256), exchanged at POST /oauth/token within minutes. */
export interface IOAuthCode {
    _id: string;
    appId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    scopes: string[];
    redirectUri: string;
    /** PKCE S256 challenge from /oauth/authorize */
    codeChallenge: string;
    expiresAt: Date;
    usedAt: Date | null;
}

const OAuthCodeSchema = new Schema<IOAuthCode>({
    _id: { type: String, required: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scopes: { type: [String], default: [] },
    redirectUri: { type: String, required: true, maxlength: 300 },
    codeChallenge: { type: String, required: true, maxlength: 128 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
}, { versionKey: false });
OAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const OAuthCode = mongoose.model<IOAuthCode>("OAuthCode", OAuthCodeSchema, "app_oauth_codes");

/**
 * Refresh token (stored as its SHA-256). Rotated on every use; all tokens descending from one
 * authorization share a family, and presenting an already-used token revokes the whole family.
 */
export interface IRefreshToken {
    _id: string;
    familyId: string;
    appId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    scopes: string[];
    expiresAt: Date;
    usedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
}

const RefreshTokenSchema = new Schema<IRefreshToken>({
    _id: { type: String, required: true },
    familyId: { type: String, required: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
RefreshTokenSchema.index({ familyId: 1 });
RefreshTokenSchema.index({ appId: 1, userId: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });

export const RefreshToken = mongoose.model<IRefreshToken>("RefreshToken", RefreshTokenSchema, "app_refresh_tokens");

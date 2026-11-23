import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";
import { currentContext } from "../tenancy/context";

export interface IUser extends Document {
    _id: mongoose.Schema.Types.ObjectId;
    username: string;
    /** SpreeWe accounts only (globally unique, used for Clerk linking and contact lookup). Never set for app-managed users. */
    email: string;
    /**
     * Home tenant ("realm"). null / missing = a SpreeWe account (Clerk sign-in). Otherwise the dedicated
     * tenant of the developer application that registered this user: the user exists only there.
     * Immutable after creation.
     */
    tenantId?: mongoose.Types.ObjectId | null;
    /** App-managed users: the application that registered them */
    appId?: mongoose.Types.ObjectId | null;
    /** App-managed users: the id the application's own system uses (unique per tenant) */
    externalUserId?: string | null;
    /** App-managed users: optional email supplied by the application (not unique, never used for sign-in or linking) */
    contactEmail?: string | null;
    /** App-managed users: deactivated by the application (kept because messages reference the user) */
    deactivatedAt?: Date | null;
    /** Legacy (pre-Clerk) password hash; no longer used for sign-in. */
    password?: string;
    /** Clerk user id ("user_…") this account is linked to. */
    clerkId?: string | null;
    /** Display URL of the profile picture (stable link for stored files, or a legacy URL). */
    avatar: string;
    /** The stored profile picture behind `avatar`, when it lives in our object storage. */
    avatarFile?: IStoredFile | null;
    isOnline: boolean;
    lastSeen: Date;
    isVerified: boolean;
    verificationToken?: string;
    bio: string;
    status: 'Available' | 'Busy' | 'Do not disturb' | 'Away' | 'Appear offline';
    /** Custom status text ("In a workshop until 3pm") */
    statusMessage?: string;
    /** Idle on all devices for a while: shown as Away while the chosen status is Available */
    autoAway?: boolean;
    /** Listed in the global directory / people search (privacy setting; default on, as before) */
    globalDiscoverable?: boolean;
    /** Set from Clerk webhooks: account deleted / banned in Clerk (hidden from directories) */
    clerkDeletedAt?: Date | null;
    clerkBanned?: boolean;
}

const UserSchema = new Schema<IUser>({
    username: {
        type: String,
        required: true,
        minlength: [3, 'Username must be at least 3 characters long']
    },
    email: {
        type: String,
        // SpreeWe accounts need one; app-managed users never have one (see contactEmail)
        required: [function (this: IUser) { return !this.tenantId; }, "Email is required"],
        lowercase: true,
        match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
    },
    password: {
        type: String,
    },
    clerkId: {
        type: String,
        default: undefined,
    },
    avatar: {
        type: String,
        default: "",
    },
    avatarFile: {
        type: StoredFileSchema,
        default: undefined,
    },
    isOnline: {
        type: Boolean,
        default: false
    },
    lastSeen: {
        type: Date
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    verificationToken: {
        type: String,
        default: null
    },
    bio: {
        type: String,
        default: 'Hey there! I am using Chat App.'
    },
    status: {
        type: String,
        enum: ['Available', 'Busy', 'Do not disturb', 'Away', 'Appear offline'],
        default: 'Available'
    },
    statusMessage: {
        type: String,
        default: '',
        maxlength: 140,
    },
    autoAway: {
        type: Boolean,
        default: false,
    },
    globalDiscoverable: {
        type: Boolean,
        default: true,
    },
    clerkDeletedAt: {
        type: Date,
        default: null,
    },
    clerkBanned: {
        type: Boolean,
        default: false,
    },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, immutable: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", default: null, immutable: true },
    externalUserId: { type: String, default: undefined, maxlength: 200, immutable: true },
    contactEmail: { type: String, default: undefined, lowercase: true, maxlength: 254 },
    deactivatedAt: { type: Date, default: null },
});

// SpreeWe accounts: one per email. App-managed users have no `email`, so they are outside this index
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
// App-managed users: one per (application tenant, external id)
UserSchema.index({ tenantId: 1, externalUserId: 1 }, { unique: true, partialFilterExpression: { externalUserId: { $type: "string" } } });
UserSchema.index({ tenantId: 1, contactEmail: 1 }, { partialFilterExpression: { contactEmail: { $type: "string" } } });

UserSchema.pre("validate", function (this: IUser) {
    if (this.tenantId) {
        if (!this.externalUserId || !this.appId) this.invalidate("externalUserId", "App-managed users need appId and externalUserId");
        if (this.email) this.invalidate("email", "App-managed users can't have a SpreeWe email");
        if (this.clerkId) this.invalidate("clerkId", "App-managed users can't be linked to a Clerk account");
    } else if (this.externalUserId || this.appId) {
        this.invalidate("tenantId", "externalUserId / appId need an application tenant");
    }
});

/**
 * Realm isolation at the data layer. While a user context is active, every query on users is AND-ed
 * with the acting user's realm: SpreeWe accounts (tenantId null / missing) only see SpreeWe accounts,
 * and users registered by a developer application only see users of that application's tenant. So a
 * forgotten check in a service (a lookup by id, a populate) cannot return a user of another
 * application. Explicit system work (runAsSystem) and code with no context (sign-in resolution,
 * migrations) are not filtered and must scope themselves.
 */
const REALM_QUERY_OPS = [
    "countDocuments", "deleteMany", "deleteOne", "distinct", "find", "findOne", "findOneAndDelete",
    "findOneAndReplace", "findOneAndUpdate", "replaceOne", "updateMany", "updateOne",
] as const;

function realmFilter(): Record<string, unknown> | null {
    const ctx = currentContext();
    if (!ctx || ctx.kind !== "user") return null;
    // { tenantId: null } also matches accounts created before the field existed
    return { tenantId: ctx.realm ? new mongoose.Types.ObjectId(String(ctx.realm)) : null };
}

UserSchema.pre(REALM_QUERY_OPS as any, function (this: any) {
    const realm = realmFilter();
    if (!realm) return;
    const current = this.getFilter() || {};
    this.setQuery(Object.keys(current).length ? { $and: [current, realm] } : realm);
});

UserSchema.pre("aggregate", function (this: any) {
    const realm = realmFilter();
    if (realm) this.pipeline().unshift({ $match: realm });
});

// Never serialise credentials (API responses, socket payloads, localStorage on the client)
const hideSecrets = (_doc: unknown, ret: Record<string, unknown>) => {
    delete ret.password;
    delete ret.verificationToken;
    delete ret.avatarFile;
    // Others never learn that someone chose "Appear offline" (GET /web/user/me sends the real value)
    if (ret.status === 'Appear offline') {
        ret.status = 'Available';
    }
    return ret;
};
UserSchema.set('toJSON', { transform: hideSecrets });
// One app account per Clerk user (sparse: accounts not linked yet have no clerkId)
UserSchema.index({ clerkId: 1 }, { unique: true, sparse: true });
UserSchema.set('toObject', { transform: hideSecrets });

const User = mongoose.model<IUser>("User", UserSchema);
export default User;

import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";

export interface IUser extends Document {
    _id: mongoose.Schema.Types.ObjectId;
    username: string;
    email: string;
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
}

const UserSchema = new Schema<IUser>({
    username: {
        type: String,
        required: true,
        minlength: [3, 'Username must be at least 3 characters long']
    },
    email: {
        type: String,
        required: true,
        unique: true,
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

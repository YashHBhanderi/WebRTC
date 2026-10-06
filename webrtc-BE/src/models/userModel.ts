import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";

export interface IUser extends Document {
    _id: mongoose.Schema.Types.ObjectId;
    username: string;
    email: string;
    password: string;
    /** Display URL of the profile picture (stable link for stored files, or a legacy URL). */
    avatar: string;
    /** The stored profile picture behind `avatar`, when it lives in our object storage. */
    avatarFile?: IStoredFile | null;
    isOnline: boolean;
    lastSeen: Date;
    isVerified: boolean;
    verificationToken?: string;
    bio: string;
    status: 'Available' | 'Away' | 'Busy';
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
        required: true,
        minlength: [6, 'Password must be at least 6 characters long']
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
        enum: ['Available', 'Away', 'Busy'],
        default: 'Available'
    }
});

// Never serialise credentials (API responses, socket payloads, localStorage on the client)
const hideSecrets = (_doc: unknown, ret: Record<string, unknown>) => {
    delete ret.password;
    delete ret.verificationToken;
    delete ret.avatarFile;
    return ret;
};
UserSchema.set('toJSON', { transform: hideSecrets });
UserSchema.set('toObject', { transform: hideSecrets });

const User = mongoose.model<IUser>("User", UserSchema);
export default User;

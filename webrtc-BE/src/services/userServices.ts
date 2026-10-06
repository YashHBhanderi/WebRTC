import User from "../models/userModel";
import { IUser } from "../models/userModel";
import bcrypt from 'bcrypt'
import { JwtUtills } from "../utils/jwtUtiils"
import { IStoredFile } from "../models/storedFile.schema";
import { releaseFile } from "./file.service";
import { AppError, NotFoundError } from "../utils/errors";

const USER_STATUSES = ['Available', 'Away', 'Busy'] as const;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const BIO_MAX = 160;

export interface ProfileUpdate {
    username?: string;
    bio?: string;
    status?: (typeof USER_STATUSES)[number];
}

/** Display name: letters (any language), digits, spaces and . _ ' - ; 3-30 characters. */
export function validateUsername(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('Username is required');
    const name = value.replace(/\s+/g, ' ').trim();
    if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
        throw new AppError(`Username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`);
    }
    if (!/^[\p{L}\p{M}\p{N} ._'-]+$/u.test(name)) {
        throw new AppError("Username can only contain letters, numbers, spaces and . _ ' -");
    }
    return name;
}

/**
 * Fields a user may change about themselves. Anything else in the body (email, password,
 * avatar URL, ids…) is ignored — email in particular is read-only here.
 */
export function parseProfileUpdate(body: Record<string, unknown> | undefined): ProfileUpdate {
    const update: ProfileUpdate = {};
    if (body?.username !== undefined) {
        update.username = validateUsername(body.username);
    }
    if (body?.bio !== undefined) {
        if (typeof body.bio !== 'string') throw new AppError('Bio must be text');
        const bio = body.bio.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
        if (bio.length > BIO_MAX) throw new AppError(`Bio is too long (max ${BIO_MAX} characters)`);
        update.bio = bio;
    }
    if (body?.status !== undefined) {
        if (!USER_STATUSES.includes(body.status as ProfileUpdate['status'] & string)) throw new AppError('Invalid status');
        update.status = body.status as ProfileUpdate['status'];
    }
    return update;
}

class UserServices {
    public async emailExists(email: unknown): Promise<boolean> {
        return typeof email === 'string' && !!(await User.exists({ email: email.toLowerCase().trim() }));
    }

    public async createUser(newUser: Pick<IUser, '_id' | 'username' | 'email' | 'password' | 'avatar' | 'avatarFile'>): Promise<IUser> {
        const existingUser = await User.findOne({ email: newUser.email });
        if (existingUser) {
            throw new AppError(`User already exists`, 409);
        }
        const hashPassword = await bcrypt.hash(newUser.password, 10);
        newUser.password = hashPassword;
        const user = new User({ ...newUser, isVerified: true });
        const savedUser = await user.save();

        return savedUser;
    }

    public async loginUser(email: string, password: string): Promise<{ token: string, user: IUser }> {
        let user;
        user = await User.findOne({ email: email })

        if (!user) throw new Error(`User with Email ${email} not found`);
        const pass = await bcrypt.compare(password, user.password);
        if (!pass) throw new Error(`Invalid Credentials`);
        const token = JwtUtills.generateToken(user.id);
        return { token, user };
    }

    public async allUser(): Promise<IUser[]> {
        const user = User.aggregate(
            [
                {
                    $project: {
                        username: 1,
                        email: 1,
                        role: 1
                    }
                }
            ]
        )
        return user;
    }

    public async deleteUser(userId: string): Promise<void> {
        if (!userId) throw new Error('User Id is required');
        const user = await User.findByIdAndDelete(userId);
        // Their chat attachments stay: they are part of other people's conversations
        await releaseFile(user?.avatarFile);
    }

    public async getUserByUserName(username: string): Promise<IUser | null> {
        const user = await User.findOne({ username: username });
        return user;
    }

    public async getUserById(userId: string): Promise<IUser | null> {
        if (!userId) throw new Error('User Id is required');
        return await User.findById(userId);
    }

    public async getAllUsersExceptCurrentUser(userId: string): Promise<IUser[]> {
        return await User.find({ _id: { $ne: userId } });
    }


    /**
     * Apply a validated profile update; `avatar` is an already-stored picture. The previous
     * picture is deleted only after the database points at the new one.
     */
    public async updateProfile(userId: string, update: ProfileUpdate, avatar?: IStoredFile): Promise<IUser> {
        if (!userId) throw new Error('User Id is required');
        const set: Record<string, unknown> = { ...update };
        if (avatar) {
            set.avatar = avatar.storageKey;
            set.avatarFile = avatar;
        }
        if (!Object.keys(set).length) throw new AppError('Nothing to update');

        const before = await User.findById(userId).select('avatarFile');
        if (!before) throw new NotFoundError('User not found');
        const updated = await User.findByIdAndUpdate(userId, { $set: set }, { new: true, runValidators: true });
        if (!updated) throw new NotFoundError('User not found');
        if (avatar && before.avatarFile?.storageKey !== avatar.storageKey) {
            await releaseFile(before.avatarFile);
        }
        return updated;
    }

}

export default new UserServices();
import { Request, Response } from "express";
import mongoose from "mongoose";
import userServices, { parseProfileUpdate, validateUsername } from "../services/userServices";
import CustomRequest from "../types/customRequest";
import { IStoredFile } from "../models/storedFile.schema";
import { releaseFile, storeUpload } from "../services/file.service";
import { discardTempFile } from "../utils/multer";
import { AppError, publicMessage } from "../utils/errors";
import { io } from "../realtime/io";

function fail(res: Response, error: unknown, fallback: string): void {
    if (!(error instanceof AppError)) {
        console.error(fallback, error);
    }
    res.status(error instanceof AppError ? error.status : 500).json({ status: false, data: null, message: publicMessage(error, fallback) });
}

export default class UserController {
    static async creatUser(req: Request, res: Response): Promise<void> {
        let uploaded: IStoredFile | undefined;
        try {
            const { username, email, password } = req.body || {};
            const name = validateUsername(username);
            if (typeof email !== 'string' || typeof password !== 'string') throw new AppError('Email and password are required');
            // Check before uploading so a duplicate sign-up leaves no file behind
            if (await userServices.emailExists(email)) throw new AppError('User already exists', 409);

            // Picture is optional: without one, clients show a generated initials avatar
            const userId = new mongoose.Types.ObjectId();
            if (req.file) {
                uploaded = (await storeUpload(req.file, { purpose: "avatar", userId: String(userId) }, String(userId))).stored;
            }
            const user = await userServices.createUser({
                _id: userId as unknown as mongoose.Schema.Types.ObjectId,
                username: name,
                email,
                password,
                avatar: uploaded ? uploaded.storageKey : "",
                ...(uploaded ? { avatarFile: uploaded } : {}),
            });
            res.status(200).json({ status: true, data: user, message: 'User Created Successfully' });
        } catch (error) {
            await discardTempFile(req.file);
            await releaseFile(uploaded);
            if (error instanceof mongoose.Error.ValidationError) {
                res.status(400).json({ status: false, data: null, message: Object.values(error.errors).map((e) => e.message).join(', ') });
                return;
            }
            fail(res, error, 'Could not create the account');
        }
    }

    static async loginUser(req: Request, res: Response): Promise<void> {
        try {
            const { email, password } = req.body;
            const response = await userServices.loginUser(email, password);
            res.status(200).json({ status: true, data: response, message: 'Login Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async getAllUser(req: Request, res: Response): Promise<void> {
        try {
            const allUser = await userServices.allUser();
            if (!allUser) {
                throw new Error('Users Not Found!');
            }
            res.status(200).json({ status: true, data: allUser, message: 'All Users' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }
    static async deleteUser(req: Request, res: Response): Promise<void> {
        try {
            const userId = req.params.id;
            // There are no admin roles: a user may only delete their own account
            if (String((req as CustomRequest).userId) !== String(userId)) {
                res.status(403).json({ status: false, data: null, message: 'You can only delete your own account' });
                return;
            }
            await userServices.deleteUser(userId)
            res.status(200).json({ status: true, data: null, message: 'User Deleted Successfully' });

        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }


    static async getUserById(req: Request, res: Response): Promise<void> {
        try {
            const userId = req.params.userId;
            if (!userId) throw new Error('User Id is required')
            const user = await userServices.getUserById(userId);
            if (!user) throw new Error('User Not Found!');
            res.status(200).json({ status: true, data: user, message: 'User get Successfully' });

        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    static async getAllUsersExceptCurrentUser(req: Request, res: Response): Promise<void> {
        try {
            const userId = (req as CustomRequest).userId;
            if (!userId) throw new Error('User Id is required')
            const user = await userServices.getAllUsersExceptCurrentUser(userId);
            if (!user) throw new Error('Users Not Found!');
            res.status(200).json({ status: true, data: user, message: 'User get Successfully' });

        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
        }
    }

    /**
     * PATCH /web/user/profile (multipart): username?, bio?, image? — for the signed-in user only.
     * The user id comes from the token; email cannot be changed here.
     */
    static async updateProfile(req: Request, res: Response): Promise<void> {
        let uploaded: IStoredFile | undefined;
        try {
            const userId = String((req as CustomRequest).userId || '');
            if (!userId) throw new AppError('Not signed in', 401);
            // Validate text first: a rejected name must not leave an uploaded picture behind
            const update = parseProfileUpdate(req.body);
            if (req.file) {
                uploaded = (await storeUpload(req.file, { purpose: "avatar", userId }, userId)).stored;
            }
            const user = await userServices.updateProfile(userId, update, uploaded);
            // Everyone's chat lists / headers pick up the new name and picture live
            io().emit("user:updated", { _id: userId, username: user.username, avatar: user.avatar, bio: user.bio, status: user.status });
            res.status(200).json({ status: true, data: user, message: 'Profile updated successfully' });
        } catch (error) {
            await discardTempFile(req.file);
            await releaseFile(uploaded);
            fail(res, error, 'Could not update the profile');
        }
    }

}

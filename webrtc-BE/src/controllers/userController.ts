import { Request, Response } from "express";
import userServices from "../services/userServices";
import CustomRequest from "../types/customRequest";
import { v2 as cloudinary } from "cloudinary";
export default class UserController {
    static async creatUser(req: Request, res: Response): Promise<void> {
        try {
            const newUser = req.body;
            if (!req.file) throw new Error("No file uploaded");
            const base64String = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
            const result = await cloudinary.uploader.upload(base64String, { folder: "uploads" });
            newUser.avatar = result.secure_url;
            const User = await userServices.createUser(newUser);
            res.status(200).json({ status: true, data: User, message: 'User Created Successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
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

    static async updateProfile(req: Request, res: Response): Promise<void> {
        try {
            const userId = (req as CustomRequest).userId;
            if (!userId) throw new Error('User Id not found');
            const updateData = req.body;

            if (req.file) {
                const base64String = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
                const result = await cloudinary.uploader.upload(base64String, { folder: "uploads" });
                updateData.avatar = result.secure_url;
            }

            const updatedUser = await userServices.updateProfile(userId.toString(), updateData);
            res.status(200).json({ status: true, data: updatedUser, message: 'Profile updated successfully' });
        } catch (error) {
            res.status(500).json({ status: false, data: null, message: error.message });
        }
    }

}

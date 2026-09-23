import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';

const uploadDirectory = 'src/uploads/';

if (!fs.existsSync(uploadDirectory)) {
    fs.mkdirSync(uploadDirectory, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req: Request, file, cb) => {
        cb(null, uploadDirectory);
    },
    filename: (req: Request, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 * 500 },
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|xlsx|pdf|mp4|mp3|html|txt|jfif|xlsx/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            cb(null, true);
        } else {
            cb(new Error('Only images, PDFs, MP4s, and text files (TXT) are allowed!'));
        }
    }
});

export default upload;

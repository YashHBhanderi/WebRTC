import express from "express";
import path from "path";
import cors from "cors";
import router from "./routes/routes";
import { uploadSingle } from "./utils/multer";
import verifyToken from "./middleware/authMiddleware";
import uploadFile from "./controllers/upload.controller";
import { logger } from "./utils/logger";

/** Express app: middleware + REST routes. Socket.IO lives in ./realtime. */
export function createApp(corsOrigin: string[] | "*") {
    const app = express();

    app.use(logger);
    app.use(express.json({ limit: "1000mb" }));
    app.use(express.urlencoded({ extended: true, limit: "1000mb" }));
    app.use(cors({ origin: corsOrigin }));
    app.use("/", router);

    // Stored files (S3): upload needs a session; clients read straight from S3 (see file.service)
    app.post("/upload", verifyToken, uploadSingle("file"), uploadFile);
    app.use("/uploads", express.static(path.join(__dirname, "/uploads")));

    return app;
}

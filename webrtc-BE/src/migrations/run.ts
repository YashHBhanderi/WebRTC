import mongoose from "mongoose";
import connectDB from "../config/database";
import { runMigrations } from "./index";

/** `npm run migrate` — apply pending migrations without starting the server. */
connectDB()
    .then(runMigrations)
    .then(() => {
        console.log("[migrations] done");
        return mongoose.disconnect();
    })
    .catch(async (error) => {
        console.error("[migrations] failed:", error);
        await mongoose.disconnect().catch(() => undefined);
        process.exit(1);
    });

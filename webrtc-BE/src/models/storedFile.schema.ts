import { Schema } from "mongoose";

/**
 * Provider-neutral reference to an object in file storage. URLs are never stored for private
 * files; they are generated (and signed) when a document is sent to a client.
 */
export interface IStoredFile {
    storageKey: string;
    storageProvider: "s3";
    mimeType: string;
    originalName: string;
    size: number;
}

export const StoredFileSchema = new Schema<IStoredFile>(
    {
        storageKey: { type: String, required: true },
        storageProvider: { type: String, enum: ["s3"], required: true, default: "s3" },
        mimeType: { type: String, required: true },
        originalName: { type: String, default: "" },
        size: { type: Number, default: 0 },
    },
    { _id: false }
);

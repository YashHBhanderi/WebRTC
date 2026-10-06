import fs from "fs";

/**
 * Content sniffing for the formats the app accepts. The browser-supplied MIME type is only a
 * claim; the declared type must be consistent with the file's leading bytes.
 * Returns the MIME types that the bytes are compatible with (empty = unknown/unsupported).
 */
export function compatibleMimeTypes(head: Buffer): Set<string> {
    const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
    const types = new Set<string>();

    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        types.add("image/jpeg");
    } else if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") {
        types.add("image/png");
    } else if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
        types.add("image/gif");
    } else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
        types.add("image/webp");
    } else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
        ["audio/wav", "audio/x-wav", "audio/wave"].forEach((t) => types.add(t));
    } else if (ascii(0, 5) === "%PDF-") {
        types.add("application/pdf");
    } else if (ascii(4, 8) === "ftyp") {
        // ISO base media (mp4 / m4a / mov): the brand distinguishes QuickTime and audio-only files
        const brand = ascii(8, 12);
        if (brand === "qt  ") {
            types.add("video/quicktime");
        }
        ["video/mp4", "audio/mp4", "audio/x-m4a", "audio/m4a"].forEach((t) => types.add(t));
    } else if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) {
        ["video/webm", "audio/webm"].forEach((t) => types.add(t));
    } else if (ascii(0, 4) === "OggS") {
        ["audio/ogg", "video/ogg"].forEach((t) => types.add(t));
    } else if (ascii(0, 3) === "ID3" || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) {
        // MP3 (ID3 tag or MPEG frame sync); ADTS AAC shares the frame-sync prefix
        ["audio/mpeg", "audio/mp3", "audio/aac"].forEach((t) => types.add(t));
    }
    return types;
}

/** First bytes of a file on disk (enough for every signature above). */
export async function readHead(path: string, bytes = 32): Promise<Buffer> {
    const handle = await fs.promises.open(path, "r");
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

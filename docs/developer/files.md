# Files and attachments

Chat attachments are encrypted in the browser before upload. The server and the storage bucket hold only ciphertext; the file key travels inside the end-to-end encrypted message.

Related: [Chat](./chat.md) · [SDK reference](./sdk-reference.md) · [Real-time events](./realtime-events.md) · [Session REST API](./rest-api/session-api.md) · [Authentication](./authentication.md)

## Status

**Implemented, not tested end to end.** The attachment flow needs S3 (the SDK end-to-end test runs without storage and does not cover attachments) and has **not been tested in a real browser**. Validate upload, send, download and decrypt in your target browsers against a backend with storage configured before relying on it.

## Flow

```
browser                                   SpreeWe backend                    S3 (private)
 1. encryptFile(file)  AES-256-GCM
 2. POST /upload (ciphertext) ───────────▶ checks membership, block, policy
                                           size limit per kind ─────────────▶ put  {prefix}/conversations/{id}/{folder}/yyyy/mm/{uuid}.bin
                       ◀─────────── { storageKey, type, size, encrypted: true }
 3. sendMessage (E2EE payload incl. file key, storageKey)
                                           verifies key belongs to this
                                           conversation and this uploader
 4. receiver: message with fileUrl (pre-signed GET) ◀──────────────────────
 5. attachment.download() ── fetch(fileUrl) ───────────────────────────────▶ ciphertext
    SHA-256 check, AES-GCM decrypt → Blob
```

## Sending

```ts
const input = document.querySelector<HTMLInputElement>('#file')!;
await client.files.sendAttachment(conversationId, input.files![0], 'optional caption');
```

What `sendAttachment` does (`client.ts`, `attachment-crypto.ts`):

1. **Encrypt.** WebCrypto AES-256-GCM, a fresh random 256-bit key and 96-bit IV per file. SHA-256 of the ciphertext is computed. The local key bytes are zeroed after encoding.
2. **Upload** `POST /upload` as `multipart/form-data`:

   | Field | Value |
   |---|---|
   | `purpose` | `message` |
   | `conversationId` | the conversation |
   | `encrypted` | `1` (required; anything else → 400 "Attachments must be end-to-end encrypted") |
   | `kind` | `image`, `video`, `audio`, `pdf` or `file` |
   | `file` | the ciphertext, file name `encrypted.bin` |

   Response: `{ storageKey, type, size, encrypted: true }`.
3. **Send** an encrypted message whose content is `{ text: caption, file: { key, iv, sha256, mimeType, name, size, storageKey } }`, with `type` = kind and the `storageKey`. Real file name, MIME type and key are inside the ciphertext only.

### Kind mapping (SDK)

| Browser `file.type` | `kind` |
|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` | `image` |
| any other `image/*` (e.g. SVG, HEIC) | `file` |
| `video/*` | `video` |
| `audio/*` | `audio` |
| `application/pdf` | `pdf` |
| anything else, or empty | `file` |

The kind is visible metadata. The server uses it only for the size limit and the storage folder; it cannot see the real type.

## Receiving and downloading

```ts
client.events.on('message', async (m) => {
  if (m.state === 'ok' && m.attachment) {
    const { name, mimeType, size } = m.attachment;
    const blob = await m.attachment.download();   // fetch + verify + decrypt on this device
    const url = URL.createObjectURL(blob);
  }
});
```

`download()` fetches the pre-signed `fileUrl` from the message, checks the SHA-256 of the ciphertext (throws "This file was changed or replaced, so it was not opened." on mismatch), then AES-GCM-decrypts (the GCM tag also detects tampering).

Points to know:

- `fileUrl` is a pre-signed S3 link. It expires (`S3_SIGNED_URL_TTL_SECONDS`, default 6 h; every link handed out is valid for at least half of that). A `ChatMessage` held for longer will fail to download with `SpreeWeError` `HTTP` (403). Re-load the message with `client.messages.history()` to get a fresh link.
- The browser downloads straight from S3, so the bucket's **CORS** configuration must allow `GET` from your app's origin. The repo does not configure bucket CORS for you.
- Files are decrypted in memory (`arrayBuffer`). Large videos (up to 100 MB) need that much memory twice (ciphertext + plaintext).
- No thumbnails or inline previews are generated server-side for encrypted files (`thumbnailUrl` is empty). Render previews from the decrypted Blob.

`client.files.shared(conversationId)` returns server metadata for a conversation's media (`GET /conversations/:conversationId/media`); contents stay encrypted.

## Server-side rules

### Who may upload (`upload.controller.ts`)

- Authenticated user, member of the conversation (in the active workspace).
- 1:1 chat where either side blocked the other → 403 "You can't send files in this chat".
- External conversation without the workspace's file policy → refused.
- When sending, the `storageKey` must be in this conversation's folder and the object's `uploader-id` metadata must equal the sender (`attachMessageFile`), otherwise the message is rejected with `message.rejected` reason `attachment`.

### Size limits (`file.service.ts` `MEDIA_RULES`, `utils/multer.ts`)

| Kind | Max size |
|---|---|
| image | 10 MB |
| video | 100 MB |
| audio | 25 MB |
| pdf | 25 MB |
| file | 50 MB |

For encrypted uploads the limit is the kind limit plus 64 bytes of headroom (AES-GCM adds 16). Multer's outer cap is the largest limit (100 MB) and returns 413 with a JSON body. One file per request, max 20 form fields. Files are spooled to a temp directory on disk, streamed to S3 and the temp file is always removed.

### Type checks (`utils/file-signature.ts`)

Magic-byte sniffing (`compatibleMimeTypes`) and the MIME allow-lists in `MEDIA_RULES` apply only to **unencrypted** uploads: group avatars (`purpose=group-avatar`) and profile pictures (`PATCH /web/user/profile`). **Encrypted chat attachments are not content-checked** — the server cannot read ciphertext. Any file type can be sent as kind `file` up to 50 MB. Treat received files as untrusted on the client: the declared `mimeType` comes from the sender.

### Storage (`config/storage.ts`, `storage.service.ts`)

Required:

| Variable | Meaning |
|---|---|
| `AWS_REGION` | e.g. `ap-south-1` |
| `S3_BUCKET` | bucket name |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | IAM user limited to this bucket. The AWS default credential chain (instance roles, profiles) is **not** used. |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `AWS_SESSION_TOKEN` | — | only for temporary STS keys |
| `STORAGE_KEY_PREFIX` | `NODE_ENV` | top-level key folder (lower-case, `a-z0-9-`) |
| `S3_SIGNED_URL_TTL_SECONDS` | 21600 (6 h) | pre-signed link lifetime, max 7 days, min 120 s |
| `S3_PUBLIC_BASE_URL` | `https://{bucket}.s3.{region}.amazonaws.com` | where browsers load **public** objects (avatars), e.g. a CloudFront domain. Clients read it from `GET /config` (`s3BaseUrl`). |
| `S3_ENDPOINT` | — | S3-compatible endpoint (emulators). Ignored if it points at AWS S3 itself. |
| `S3_FORCE_PATH_STYLE` | — | `true` for most emulators |

Without the four required variables the server starts with uploads disabled (503 "File storage is not configured").

Object layout:

```
{prefix}/users/{userId}/avatar/{uuid}.{ext}        public (profile pictures)
{prefix}/groups/{groupId}/avatar/{uuid}.{ext}      public (group photos)
{prefix}/conversations/{conversationId}/{images|videos|audio|documents|files}/{yyyy}/{mm}/{uuid}.bin   private, ciphertext
{prefix}/recordings/{conversationId}/{recordingId}.mp4   private (see ./recordings.md)
```

Chat attachments are stored with content type `application/octet-stream` and `Cache-Control: private, max-age=31536000, immutable`. The server stores keys, never URLs.

**Lifecycle:** chat attachments have no automatic expiry. They are deleted when the message is deleted (unless a forwarded copy still references the key) or when a group is deleted. The only S3 lifecycle rule the server manages is the one for `recordings/` (`RECORDING_RETENTION_DAYS`).

### Bucket policy: avatars only are public

Only the avatar folders may be publicly readable. Attachments, recordings and transcripts must never be. Check your bucket with:

```bash
cd webrtc-BE
npm run check:s3
```

`check:s3` (`src/config/check-s3.ts`) is read-only (`GetBucketPolicy`, `GetPublicAccessBlock`) and exits with code 1 on any FAIL:

- FAIL if a public `Allow` statement grants anything other than read, uses `NotAction` / `NotResource`, or covers resources outside `…/users/*/avatar/*` and `…/groups/*/avatar/*`;
- FAIL if `BlockPublicAcls` and `IgnorePublicAcls` are not both true; WARN if there is no Public Access Block at all.

Example statement that passes:

```json
{
  "Sid": "PublicAvatars",
  "Effect": "Allow",
  "Principal": "*",
  "Action": "s3:GetObject",
  "Resource": [
    "arn:aws:s3:::my-bucket/production/users/*/avatar/*",
    "arn:aws:s3:::my-bucket/production/groups/*/avatar/*"
  ]
}
```

## Limitations

- Not tested end to end, not tested in a real browser (see Status).
- No content validation, virus scanning or thumbnailing for encrypted attachments.
- Whole-file in-memory encryption and decryption; no streaming or resumable upload; no progress callback in the SDK.
- Download links expire; re-fetch history to refresh them.
- Bucket CORS must be configured by the operator.
- A video close to 100 MB can exceed multer's outer cap once the 16-byte GCM tag is added (the cap is exactly the 100 MB video limit, without the 64-byte headroom), so it is rejected with 413.
- Forwarding an attachment has to be done by the client (decrypt, re-encrypt, re-upload); the server refuses `forwardOf`.

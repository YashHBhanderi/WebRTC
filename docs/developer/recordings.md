# Call recordings and transcripts

SpreeWe records calls on the server: it captures each participant's media from the SFU, composes one MP4, stores it in private S3 storage and, if available, transcribes it with whisper.cpp.

Related: [Calling](./calling.md) · [Files](./files.md) · [SDK reference](./sdk-reference.md) · [Real-time events](./realtime-events.md) · [Session REST API](./rest-api/session-api.md) · [Authentication](./authentication.md)

## Status

| Area | Status |
|---|---|
| `client.recordings.list()` | **Tested via SDK** (`webrtc-BE/test/sdk-e2e.test.ts`; returns an array) |
| Start / stop recording, compose, upload, transcription via the SDK | **Implemented, not tested via the SDK** (needs live call media, which the Node test cannot produce) |
| Crash recovery of interrupted recordings | Server tests exist: `webrtc-BE/test/recording-recovery.test.ts` (real FFmpeg, hard kill, real compose; S3 stubbed) |
| Real browser | **Not tested.** |

Note that recording is not end-to-end encrypted: the server sees call media while recording (call media is not E2EE in any case; the SFU forwards it).

## Lifecycle

```
calls.controls.startRecording ─▶ status "recording"
   per-producer capture (RTP → FFmpeg, loopback) into RECORDING_TMP_DIR/<recordingId>/
calls.controls.stopRecording  ─▶ status "processing"   (also on call end, RECORDING_MAX_MINUTES, low disk)
   compose one MP4 (composer.ts) ─▶ upload to S3 {prefix}/recordings/{conversationId}/{recordingId}.mp4
                                ─▶ status "completed", chat card message, notification
   transcriptStatus "pending" ─▶ "processing" ─▶ "completed" | "failed"   (or "none" if no engine / no audio)
```

Statuses: `recording`, `recovering`, `processing`, `completed`, `failed`. Details: [docs/operations/recording-recovery.md](../operations/recording-recovery.md).

## Starting and stopping

```ts
await client.calls.controls.startRecording(callId);
// ...
await client.calls.controls.stopRecording(callId);
```

Who may record (`recording.service.ts` `requirePermission`):

- the user must have **joined** the call (participant status `joined`);
- group calls: **host or co-host** only; 1:1 calls: either person.

Start is refused when recording is disabled on the server (`RECORDING_ENABLED` not `true`), the call has ended, it is already being recorded, or free disk space in `RECORDING_TMP_DIR` is below `RECORDING_MIN_FREE_MB` (503). Errors reject with `SpreeWeError` code `REJECTED`.

Recording is never silent: everyone in the call gets the server event `call:recording` (`{ active, startedAt, by, byName }` or `{ active: false, reason }`), and a system message "… started recording" is posted in the chat. **The SDK does not map `call:recording`** to an SDK event; use the system message or `recording.updated`.

Automatic stops: call end (`reason: "ended"`), `RECORDING_MAX_MINUTES` (`limit`), free disk below half of `RECORDING_MIN_FREE_MB` (`disk`).

## Retrieving recordings

### SDK

```ts
const list = await client.recordings.list(conversationId);
// [{ _id, title, startedAt, duration, status, transcriptStatus, size, expired }]  newest first, max 50

const rec = await client.recordings.get(list[0]._id);
// recording fields + transcriptAvailable, expiresAt, expired, startedByName,
// playbackUrl, downloadUrl  (short-lived pre-signed links, or null when not available / expired)

const t = await client.recordings.transcript(rec._id);
// { status, error, segments: [{ startTime, endTime, speaker, speakerId?, text, ... }] }

client.events.on('recording.updated', (r) => refresh(r));
// { recordingId, conversationId, status, transcriptStatus, startedBy, title }
```

Access: any member of the recording's conversation (in the active workspace). For anyone else the server answers 404, never revealing that the recording exists.

`playbackUrl` / `downloadUrl` expire with `S3_SIGNED_URL_TTL_SECONDS` (default 6 h); call `get()` again for fresh links. The browser loads them straight from S3, so bucket CORS must allow your origin for in-page playback.

### Session REST API (user token)

| Method and path | Result |
|---|---|
| `GET /conversations/:conversationId/recordings` | list (as above) |
| `GET /recordings/:id` | details + signed links |
| `GET /recordings/:id/transcript` | `{ status, error, segments }` |
| `GET /recordings/:id/transcript/export?format=txt\|srt\|vtt` | file download (`text/plain`, `application/x-subrip`, `text/vtt`); any other or missing format → txt. 400 until the transcript is completed. |
| `POST /recordings/:id/transcript/retry` | re-queue a failed or missing transcript; returns `{ transcriptStatus }`. Refused if the recording is not completed, expired, already transcribed, or no engine is installed. |

The SDK has no methods for export or retry; call them with the user's Bearer token (see [rest-api/session-api.md](./rest-api/session-api.md)). Responses other than export use the `{ status, data, message }` envelope.

### Server-to-server (`/v1`, app credentials)

`GET /v1/recordings/:recordingId` with scope `recordings:read` returns the same details with short-lived links. The `recording.available` outbound webhook carries metadata only (`recordingId`, `conversationId`, `title`, `startedAt`, `durationSeconds`). See `docs/api/v1.md` and `docs/integrations/outbound-webhooks.md`.

## Server configuration

Recording (`webrtc-BE/src/config/recording.ts`, `src/recording/recovery.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `RECORDING_ENABLED` | off | `true` to allow recording. FFmpeg must be installed. |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg binary |
| `RECORDING_TMP_DIR` | `<os tmp>/chat-app-recordings` | raw tracks during recording / processing; needs free disk |
| `RECORDING_PORT_MIN` / `RECORDING_PORT_MAX` | `51000` / `51999` | loopback UDP ports for captured RTP; no firewall change |
| `RECORDING_MAX_MINUTES` | `240` | safety stop |
| `RECORDING_RETENTION_DAYS` | `30` | recordings expire after this many days (metadata is kept, `expired: true`) |
| `RECORDING_FPS` | `25` (max 30) | frame rate of the composed video |
| `RECORDING_FONT_FILE` | system font | TTF/OTF for names / initials in the video |
| `RECORDING_MIN_FREE_MB` | `2048` | refuse to start below this free space; stop live recordings below half |
| `RECORDING_TMP_RETENTION_HOURS` | `24` | keep temp folders of finished / failed recordings this long |

Storage: the S3 settings in [files.md](./files.md) (section "Storage"). Recordings are private objects under `{prefix}/recordings/`. Retention is enforced by an **S3 lifecycle rule the server applies at startup**; this needs `s3:PutLifecycleConfiguration` (and read). If that permission is denied, create an equivalent expiry rule for the `recordings/` prefix yourself. Run `npm run check:s3` to confirm nothing outside avatar folders is public.

Transcription:

| Variable | Default | Meaning |
|---|---|---|
| `TRANSCRIPTION_PROVIDER` | `whisper-cpp` | or `none` |
| `TRANSCRIPTION_LANGUAGE` | `auto` | or a language code, e.g. `en` |
| `TRANSCRIPTION_MAX_ATTEMPTS` | `3` | automatic attempts before `failed` |
| `WHISPER_CPP_BIN` | `/opt/whisper.cpp/build/bin/whisper-cli` | whisper.cpp CLI |
| `WHISPER_MODEL` | — | a specific ggml model file |
| `WHISPER_MODEL_DIR` | `/opt/whisper.cpp/models` | without `WHISPER_MODEL`, the most accurate installed model that fits the memory budget is used (large-v3 → … → base) |
| `WHISPER_MAX_MEMORY_MB` | 60 % of RAM | memory budget for whisper |
| `WHISPER_THREADS` | half the CPU cores | threads |

Install whisper.cpp and a model:

```bash
# Ubuntu
sudo bash webrtc-BE/scripts/install-whisper.sh [model]     # e.g. large-v3-turbo; default chosen from RAM
# then in .env: WHISPER_CPP_BIN=/opt/whisper.cpp/build/bin/whisper-cli  WHISPER_MODEL_DIR=/opt/whisper.cpp/models
```

```powershell
# Windows, from webrtc-BE
powershell -ExecutionPolicy Bypass -File scripts\install-whisper.ps1 [-Model large-v3] [-InstallDir C:\whisper.cpp]
# updates WHISPER_CPP_BIN / WHISPER_MODEL_DIR in webrtc-BE\.env if it exists
```

Transcription runs on the server CPU, one job at a time at low priority. When the per-speaker capture files are still on disk, each speaker's own audio is transcribed (exact speaker attribution); otherwise the stored MP4 is used and speakers are matched from who was speaking at the time. If no engine or model is installed, or the recording has no audio, `transcriptStatus` is `none`.

## Recovery after a crash

On startup the server claims its own interrupted recordings (`recording` → `recovering`), remuxes readable track files and continues them through compose → upload → transcription, with a `recovery` field describing what was salvaged. Unrecoverable ones become `failed` with a reason. A crash typically loses about the last second of each track. Only the host that captured a recording recovers it (recordings store their `host`). Pending transcripts are re-queued on startup. Full details and limits: [docs/operations/recording-recovery.md](../operations/recording-recovery.md).

## Limitations

- Start / stop and transcripts not tested via the SDK; nothing tested in a real browser.
- Single-process: recording depends on the instance that hosts the call's media; FFmpeg and whisper run on the API server.
- No SDK methods for transcript export or retry, and no SDK event for `call:recording`.
- Recordings and transcripts are readable by every member of the conversation, including members added after the call.

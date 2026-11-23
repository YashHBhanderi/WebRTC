# Recording lifecycle, crash recovery and temp files

## States

| Status | Meaning |
|---|---|
| `recording` | Live: one FFmpeg capture per producer, writing to `RECORDING_TMP_DIR/<recordingId>/` |
| `recovering` | Interrupted by a restart; claimed by its own host, which is salvaging the track files |
| `processing` | Stopped (or recovered); composing → uploading to S3 → queuing transcription |
| `completed` | In S3; `recovery` is set if it came from a crash (`partial`, `audio`, `video`, `seconds`) |
| `failed` | `error` holds a safe, accurate reason (e.g. "nothing could be recovered", "running out of disk space") |

Each recording stores its owning **`host`** (hostname + temp directory). Only that host recovers or reprocesses it. Before Phase 5C, any restarting instance marked every live recording failed, including other instances' recordings, and failed their `processing` jobs because their files weren't on its disk.

## What a crash loses (measured, 12 s real-time capture then a hard kill)

| Track | Before (default Matroska muxing) | After (`-flush_packets 1 -cluster_time_limit 1000`) |
|---|---|---|
| Audio (AAC in .mka) | **0 bytes**, unreadable | 11.8 s of 12 recovered |
| Video (VP8 copy in .mkv) | 8.1 s of 12 | 12.0 s of 12 |

So a crash now loses **about the last second** of each track.

**Cannot be recovered reliably:**
- media still in FFmpeg's or the OS's buffers at the moment of the crash;
- a track whose process never wrote its header;
- anything if the disk failed or filled up.

Alignment between recovered tracks is approximate (about ±1 s): the exact first-packet time was only known to the lost process, and is estimated as capture start + 0.7 s.

## Recovery (automatic, on startup)

1. Track metadata (file, kind, user, capture start) is saved on the recording **when each capture starts**, not at stop, so a crash can find the files.
2. On startup, the host finds its recordings in `recording` / `recovering` and **claims each atomically** (`recording` → `recovering`). Concurrent restarts or duplicate calls recover a recording once; a finished recording is never re-claimed.
3. Each readable track is remuxed (stream copy, no re-encode) and probed. Empty, unreadable or missing files are counted, never invented.
4. If anything is usable, the recording continues through the normal compose → upload → transcription pipeline with `recovery` set. Otherwise it is `failed` with an accurate reason.
5. Access to recovered recordings uses the same authorization as any recording (participants of the conversation, in its workspace).

## Temp files

- On success or failure the pipeline removes the recording's temp folder (unchanged).
- **New:** a cleanup job runs at startup and hourly. It deletes a temp folder only when its recording is `completed` / `failed` or has no record at all, **and** nothing in it changed for `RECORDING_TMP_RETENTION_HOURS` (default 24).
- Folders of `recording`, `recovering` and `processing` recordings, and of this process's live recordings, are **never** deleted, whatever their age.

## Disk space

- `RECORDING_MIN_FREE_MB` (default 2048): a recording will not start below this free space in `RECORDING_TMP_DIR` (HTTP 503, nothing created).
- While recording, if free space drops below half of that, the recording is stopped cleanly (`reason: "disk"`, files finalised) instead of failing mid-write.

## Transcription failures

Unchanged and documented: up to `transcriptionConfig.maxAttempts` attempts with backoff, then `transcriptStatus: failed` with a safe reason. whisper.cpp runs at low CPU priority, one job at a time. Performance: [../testing/phase-5c-test-results.md](../testing/phase-5c-test-results.md#transcription-benchmark).

## Tests

`test/recording-recovery.test.ts`: real FFmpeg, hard kill, real compose; only S3 is stubbed. It covers:
- recovery of audio and video;
- exactly-once recovery under concurrent restarts, with no re-claim of a finished recording;
- an empty track → accurate failure;
- another host's recording untouched (by startup recovery and by a direct claim);
- an upload failure → safe failure, with temp files removed;
- temp cleanup rules;
- refusal to start when the disk is nearly full.

Mutation checks:
- the claim's status condition, removed → caught;
- the claim's host condition, removed → caught.

**Not verified:** a crash of a real staging call recording after these changes (staging must be re-created), and the disk-full stop under a real full disk.

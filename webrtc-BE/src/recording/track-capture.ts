import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import fs from "fs";
import path from "path";
import * as mediasoup from "mediasoup";
import { recordingConfig } from "../config/recording";

/**
 * Captures ONE mediasoup producer to a file: a loopback PlainTransport sends its RTP to an FFmpeg
 * process.
 *  - audio is decoded and written gap-free: Opus DTX and muted microphones leave long holes in
 *    the RTP stream, which aresample fills with silence from the RTP timestamps, so the file's
 *    timeline is real time (otherwise speech collapses together and drifts away from the video);
 *  - video is stored without re-encoding (Matroska holds VP8 / H.264).
 * File time 0 is the first RTP packet, whose wall-clock time is reported as `firstPacketAt`.
 */

const usedPorts = new Set<number>();
let cursor = 0;

/** Seconds between keyframe requests while recording video (bounds seek cost when composing). */
const KEYFRAME_INTERVAL_MS = 10_000;

/** An even RTP port + the next (RTCP) from the configured range, rotating so ports aren't reused at once. */
function allocatePorts(): [number, number] {
    const first = recordingConfig.portMin + (recordingConfig.portMin % 2);
    const slots = Math.floor((recordingConfig.portMax - first + 1) / 2);
    for (let i = 0; i < slots; i++) {
        const slot = (cursor + i) % slots;
        const port = first + slot * 2;
        if (!usedPorts.has(port)) {
            usedPorts.add(port);
            usedPorts.add(port + 1);
            cursor = slot + 1;
            return [port, port + 1];
        }
    }
    throw new Error("No free recording ports (raise RECORDING_PORT_MAX)");
}

function releasePorts(ports: [number, number]): void {
    ports.forEach((p) => usedPorts.delete(p));
}

/** SDP that tells FFmpeg what arrives on its ports (from the consumer's negotiated parameters). */
function sdpFor(consumer: mediasoup.types.Consumer, rtpPort: number, rtcpPort: number): string {
    const codec = consumer.rtpParameters.codecs[0];
    const [, name] = codec.mimeType.split("/");
    const channels = codec.channels && codec.channels > 1 ? `/${codec.channels}` : "";
    const fmtp = Object.entries(codec.parameters || {}).map(([k, v]) => `${k}=${v}`).join(";");
    return [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=recording",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
        `m=${consumer.kind} ${rtpPort} RTP/AVP ${codec.payloadType}`,
        `a=rtcp:${rtcpPort}`,
        `a=rtpmap:${codec.payloadType} ${name}/${codec.clockRate}${channels}`,
        ...(fmtp ? [`a=fmtp:${codec.payloadType} ${fmtp}`] : []),
        "a=recvonly",
        "",
    ].join("\n");
}

export interface CaptureHandle {
    file: string;
    /** Wall-clock ms of the first RTP packet (file time 0); null while nothing has arrived */
    readonly firstPacketAt: number | null;
    stop: () => Promise<void>;
}

function ffmpegArgs(kind: mediasoup.types.MediaKind, sdpPath: string, file: string): string[] {
    const input = [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-protocol_whitelist", "file,udp,rtp",
        "-fflags", "+genpts",
        "-f", "sdp", "-i", sdpPath,
    ];
    if (kind === "audio") {
        return [
            ...input,
            "-map", "0:a:0",
            // Fill DTX / mute holes (> 100 ms) with silence so the track keeps real time
            "-af", "aresample=async=1:min_hard_comp=0.100000:first_pts=0",
            "-ac", "1", "-ar", "48000",
            "-c:a", "aac", "-b:a", "96k",
            "-y", file,
        ];
    }
    return [...input, "-map", "0:v:0", "-c", "copy", "-y", file];
}

export async function captureProducer(
    router: mediasoup.types.Router,
    producer: mediasoup.types.Producer,
    dir: string,
    name: string,
    onUnexpectedExit: (code: number | null) => void,
): Promise<CaptureHandle> {
    const ports = allocatePorts();
    const transport = await router.createPlainTransport({
        listenInfo: { protocol: "udp", ip: "127.0.0.1" },
        rtcpMux: false,
        comedia: false,
    });
    let ffmpeg: ChildProcessWithoutNullStreams | null = null;
    let keyframeTimer: ReturnType<typeof setInterval> | null = null;
    try {
        await transport.connect({ ip: "127.0.0.1", port: ports[0], rtcpPort: ports[1] });
        const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: true,
        });

        const sdpPath = path.join(dir, `${name}.sdp`);
        const file = path.join(dir, `${name}.${producer.kind === "audio" ? "mka" : "mkv"}`);
        await fs.promises.writeFile(sdpPath, sdpFor(consumer, ports[0], ports[1]));

        // The first forwarded packet is where the file's timeline starts
        let firstPacketAt: number | null = null;
        consumer.on("trace", (trace) => {
            if (trace.type === "rtp" && firstPacketAt === null) {
                firstPacketAt = Date.now();
                void consumer.enableTraceEvent([]).catch(() => undefined);
            }
        });
        await consumer.enableTraceEvent(["rtp"]);

        ffmpeg = spawn(recordingConfig.ffmpegPath, ffmpegArgs(producer.kind, sdpPath, file), { windowsHide: true });
        let stopping = false;
        ffmpeg.stderr.on("data", (chunk) => console.warn(`[recording] ffmpeg(${name}): ${String(chunk).trim()}`));
        ffmpeg.on("error", (error) => console.error(`[recording] ffmpeg(${name}) could not start:`, error.message));
        ffmpeg.on("exit", (code) => {
            if (!stopping) {
                onUnexpectedExit(code);
            }
        });

        // Give FFmpeg a moment to open its ports, then start the flow and ask for a keyframe
        await new Promise((resolve) => setTimeout(resolve, 700));
        await consumer.resume();
        if (consumer.kind === "video") {
            await consumer.requestKeyFrame().catch(() => undefined);
            setTimeout(() => void consumer.requestKeyFrame().catch(() => undefined), 1500);
            keyframeTimer = setInterval(() => {
                if (!consumer.closed) {
                    void consumer.requestKeyFrame().catch(() => undefined);
                }
            }, KEYFRAME_INTERVAL_MS);
        }

        const proc = ffmpeg;
        return {
            file,
            get firstPacketAt() {
                return firstPacketAt;
            },
            stop: async () => {
                stopping = true;
                if (keyframeTimer) {
                    clearInterval(keyframeTimer);
                }
                consumer.close();
                transport.close();
                // "q" on stdin finalises the file cleanly on every OS (signals don't on Windows)
                await new Promise<void>((resolve) => {
                    if (proc.exitCode !== null) {
                        resolve();
                        return;
                    }
                    const timer = setTimeout(() => {
                        proc.kill();
                        resolve();
                    }, 8000);
                    proc.once("exit", () => {
                        clearTimeout(timer);
                        resolve();
                    });
                    try {
                        proc.stdin.write("q");
                        proc.stdin.end();
                    } catch {
                        proc.kill();
                    }
                });
                releasePorts(ports);
                await fs.promises.rm(sdpPath, { force: true }).catch(() => undefined);
            },
        };
    } catch (error) {
        if (keyframeTimer) {
            clearInterval(keyframeTimer);
        }
        ffmpeg?.kill();
        transport.close();
        releasePorts(ports);
        throw error;
    }
}

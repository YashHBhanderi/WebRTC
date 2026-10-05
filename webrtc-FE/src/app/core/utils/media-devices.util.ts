export interface CallMediaResult {
  stream: MediaStream;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Optional device choice from the pre-join screen / settings. Unset = browser default. */
export interface MediaDevicePrefs {
  audioDeviceId?: string | null;
  videoDeviceId?: string | null;
}

export interface MediaDeviceLists {
  microphones: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

/** Device labels are only populated after a permission grant; ids may be empty before that. */
export async function listMediaDevices(): Promise<MediaDeviceLists> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], cameras: [], speakers: [] };
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const usable = (d: MediaDeviceInfo) => !!d.deviceId;
    return {
      microphones: devices.filter((d) => d.kind === 'audioinput' && usable(d)),
      cameras: devices.filter((d) => d.kind === 'videoinput' && usable(d)),
      speakers: devices.filter((d) => d.kind === 'audiooutput' && usable(d)),
    };
  } catch {
    return { microphones: [], cameras: [], speakers: [] };
  }
}

/** Speaker selection needs HTMLMediaElement.setSinkId (Chromium; not iOS Safari). */
export function supportsAudioOutputSelection(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

export function supportsScreenShare(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && !isMobileClient();
}

function withDevice(base: MediaTrackConstraints, deviceId?: string | null): MediaTrackConstraints {
  return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
}

/** Single-kind capture for device switching mid-call. */
export async function getSingleTrack(kind: 'audio' | 'video', deviceId?: string | null): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia(
    kind === 'audio'
      ? { audio: withDevice(CALL_AUDIO, deviceId), video: false }
      : { audio: false, video: withDevice(videoConstraints(), deviceId) }
  );
  await tightenTracks(stream);
  const track = kind === 'audio' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
  if (!track) {
    throw new Error(kind === 'audio' ? 'No microphone available' : 'No camera available');
  }
  return track;
}

function isMobileClient(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}

/**
 * Voice-call capture. Browser AEC/NS/AGC run on 10 ms frames and add no meaningful
 * buffering; without AEC the far end hears its own voice back from laptop speakers.
 */
const CALL_AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
  latency: 0,
} as MediaTrackConstraints;

/**
 * Capture size drives simulcast: Chrome only emits 3 layers from ≥ 960x540,
 * 2 layers from 640x360. The encoder/BWE scales down under load.
 */
function videoConstraints(): MediaTrackConstraints {
  if (isMobileClient()) {
    return {
      facingMode: { ideal: 'user' },
      width: { ideal: 640, max: 960 },
      height: { ideal: 360, max: 540 },
      frameRate: { ideal: 30, max: 30 },
    };
  }

  return {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

/**
 * Best-effort local media. Call still works with an empty stream
 * when mic/camera are missing or busy.
 */
export async function getCallMedia(wantVideo: boolean, prefs: MediaDevicePrefs = {}): Promise<CallMediaResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: new MediaStream(), hasAudio: false, hasVideo: false };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: withDevice(CALL_AUDIO, prefs.audioDeviceId),
      video: wantVideo ? withDevice(videoConstraints(), prefs.videoDeviceId) : false,
    });
    await tightenTracks(stream);
    return {
      stream,
      hasAudio: stream.getAudioTracks().length > 0,
      hasVideo: stream.getVideoTracks().length > 0,
    };
  } catch {
    // fall through
  }

  const stream = new MediaStream();
  let hasAudio = false;
  let hasVideo = false;

  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    audioStream.getAudioTracks().forEach((track) => stream.addTrack(track));
    hasAudio = stream.getAudioTracks().length > 0;
  } catch {
    try {
      const basic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      basic.getAudioTracks().forEach((track) => stream.addTrack(track));
      hasAudio = stream.getAudioTracks().length > 0;
    } catch {
      // no mic
    }
  }

  if (wantVideo) {
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints(),
      });
      videoStream.getVideoTracks().forEach((track) => stream.addTrack(track));
      hasVideo = stream.getVideoTracks().length > 0;
    } catch {
      try {
        const fallback = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        fallback.getVideoTracks().forEach((track) => stream.addTrack(track));
        hasVideo = stream.getVideoTracks().length > 0;
      } catch {
        // no camera
      }
    }
  }

  await tightenTracks(stream);
  return { stream, hasAudio, hasVideo };
}

async function tightenTracks(stream: MediaStream): Promise<void> {
  for (const track of stream.getAudioTracks()) {
    try {
      track.contentHint = 'speech';
      track.enabled = true;
      await track.applyConstraints({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      } as MediaTrackConstraints);
    } catch {
      // ignore unsupported constraints
    }
  }

  for (const track of stream.getVideoTracks()) {
    try {
      track.contentHint = 'motion';
      await track.applyConstraints({
        frameRate: { ideal: 30, max: 30 },
      });
    } catch {
      // ignore
    }
  }
}

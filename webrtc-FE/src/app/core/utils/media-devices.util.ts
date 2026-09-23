export interface CallMediaResult {
  stream: MediaStream;
  hasAudio: boolean;
  hasVideo: boolean;
}

function isMobileClient(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
}

/**
 * Minimal capture processing = less algorithmic delay.
 * AEC/NS/AGC each add tens of ms; turn off for call latency.
 */
const LOW_LATENCY_AUDIO = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 48000,
  latency: 0,
} as MediaTrackConstraints;

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
    width: { ideal: 640, max: 960 },
    height: { ideal: 360, max: 540 },
    frameRate: { ideal: 24, max: 24 },
  };
}

/**
 * Best-effort local media. Call still works with an empty stream
 * when mic/camera are missing or busy.
 */
export async function getCallMedia(wantVideo: boolean): Promise<CallMediaResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: new MediaStream(), hasAudio: false, hasVideo: false };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: LOW_LATENCY_AUDIO,
      video: wantVideo ? videoConstraints() : false,
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
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
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
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
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

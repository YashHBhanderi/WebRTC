import { Injectable } from '@angular/core';

export type VideoEffect = 'none' | 'blur' | 'blur-strong';

export interface VideoEffectOption {
  id: VideoEffect;
  label: string;
  /** CSS background for the menu swatch. */
  swatch: string;
}

export const VIDEO_EFFECTS: VideoEffectOption[] = [
  { id: 'none', label: 'None', swatch: 'transparent' },
  { id: 'blur', label: 'Blur', swatch: 'radial-gradient(circle at 50% 40%, #94a3b8, #475569)' },
  { id: 'blur-strong', label: 'Strong blur', swatch: 'radial-gradient(circle at 50% 40%, #cbd5e1, #64748b)' },
];

// Pinned MediaPipe build, loaded on first use only (no npm dependency; ~10 MB of WASM, then cached)
const VISION_VERSION = '1.1.0';
const VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const VISION_BUNDLE = `${VISION_BASE}/vision_bundle.mjs`;
const SEGMENTER_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite';
// Foreground rules: the person stays sharp only while their face is clearly towards the camera and close enough
const FACE_MIN_SCORE = 0.6;
const FACE_KEEP_RATIO = 0.075; // face width / frame width at which a person becomes foreground
const FACE_DROP_RATIO = 0.05; // ...and below which they are fully background (in between: progressive)
const FACE_GRACE_MS = 700; // brief detection misses (blink, head turn) don't flicker the blur
const FACE_EVERY_N_FRAMES = 3;
// The person mask is computed on a small copy of the frame: fast, and plenty for a soft edge
const MASK_WIDTH = 256;
const PREF_KEY = 'videoEffect';

interface Pipeline {
  output: MediaStreamTrack;
  stop: () => void;
}

/**
 * Background blur / replacement for the camera. Each frame is segmented (MediaPipe selfie
 * segmenter) into person and background; only the background is blurred or replaced and the
 * person is drawn back sharp on top. Uses insertable streams (MediaStreamTrackProcessor) where
 * available, which keep running in background tabs; otherwise a requestVideoFrameCallback loop.
 */
@Injectable({ providedIn: 'root' })
export class VideoEffectsService {
  private segmenter: any = null;
  /** Optional: without it the effect still works but cannot tell who faces the camera */
  private faceDetector: any = null;
  private loading: Promise<any> | null = null;
  private pipeline: Pipeline | null = null;

  /** Canvas capture is required; WebGL is used when available (GPU), else CPU. */
  get supported(): boolean {
    return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
      && typeof (HTMLCanvasElement.prototype as any).captureStream === 'function';
  }

  get preferred(): VideoEffect {
    try {
      const value = localStorage.getItem(PREF_KEY) as VideoEffect | null;
      return value && VIDEO_EFFECTS.some((e) => e.id === value) ? value : 'none';
    } catch {
      return 'none';
    }
  }

  set preferred(effect: VideoEffect) {
    try {
      localStorage.setItem(PREF_KEY, effect);
    } catch {
      // ignore
    }
  }

  /**
   * A track showing `raw` with the effect applied ('none' returns `raw` itself). The returned
   * track is owned by this service until the next call to process()/stop(); `raw` stays the
   * caller's (it is never stopped here).
   */
  async process(raw: MediaStreamTrack, effect: VideoEffect): Promise<MediaStreamTrack> {
    this.stop();
    if (effect === 'none') {
      return raw;
    }
    if (!this.supported) {
      throw new Error('Background effects are not supported in this browser');
    }
    const segmenter = await this.loadSegmenter();
    // Each pipeline reads its own clone: tearing it down (which can end its input) never stops
    // the real camera, so effects can be switched any number of times
    const input = raw.clone();
    try {
      const pipeline = 'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window
        ? this.startProcessorPipeline(input, effect, segmenter)
        : await this.startVideoElementPipeline(input, effect, segmenter);
      this.pipeline = {
        output: pipeline.output,
        stop: () => {
          pipeline.stop();
          input.stop();
        },
      };
    } catch (error) {
      input.stop();
      throw error;
    }
    return this.pipeline.output;
  }

  stop(): void {
    this.pipeline?.stop();
    this.pipeline = null;
  }

  // ---------------------------------------------------------------- segmentation model

  private loadSegmenter(): Promise<any> {
    if (this.segmenter) {
      return Promise.resolve(this.segmenter);
    }
    if (!this.loading) {
      this.loading = (async () => {
        const vision: any = await import(/* webpackIgnore: true */ VISION_BUNDLE);
        const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);
        const options = (delegate: 'GPU' | 'CPU') => ({
          baseOptions: { modelAssetPath: SEGMENTER_MODEL, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        try {
          this.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, options('GPU'));
        } catch {
          this.segmenter = await vision.ImageSegmenter.createFromOptions(fileset, options('CPU'));
        }
        try {
          this.faceDetector = await vision.FaceDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            minDetectionConfidence: FACE_MIN_SCORE,
          });
        } catch (error) {
          console.warn('[effects] face detector unavailable; blurring without facing/distance rules:', error);
        }
        return this.segmenter;
      })().catch((error) => {
        this.loading = null;
        console.error('[effects] could not load the segmentation model:', error);
        throw new Error('Background effects could not be loaded. Check your connection and try again.');
      });
    }
    return this.loading;
  }

  // ---------------------------------------------------------------- compositing

  /** Draws `source` with the effect into `out`; returns false when the frame isn't ready. */
  private createCompositor(effect: VideoEffect, segmenter: any) {
    const out = document.createElement('canvas');
    const ctx = out.getContext('2d')!;
    const small = document.createElement('canvas');
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    const mask = document.createElement('canvas');
    const mctx = mask.getContext('2d')!;
    const bg = document.createElement('canvas');
    const bctx = bg.getContext('2d')!;
    let maskData: ImageData | null = null;
    // Primary face (normalised 0..1 box), how much of the person is kept (0..1), and housekeeping
    let primary: { cx: number; w: number; top: number; centres: number[] } | null = null;
    let lastFaceAt = 0;
    let keep = 0;
    let frameNo = 0;
    let lastTs = -1;
    // ctx.filter: Chromium/Firefox; Safari < 18 falls back to downscale-blur only
    const canFilter = (() => {
      ctx.filter = 'blur(2px)';
      const ok = ctx.filter === 'blur(2px)';
      ctx.filter = 'none';
      return ok;
    })();
    const blurPx = effect === 'blur-strong' ? 22 : 11;

    const resize = (w: number, h: number) => {
      if (out.width === w && out.height === h) {
        return;
      }
      out.width = w;
      out.height = h;
      small.width = MASK_WIDTH;
      small.height = Math.max(1, Math.round((MASK_WIDTH * h) / w));
      mask.width = small.width;
      mask.height = small.height;
      maskData = mctx.createImageData(mask.width, mask.height);
      // Blur works on a reduced copy (cheaper, and the downscale itself softens)
      const factor = canFilter ? 4 : effect === 'blur-strong' ? 24 : 12;
      bg.width = Math.max(1, Math.round(w / factor));
      bg.height = Math.max(1, Math.round(h / factor));
    };

    const draw = (source: CanvasImageSource, w: number, h: number, timestampMs: number) => {
      if (!w || !h) {
        return false;
      }
      resize(w, h);
      sctx.drawImage(source, 0, 0, small.width, small.height);
      const ts = timestampMs > lastTs ? timestampMs : lastTs + 1;
      lastTs = ts;
      const now = performance.now();

      // Who is the foreground? The largest clearly visible face (people facing away have none)
      const detector = this.faceDetector;
      if (detector && frameNo++ % FACE_EVERY_N_FRAMES === 0) {
        try {
          const faces = (detector.detectForVideo(small, ts)?.detections || [])
            .filter((d: any) => d.boundingBox && (d.categories?.[0]?.score ?? 0) >= FACE_MIN_SCORE)
            .map((d: any) => ({
              cx: (d.boundingBox.originX + d.boundingBox.width / 2) / small.width,
              w: d.boundingBox.width / small.width,
              top: d.boundingBox.originY / small.height,
            }))
            .sort((x: any, y: any) => y.w - x.w);
          if (faces.length) {
            primary = { ...faces[0], centres: faces.map((f: any) => f.cx) };
            lastFaceAt = now;
          }
        } catch {
          // keep the last result
        }
      }
      let target = 1;
      if (detector) {
        const seen = primary && now - lastFaceAt < FACE_GRACE_MS;
        // Too far away fades out progressively; no visible face means background
        target = seen ? Math.min(1, Math.max(0, (primary!.w - FACE_DROP_RATIO) / (FACE_KEEP_RATIO - FACE_DROP_RATIO))) : 0;
        if (!seen) primary = null;
      }
      keep += (target - keep) * 0.35;
      if (Math.abs(target - keep) < 0.01) keep = target;

      if (keep <= 0 && detector) {
        // Nobody to keep sharp: skip segmentation, the whole frame is background
        maskData?.data.fill(0);
        if (maskData) mctx.putImageData(maskData, 0, 0);
      } else {
        segmenter.segmentForVideo(small, ts, (result: any) => {
          const confidence = result?.confidenceMasks?.[0];
          if (!confidence || !maskData) {
            return;
          }
          const values: Float32Array = confidence.getAsFloat32Array();
          const px = maskData.data;
          const mw = mask.width;
          const p = primary;
          for (let i = 0; i < values.length; i++) {
            // Ease the edge: < 0.25 background, > 0.75 person, smooth in between
            let v = Math.min(1, Math.max(0, (values[i] - 0.25) * 2));
            if (v > 0 && p) {
              const x = (i % mw) / mw;
              // Keep this pixel only if it is nearest the primary face (not a neighbour's)
              // and within a person-sized window around it
              const dist = Math.abs(x - p.cx);
              const nearest = p.centres.every((c) => Math.abs(x - c) >= dist - 1e-6);
              const y = Math.floor(i / mw) / mask.height;
              if (!nearest || dist > p.w * 2.6 || y < p.top - p.w * 1.2) v = 0;
            }
            px[i * 4 + 3] = v * keep * 255;
          }
          mctx.putImageData(maskData, 0, 0);
        });
      }

      // 1) person alpha (scaled-up, feathered mask) 2) person pixels 3) background behind
      ctx.save();
      ctx.globalCompositeOperation = 'copy';
      if (canFilter) {
        ctx.filter = 'blur(3px)';
      }
      ctx.drawImage(mask, 0, 0, w, h);
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-in';
      ctx.drawImage(source, 0, 0, w, h);
      ctx.globalCompositeOperation = 'destination-over';
      if (canFilter) {
        bctx.filter = `blur(${Math.round(blurPx / 4)}px)`;
      }
      bctx.drawImage(source, 0, 0, bg.width, bg.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bg, 0, 0, w, h);
      ctx.restore();
      return true;
    };

    return { out, draw };
  }

  /** Chromium: frames in → effect → frames out; not throttled in background tabs. */
  private startProcessorPipeline(raw: MediaStreamTrack, effect: VideoEffect, segmenter: any): Pipeline {
    const W = window as any;
    const processor = new W.MediaStreamTrackProcessor({ track: raw, maxBufferSize: 1 });
    const generator = new W.MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    const { out, draw } = this.createCompositor(effect, segmenter);
    let running = true;

    void (async () => {
      while (running) {
        const { value: frame, done } = await reader.read().catch(() => ({ value: null, done: true }));
        if (done || !frame) {
          break;
        }
        try {
          if (draw(frame, frame.displayWidth, frame.displayHeight, frame.timestamp / 1000)) {
            const next = new W.VideoFrame(out, { timestamp: frame.timestamp });
            await writer.write(next);
          }
        } catch (error) {
          if (running) {
            console.warn('[effects] frame dropped:', error);
          }
        } finally {
          frame.close();
        }
      }
    })();

    return {
      output: generator as MediaStreamTrack,
      stop: () => {
        running = false;
        void reader.cancel().catch(() => undefined);
        void writer.close().catch(() => undefined);
        (generator as MediaStreamTrack).stop();
      },
    };
  }

  /** Other browsers: draw from a hidden <video> on each new frame and capture the canvas. */
  private async startVideoElementPipeline(raw: MediaStreamTrack, effect: VideoEffect, segmenter: any): Promise<Pipeline> {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([raw]);
    await video.play();
    const { out, draw } = this.createCompositor(effect, segmenter);
    draw(video, video.videoWidth, video.videoHeight, performance.now());
    const output = (out as any).captureStream(30).getVideoTracks()[0] as MediaStreamTrack;
    let running = true;
    let handle = 0;
    const tick = () => {
      if (!running) {
        return;
      }
      draw(video, video.videoWidth, video.videoHeight, performance.now());
      schedule();
    };
    const schedule = () => {
      const v = video as any;
      handle = typeof v.requestVideoFrameCallback === 'function' ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    schedule();
    return {
      output,
      stop: () => {
        running = false;
        const v = video as any;
        if (typeof v.cancelVideoFrameCallback === 'function') {
          v.cancelVideoFrameCallback(handle);
        } else {
          cancelAnimationFrame(handle);
        }
        video.pause();
        video.srcObject = null;
        output.stop();
      },
    };
  }
}

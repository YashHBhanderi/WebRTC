import { Injectable } from '@angular/core';

export interface RingtoneOption {
  id: string;
  label: string;
}

/** One ring: [frequency Hz, start s, length s] notes, repeated every `period` seconds. */
interface ToneSpec {
  notes: [number, number, number][];
  period: number;
  wave: OscillatorType;
  volume: number;
}

const TONES: Record<string, ToneSpec> = {
  classic: { notes: [[440, 0, 0.4], [480, 0, 0.4], [440, 0.6, 0.4], [480, 0.6, 0.4]], period: 3, wave: 'sine', volume: 0.12 },
  chime: { notes: [[1046.5, 0, 0.5], [1318.5, 0.18, 0.5], [1568, 0.36, 0.7]], period: 2.6, wave: 'sine', volume: 0.12 },
  digital: { notes: [[1200, 0, 0.09], [1200, 0.14, 0.09], [1200, 0.28, 0.09], [1200, 0.42, 0.09]], period: 1.6, wave: 'square', volume: 0.05 },
  marimba: { notes: [[523.3, 0, 0.25], [659.3, 0.2, 0.25], [784, 0.4, 0.25], [659.3, 0.6, 0.25], [523.3, 0.8, 0.35]], period: 2.4, wave: 'triangle', volume: 0.16 },
};

export const BUILT_IN_RINGTONES: RingtoneOption[] = [
  { id: 'classic', label: 'Classic' },
  { id: 'chime', label: 'Chime' },
  { id: 'digital', label: 'Digital' },
  { id: 'marimba', label: 'Marimba' },
];
export const DEFAULT_RINGTONE = 'classic';
export const CUSTOM_RINGTONE = 'custom';
export const MAX_CUSTOM_RINGTONE_BYTES = 3 * 1024 * 1024;

const PREF_KEY = 'ringtone';
const DB_NAME = 'meetchat-device';
const STORE = 'files';
const CUSTOM_KEY = 'ringtone';
// Built-in tones are scheduled ahead in one go, so background-tab timer throttling can't stall them
const MAX_RING_SECONDS = 90;

interface StoredFile {
  blob: Blob;
  name: string;
}

/**
 * Ringtone for incoming person-to-person calls, chosen per device (this browser). Built-in tones
 * are synthesized with Web Audio (no assets); a custom file lives in IndexedDB. If the chosen
 * ringtone can't play, the default one is used. Browsers only allow sound after the user has
 * interacted with the page once; `unlock()` runs on the first click/tap/key press.
 */
@Injectable({ providedIn: 'root' })
export class RingtoneService {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscillators: OscillatorNode[] = [];
  private audioEl: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private vibrateTimer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private session = 0;

  constructor() {
    const unlock = () => {
      this.unlock();
      ['pointerdown', 'keydown', 'touchend'].forEach((e) => document.removeEventListener(e, unlock, true));
    };
    ['pointerdown', 'keydown', 'touchend'].forEach((e) => document.addEventListener(e, unlock, true));
  }

  // ---------------------------------------------------------------- preference

  get selected(): string {
    try {
      const id = localStorage.getItem(PREF_KEY) || DEFAULT_RINGTONE;
      return id === CUSTOM_RINGTONE || TONES[id] ? id : DEFAULT_RINGTONE;
    } catch {
      return DEFAULT_RINGTONE;
    }
  }

  select(id: string): void {
    try {
      localStorage.setItem(PREF_KEY, id === CUSTOM_RINGTONE || TONES[id] ? id : DEFAULT_RINGTONE);
    } catch {
      // storage unavailable (private mode): the default ringtone is used
    }
  }

  async customName(): Promise<string | null> {
    return (await this.readCustom())?.name ?? null;
  }

  /** Validates (audio, size, decodable) and stores the file, then makes it the ringtone. */
  async setCustom(file: File): Promise<void> {
    if (!/^audio\//.test(file.type)) {
      throw new Error('Please choose an audio file (MP3, M4A, OGG or WAV).');
    }
    if (file.size > MAX_CUSTOM_RINGTONE_BYTES) {
      throw new Error('Ringtone files can be up to 3 MB.');
    }
    if (!(await this.canPlay(file))) {
      throw new Error("This browser can't play that file. Try an MP3.");
    }
    await this.writeCustom({ blob: file, name: file.name });
    this.select(CUSTOM_RINGTONE);
  }

  async removeCustom(): Promise<void> {
    await this.writeCustom(null);
    if (this.selected === CUSTOM_RINGTONE) {
      this.select(DEFAULT_RINGTONE);
    }
  }

  // ---------------------------------------------------------------- playback

  /** Ring until stop() (or MAX_RING_SECONDS). Vibrates on devices that support it. */
  async start(id = this.selected): Promise<void> {
    this.stop();
    const session = ++this.session;
    this.vibrate();
    if (id === CUSTOM_RINGTONE) {
      const file = await this.readCustom();
      if (session !== this.session) {
        return;
      }
      if (file && (await this.playFile(file.blob, session))) {
        return;
      }
      id = DEFAULT_RINGTONE;
    }
    this.playTone(TONES[id] || TONES[DEFAULT_RINGTONE], MAX_RING_SECONDS);
    this.stopTimer = setTimeout(() => this.stop(), MAX_RING_SECONDS * 1000);
  }

  /** A few seconds of a ringtone, for the settings screen. */
  async preview(id: string, seconds = 4): Promise<void> {
    await this.start(id);
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }
    this.stopTimer = setTimeout(() => this.stop(), seconds * 1000);
    try {
      navigator.vibrate?.(0);
    } catch {
      // ignore
    }
  }

  stop(): void {
    this.session++;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.vibrateTimer) {
      clearInterval(this.vibrateTimer);
      this.vibrateTimer = null;
      try {
        navigator.vibrate?.(0);
      } catch {
        // ignore
      }
    }
    this.oscillators.forEach((o) => {
      try {
        o.stop();
      } catch {
        // already stopped
      }
    });
    this.oscillators = [];
    this.master?.disconnect();
    this.master = null;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /** First user gesture: create/resume the audio context and prime the <audio> element (Safari). */
  unlock(): void {
    try {
      this.context()?.resume().catch(() => undefined);
      const el = this.element();
      el.muted = true;
      el.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      void el.play().then(() => el.pause()).catch(() => undefined).finally(() => { el.muted = false; });
    } catch {
      // ignore
    }
  }

  private playTone(spec: ToneSpec, seconds: number): void {
    const ctx = this.context();
    if (!ctx) {
      return;
    }
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    this.master = master;
    const t0 = ctx.currentTime + 0.05;
    for (let start = 0; start < seconds; start += spec.period) {
      for (const [freq, offset, len] of spec.notes) {
        const at = t0 + start + offset;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = spec.wave;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(spec.volume, at + 0.02);
        gain.gain.setValueAtTime(spec.volume, at + len * 0.7);
        gain.gain.linearRampToValueAtTime(0, at + len);
        osc.connect(gain).connect(master);
        osc.start(at);
        osc.stop(at + len + 0.02);
        this.oscillators.push(osc);
      }
    }
  }

  /** Loops the file; false if the browser refuses or can't decode it (caller falls back). */
  private async playFile(blob: Blob, session: number): Promise<boolean> {
    const el = this.element();
    this.objectUrl = URL.createObjectURL(blob);
    el.src = this.objectUrl;
    el.loop = true;
    el.volume = 1;
    try {
      await el.play();
      return session === this.session;
    } catch {
      return false;
    }
  }

  private vibrate(): void {
    const buzz = () => {
      try {
        navigator.vibrate?.([700, 300, 700]);
      } catch {
        // ignore
      }
    };
    buzz();
    this.vibrateTimer = setInterval(buzz, 2500);
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      this.ctx = Ctx ? new Ctx() : null;
    }
    return this.ctx;
  }

  private element(): HTMLAudioElement {
    if (!this.audioEl) {
      this.audioEl = new Audio();
      this.audioEl.preload = 'auto';
    }
    return this.audioEl;
  }

  private canPlay(file: Blob): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = new Audio();
      const url = URL.createObjectURL(file);
      const done = (ok: boolean) => {
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      probe.onloadedmetadata = () => done(true);
      probe.onerror = () => done(false);
      setTimeout(() => done(false), 5000);
      probe.preload = 'metadata';
      probe.src = url;
    });
  }

  // ---------------------------------------------------------------- IndexedDB (custom file)

  private db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async readCustom(): Promise<StoredFile | null> {
    try {
      const db = await this.db();
      return await new Promise((resolve) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(CUSTOM_KEY);
        req.onsuccess = () => resolve((req.result as StoredFile) || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  private async writeCustom(value: StoredFile | null): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      if (value) {
        store.put(value, CUSTOM_KEY);
      } else {
        store.delete(CUSTOM_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not save the ringtone on this device.'));
    });
  }
}

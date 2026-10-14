import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'app.theme';

/**
 * Light / dark / follow-the-OS theme, remembered per browser. Applies `data-theme` (our tokens in
 * styles.scss) and `data-bs-theme` (Bootstrap components) on <html>.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly mode$ = new BehaviorSubject<ThemeMode>(this.read());
  private media = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

  constructor() {
    this.media?.addEventListener?.('change', () => this.apply());
    this.apply();
  }

  get mode(): ThemeMode {
    return this.mode$.value;
  }

  get resolved(): 'light' | 'dark' {
    const mode = this.mode;
    if (mode === 'system') {
      return this.media?.matches ? 'dark' : 'light';
    }
    return mode;
  }

  set(mode: ThemeMode): void {
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // private mode / blocked storage: still applies for this session
    }
    this.mode$.next(mode);
    this.apply();
  }

  toggle(): void {
    this.set(this.resolved === 'dark' ? 'light' : 'dark');
  }

  private apply(): void {
    const root = document.documentElement;
    const theme = this.resolved;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    root.style.colorScheme = theme;
  }

  private read(): ThemeMode {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
    } catch {
      return 'system';
    }
  }
}

import { Injectable } from '@angular/core';

export interface ScreenShareOverlayHandlers {
  onToggleMute: () => void;
  onStopShare: () => void;
  onLeave?: () => void;
  isMuted: () => boolean;
  hasAudio: () => boolean;
}

/**
 * Floating controls while screen sharing (Document PiP when available).
 * Stays on top when switching tabs/apps in Chromium.
 */
@Injectable({
  providedIn: 'root',
})
export class ScreenShareOverlayService {
  private pipWindow: Window | null = null;
  private handlers: ScreenShareOverlayHandlers | null = null;
  private visibilityHandler: (() => void) | null = null;

  async show(handlers: ScreenShareOverlayHandlers): Promise<void> {
    this.handlers = handlers;
    await this.openPip();
    this.bindVisibility();
  }

  async hide(): Promise<void> {
    this.unbindVisibility();
    this.closePip();
    this.handlers = null;
  }

  refresh(): void {
    if (this.pipWindow && !this.pipWindow.closed) {
      this.renderPip(this.pipWindow);
    }
  }

  private bindVisibility(): void {
    this.unbindVisibility();
    this.visibilityHandler = () => {
      if (document.hidden && this.handlers) {
        void this.openPip();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private unbindVisibility(): void {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private async openPip(): Promise<void> {
    const dpi = (window as any).documentPictureInPicture;
    if (!dpi?.requestWindow) {
      return;
    }

    try {
      if (this.pipWindow && !this.pipWindow.closed) {
        this.renderPip(this.pipWindow);
        return;
      }

      const pip = await dpi.requestWindow({
        width: 340,
        height: 140,
      }) as Window;

      this.pipWindow = pip;

      pip.addEventListener('pagehide', () => {
        this.pipWindow = null;
      });

      this.renderPip(pip);
    } catch (error) {
      console.warn('Document PiP unavailable:', error);
    }
  }

  private closePip(): void {
    try {
      this.pipWindow?.close();
    } catch {
      // ignore
    }
    this.pipWindow = null;
  }

  private renderPip(win: Window): void {
    if (!this.handlers) {
      return;
    }

    const muted = this.handlers.isMuted();
    const hasAudio = this.handlers.hasAudio();

    win.document.head.innerHTML = `
      <style>
        body {
          margin: 0;
          font-family: system-ui, sans-serif;
          background: #111;
          color: #fff;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 10px;
          height: 100vh;
          user-select: none;
        }
        .label { font-size: 13px; opacity: 0.85; }
        .row { display: flex; gap: 10px; }
        button {
          width: 44px; height: 44px; border-radius: 50%;
          border: none; cursor: pointer; font-size: 16px;
          background: #333; color: #fff;
        }
        button.danger { background: #c62828; }
        button.primary { background: #1565c0; }
        button:disabled { opacity: 0.45; cursor: not-allowed; }
      </style>
    `;

    win.document.body.innerHTML = `
      <div class="label">You are sharing your screen</div>
      <div class="row">
        <button id="muteBtn" title="Mute" ${hasAudio ? '' : 'disabled'}>${muted || !hasAudio ? '🔇' : '🎤'}</button>
        <button id="stopBtn" class="primary" title="Stop sharing">🛑</button>
        <button id="leaveBtn" class="danger" title="Leave call">📞</button>
      </div>
    `;

    win.document.getElementById('muteBtn')?.addEventListener('click', () => {
      this.handlers?.onToggleMute();
      this.refresh();
    });
    win.document.getElementById('stopBtn')?.addEventListener('click', () => {
      this.handlers?.onStopShare();
    });
    win.document.getElementById('leaveBtn')?.addEventListener('click', () => {
      this.handlers?.onLeave?.();
    });
  }
}

import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpreeWeClient } from '@spreewe/chat-sdk';
import { SpwChatAppComponent } from '@spreewe/chat-angular';
import { AuthService } from '../core/services/auth.service';

/**
 * Embedded integration inside the SpreeWe app (same origin): the host provides the signed-in user's
 * Clerk session token; @spreewe/chat-sdk does E2EE, conversations, calls; @spreewe/chat-angular is the UI.
 * The standalone third-party example is examples/angular-app.
 */
@Component({
  selector: 'app-sdk-demo',
  standalone: true,
  imports: [CommonModule, SpwChatAppComponent],
  template: `
    <div class="demo">
      <p *ngIf="status">{{ status }}</p>
      <spw-chat-app *ngIf="ready && client" [client]="client"></spw-chat-app>
    </div>
  `,
  styles: [`.demo { padding: 16px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; } spw-chat-app { flex: 1; min-height: 0; }`],
})
export class SdkDemoComponent implements OnInit, OnDestroy {
  client: SpreeWeClient | null = null;
  ready = false;
  status = 'Starting…';

  constructor(private auth: AuthService) {}

  async ngOnInit(): Promise<void> {
    const origin = window.location.origin;
    this.client = new SpreeWeClient({
      // Same origin through the dev proxy (/api → backend, /socket.io → backend)
      apiUrl: `${origin}/api`,
      socketUrl: origin,
      getToken: () => this.auth.getToken({ skipCache: true }),
      wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
      deviceLabel: 'SDK demo',
    });
    try {
      await this.client.connect();
      this.ready = true;
      this.status = '';
    } catch (e: any) {
      this.status = `Could not start: ${e?.message || e}`;
    }
  }

  ngOnDestroy(): void {
    this.client?.disconnect();
  }
}

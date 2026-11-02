import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpreeWeClient } from '@spreewe/chat-sdk';
import { AuthService } from '../core/services/auth.service';
import { SpwChatComponent } from './spw-chat.component';

/**
 * SDK demo (prototype): the host app provides the signed-in user's Clerk session token; the SDK does
 * the rest (its own E2EE device, conversations, encrypted send / receive). No app secret in the browser.
 */
@Component({
  selector: 'app-sdk-demo',
  standalone: true,
  imports: [CommonModule, SpwChatComponent],
  template: `
    <div class="demo">
      <h2>SpreeWe SDK demo</h2>
      <p *ngIf="status">{{ status }}</p>
      <p *ngIf="client?.me">Signed in as <b>{{ client?.me?.name || client?.me?.username || client?.me?.email }}</b> · SDK device <code>{{ client?.deviceId }}</code></p>
      <spw-chat *ngIf="ready && client" [client]="client"></spw-chat>
    </div>
  `,
  styles: [`.demo { padding: 16px; height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; } spw-chat { flex: 1; }`],
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

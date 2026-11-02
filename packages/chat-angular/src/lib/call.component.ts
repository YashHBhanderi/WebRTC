import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, QueryList, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { CallInfo, CallMedia, SpreeWeClient } from '@spreewe/chat-sdk';
import { SPW_THEME } from './theme';

export type SpwCallPhase = 'incoming' | 'outgoing' | 'connecting' | 'lobby' | 'active' | 'ended';

/**
 * Call interface over the SDK: incoming (accept / decline), outgoing (cancel), active call with a
 * participant grid, mic / camera toggles, leave / end, recording start / stop and transcripts of the
 * conversation's recordings. Media runs in the browser through `client.calls.join` (mediasoup SFU).
 */
@Component({
  selector: 'spw-call',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel" *ngIf="call" role="dialog" aria-label="Call">
      <div class="title">
        <b>{{ call.callType === 'video' ? 'Video' : 'Audio' }} call</b>
        <span class="muted">{{ label }}</span>
        <span class="rec" *ngIf="recording">● REC</span>
      </div>

      <div class="actions" *ngIf="phase === 'incoming'">
        <button class="primary" type="button" (click)="accept()">Accept</button>
        <button class="danger" type="button" (click)="decline()">Decline</button>
      </div>

      <ng-container *ngIf="phase === 'outgoing' || phase === 'connecting' || phase === 'lobby' || phase === 'active'">
        <div class="grid">
          <div class="tile">
            <video #local autoplay playsinline muted [hidden]="call.callType !== 'video'"></video>
            <span class="name">You{{ micOn ? '' : ' (muted)' }}</span>
          </div>
          <div class="tile" *ngFor="let p of remote; trackBy: byUser">
            <video #remote [attr.data-user]="p.userId" autoplay playsinline></video>
            <span class="name">{{ nameFor(p.userId) }}</span>
          </div>
        </div>
        <div class="actions">
          <button type="button" (click)="toggleMic()" [disabled]="!media">{{ micOn ? 'Mute' : 'Unmute' }}</button>
          <button type="button" *ngIf="call.callType === 'video'" (click)="toggleCam()" [disabled]="!media">{{ camOn ? 'Camera off' : 'Camera on' }}</button>
          <button type="button" *ngIf="allowRecording" (click)="toggleRecording()" [disabled]="phase !== 'active'">{{ recording ? 'Stop recording' : 'Record' }}</button>
          <button class="danger" type="button" (click)="leave()">Leave</button>
          <button class="danger" type="button" *ngIf="isHost" (click)="endForAll()">End for all</button>
        </div>
      </ng-container>

      <div class="ended" *ngIf="phase === 'ended'">
        <span class="muted">Call ended</span>
        <button type="button" *ngIf="allowRecording" (click)="loadTranscripts()">Recordings &amp; transcripts</button>
        <button type="button" (click)="closed.emit()">Close</button>
      </div>
      <div class="transcripts" *ngIf="recordings?.length">
        <div *ngFor="let r of recordings">
          <b>{{ r.createdAt | date: 'short' }}</b> <span class="muted">{{ r.transcriptStatus || r.status }}</span>
          <button type="button" (click)="showTranscript(r)">Transcript</button>
          <pre *ngIf="transcripts[r._id]">{{ transcripts[r._id] }}</pre>
        </div>
      </div>
      <div class="error" *ngIf="error" role="alert">{{ error }}</div>
    </div>
  `,
  styles: [SPW_THEME, `
    .panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--spw-bg); border: 1px solid var(--spw-border); border-radius: var(--spw-radius); }
    .title { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .rec { color: var(--spw-danger); font-weight: 600; }
    .grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
    .tile { position: relative; background: #0f1418; border-radius: var(--spw-radius); min-height: 120px; display: flex; align-items: flex-end; overflow: hidden; }
    .tile video { width: 100%; height: 100%; object-fit: cover; position: absolute; inset: 0; }
    .tile .name { position: relative; color: #fff; font-size: 12px; padding: 4px 8px; background: rgba(0,0,0,.45); border-top-right-radius: var(--spw-radius); }
    .actions, .ended { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    pre { white-space: pre-wrap; max-height: 200px; overflow: auto; background: var(--spw-surface); padding: 8px; border-radius: var(--spw-radius); }
  `],
})
export class SpwCallComponent implements OnChanges, OnDestroy {
  @Input() client!: SpreeWeClient;
  @Input() call: CallInfo | null = null;
  /** 'incoming' for a ring you received, 'outgoing' for a call you started */
  @Input() direction: 'incoming' | 'outgoing' = 'incoming';
  @Input() allowRecording = true;
  /** userId → display name */
  @Input() names: Record<string, string> = {};
  @Output() closed = new EventEmitter<void>();

  @ViewChildren('local') localVideo!: QueryList<ElementRef<HTMLVideoElement>>;
  @ViewChildren('remote') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;

  phase: SpwCallPhase = 'incoming';
  media: CallMedia | null = null;
  remote: { userId: string; stream: MediaStream }[] = [];
  micOn = true;
  camOn = true;
  recording = false;
  error = '';
  recordings: any[] | null = null;
  transcripts: Record<string, string> = {};
  private offs: (() => void)[] = [];

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  get isHost(): boolean { return !!this.call && this.call.initiatedBy === String(this.client?.me?._id); }
  get label(): string {
    return { incoming: 'Incoming…', outgoing: 'Calling…', connecting: 'Connecting…', lobby: 'Waiting for the host to let you in', active: 'Connected', ended: 'Ended' }[this.phase];
  }

  byUser = (_: number, p: { userId: string }) => p.userId;
  nameFor(userId: string): string { return this.names[userId] || 'Participant'; }

  async ngOnChanges(): Promise<void> {
    this.cleanup();
    if (!this.call) return;
    const callId = this.call.callId;
    const run = (fn: () => void) => this.zone.run(() => { fn(); this.cdr.markForCheck(); });
    const on = this.client.events.on.bind(this.client.events);
    this.offs.push(
      on('call.ended', (p) => String(p.callId) === callId && run(() => this.finish())),
      on('call.removed', (p: any) => String(p?.callId) === callId && run(() => this.finish())),
      on('call.participant-joined', (p) => String(p.callId) === callId && this.phase === 'outgoing' && run(() => (this.phase = 'active'))),
      on('recording.updated', (p: any) => String(p?.callId) === callId && run(() => (this.recording = p?.status === 'recording' || p?.active === true))),
    );
    this.phase = this.direction;
    // The caller joins media right away; the callee after accepting
    if (this.direction === 'outgoing') await this.joinMedia();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  async accept(): Promise<void> {
    if (!this.call) return;
    try {
      await this.client.calls.accept(this.call.callId);
      await this.joinMedia();
    } catch (e: any) {
      this.fail(e);
    }
  }

  decline(): void {
    if (this.call) this.client.calls.reject(this.call.callId);
    this.finish();
  }

  leave(): void {
    if (this.call) this.client.calls.leave(this.call.callId);
    this.finish();
  }

  async endForAll(): Promise<void> {
    if (!this.call) return;
    try { await this.client.calls.end(this.call.callId); } catch (e: any) { this.fail(e); }
    this.finish();
  }

  toggleMic(): void {
    this.micOn = !this.micOn;
    this.media?.setMicEnabled(this.micOn);
    if (this.call) this.client.calls.controls.mediaState(this.call.callId, this.micOn, this.camOn);
  }

  toggleCam(): void {
    this.camOn = !this.camOn;
    this.media?.setCameraEnabled(this.camOn);
    if (this.call) this.client.calls.controls.mediaState(this.call.callId, this.micOn, this.camOn);
  }

  async toggleRecording(): Promise<void> {
    if (!this.call) return;
    try {
      if (this.recording) await this.client.calls.controls.stopRecording(this.call.callId);
      else await this.client.calls.controls.startRecording(this.call.callId);
      this.recording = !this.recording;
    } catch (e: any) {
      this.fail(e);
    }
    this.cdr.markForCheck();
  }

  async loadTranscripts(): Promise<void> {
    if (!this.call) return;
    try {
      this.recordings = (await this.client.recordings.list(this.call.conversationId)) || [];
    } catch (e: any) {
      this.fail(e);
    }
    this.cdr.markForCheck();
  }

  async showTranscript(r: any): Promise<void> {
    try {
      const t = await this.client.recordings.transcript(String(r._id));
      this.transcripts = { ...this.transcripts, [r._id]: typeof t === 'string' ? t : t?.text || (t?.segments || []).map((s: any) => s.text).join('\n') || 'No transcript yet' };
    } catch (e: any) {
      this.fail(e);
    }
    this.cdr.markForCheck();
  }

  private async joinMedia(): Promise<void> {
    if (!this.call) return;
    this.phase = this.direction === 'outgoing' ? 'outgoing' : 'connecting';
    this.cdr.markForCheck();
    try {
      this.media = await this.client.calls.join(this.call.callId, this.call.callType, {
        onLobby: () => this.zone.run(() => { this.phase = 'lobby'; this.cdr.markForCheck(); }),
        onRemoteStream: (userId, stream) => this.zone.run(() => this.setRemote(userId, stream)),
        onRemoteLeft: (userId) => this.zone.run(() => this.setRemote(userId, null)),
      });
      if (this.direction === 'incoming' || this.remote.length) this.phase = 'active';
      this.cdr.detectChanges();
      const local = this.localVideo.first?.nativeElement;
      if (local && this.media.localStream) local.srcObject = this.media.localStream;
    } catch (e: any) {
      this.fail(e);
    }
    this.cdr.markForCheck();
  }

  private setRemote(userId: string, stream: MediaStream | null): void {
    this.remote = stream ? [...this.remote.filter((p) => p.userId !== userId), { userId, stream }] : this.remote.filter((p) => p.userId !== userId);
    if (stream && this.phase !== 'active') this.phase = 'active';
    this.cdr.detectChanges();
    this.remoteVideos.forEach((ref) => {
      const p = this.remote.find((x) => x.userId === ref.nativeElement.dataset['user']);
      if (p && ref.nativeElement.srcObject !== p.stream) ref.nativeElement.srcObject = p.stream;
    });
  }

  private fail(e: any): void {
    this.error = e?.message || 'Call error';
    this.cdr.markForCheck();
  }

  private finish(): void {
    this.media?.close();
    this.media = null;
    this.remote = [];
    this.phase = 'ended';
    this.cdr.markForCheck();
  }

  private cleanup(): void {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.media?.close();
    this.media = null;
    this.remote = [];
    this.recording = false;
    this.recordings = null;
    this.error = '';
  }
}

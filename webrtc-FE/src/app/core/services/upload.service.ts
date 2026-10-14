import { HttpClient, HttpContext, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';
import { environment } from 'src/environments/environment';
import { UploadResult } from '../interfaces/chat';
import { normalizeError } from '../errors/app-error';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { MessageSenderService } from './message-sender.service';
import { SocketService } from './socket.service';

export type UploadState = 'queued' | 'uploading' | 'failed';

export interface UploadJob {
  id: string;
  conversationId: string;
  file: File;
  /** Caption sent with the file (first file of a batch only) */
  caption: string;
  replyToId: string | null;
  mentionIds: string[];
  state: UploadState;
  /** 0–100 */
  progress: number;
  error?: string;
  /** Object URL for an image thumbnail while it uploads */
  previewUrl?: string;
}

/** Client-side mirror of the server's rules (webrtc-BE file.service MEDIA_RULES) for instant feedback. */
const MB = 1024 * 1024;
const RULES: { kind: string; label: string; maxMb: number; test: (f: File, ext: string) => boolean }[] = [
  { kind: 'image', label: 'Photos', maxMb: 10, test: (f) => /^image\/(jpeg|png|gif|webp)$/.test(f.type) },
  { kind: 'video', label: 'Videos', maxMb: 100, test: (f) => /^video\/(mp4|webm|quicktime)$/.test(f.type) },
  { kind: 'audio', label: 'Audio files', maxMb: 25, test: (f) => f.type.startsWith('audio/') },
  { kind: 'pdf', label: 'PDF files', maxMb: 25, test: (f, ext) => f.type === 'application/pdf' || ext === 'pdf' },
  {
    kind: 'file',
    label: 'Documents and archives',
    maxMb: 50,
    test: (_f, ext) => ['zip', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'txt', 'log', 'csv', 'md'].includes(ext),
  },
];
export const UPLOAD_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,'
  + '.zip,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.txt,.log,.csv,.md';
export const MAX_FILES_PER_SEND = 10;
const CONCURRENCY = 2;

/** Why a file can't be sent, or null when it can. */
export function validateUpload(file: File): string | null {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const rule = RULES.find((r) => r.test(file, ext));
  if (!rule) {
    return `${file.name}: this file type isn't supported.`;
  }
  if (!file.size) {
    return `${file.name} is empty.`;
  }
  if (file.size > rule.maxMb * MB) {
    return `${file.name} is too large. ${rule.label} can be up to ${rule.maxMb} MB.`;
  }
  return null;
}

/**
 * Background attachment uploads with progress, cancel and retry. A finished upload is sent as a
 * message right away; failures stay listed (with Retry) instead of interrupting the user.
 */
@Injectable({ providedIn: 'root' })
export class UploadService {
  readonly jobs$ = new BehaviorSubject<UploadJob[]>([]);
  private running = new Map<string, Subscription>();
  private seq = 0;

  constructor(private http: HttpClient, private socket: SocketService, private sender: MessageSenderService) {}

  jobsFor(conversationId: string): UploadJob[] {
    return this.jobs$.value.filter((j) => j.conversationId === conversationId);
  }

  /** Queue files for a chat. The caption / reply / mentions go with the first file. */
  enqueue(conversationId: string, files: File[], opts: { caption?: string; replyToId?: string | null; mentionIds?: string[] } = {}): void {
    const jobs: UploadJob[] = files.map((file, i) => ({
      id: `up-${Date.now()}-${++this.seq}`,
      conversationId,
      file,
      caption: i === 0 ? (opts.caption || '').trim() : '',
      replyToId: i === 0 ? opts.replyToId || null : null,
      mentionIds: i === 0 ? opts.mentionIds || [] : [],
      state: 'queued',
      progress: 0,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    this.jobs$.next([...this.jobs$.value, ...jobs]);
    this.pump();
  }

  cancel(id: string): void {
    this.running.get(id)?.unsubscribe();
    this.running.delete(id);
    this.remove(id);
    this.pump();
  }

  retry(id: string): void {
    this.patch(id, { state: 'queued', progress: 0, error: undefined });
    this.pump();
  }

  private pump(): void {
    while (this.running.size < CONCURRENCY) {
      const next = this.jobs$.value.find((j) => j.state === 'queued');
      if (!next) {
        return;
      }
      this.start(next);
    }
  }

  private start(job: UploadJob): void {
    this.patch(job.id, { state: 'uploading', progress: 0 });
    const form = new FormData();
    form.append('purpose', 'message');
    form.append('conversationId', job.conversationId);
    form.append('file', job.file);
    const sub = this.http
      .post<UploadResult>(`${environment.apiUrl}/upload`, form, {
        reportProgress: true,
        observe: 'events',
        // Failures are shown on the upload card itself
        context: new HttpContext().set(SKIP_ERROR_TOAST, true),
      })
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            // Keep the last few percent for server-side processing
            this.patch(job.id, { progress: Math.min(95, Math.round((event.loaded / event.total) * 95)) });
          } else if (event.type === HttpEventType.Response && event.body) {
            this.finish(job, event.body);
          }
        },
        error: (error: HttpErrorResponse | string) => {
          this.running.delete(job.id);
          const message = typeof error === 'string' ? error : normalizeError(error, "We couldn't upload the file. Please try again.").message;
          this.patch(job.id, { state: 'failed', error: message });
          this.pump();
        },
      });
    this.running.set(job.id, sub);
  }

  private finish(job: UploadJob, uploaded: UploadResult): void {
    this.running.delete(job.id);
    this.socket.sendMessage({
      user: this.sender.currentUserPayload(),
      conversationId: job.conversationId,
      content: job.caption,
      type: uploaded.type,
      storageKey: uploaded.storageKey,
      replyTo: job.replyToId,
      ...(job.mentionIds.length ? { mentions: job.mentionIds } : {}),
    } as any);
    this.remove(job.id);
    this.pump();
  }

  private patch(id: string, changes: Partial<UploadJob>): void {
    this.jobs$.next(this.jobs$.value.map((j) => (j.id === id ? { ...j, ...changes } : j)));
  }

  private remove(id: string): void {
    const job = this.jobs$.value.find((j) => j.id === id);
    if (job?.previewUrl) {
      URL.revokeObjectURL(job.previewUrl);
    }
    this.jobs$.next(this.jobs$.value.filter((j) => j.id !== id));
  }
}

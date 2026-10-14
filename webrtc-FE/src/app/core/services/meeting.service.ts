import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import { environment } from 'src/environments/environment';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';

export type RecurrenceFreq = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Recurrence {
  freq: RecurrenceFreq;
  interval: number;
  byWeekday?: number[];
  until?: string | null;
  count?: number | null;
}

export interface MeetingPerson {
  _id: string;
  username: string;
  avatar?: string;
}

export interface MeetingSummary {
  _id: string;
  title: string;
  description: string;
  organizer: MeetingPerson;
  invitees: MeetingPerson[];
  isOrganizer: boolean;
  conversationId: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  recurrence: Recurrence | null;
  recurrenceText: string;
  code: string;
  hasPassword: boolean;
  lobby: boolean;
  status: 'scheduled' | 'cancelled';
  activeCallId: string | null;
}

/** One calendar entry: a meeting occurrence. */
export interface MeetingOccurrence extends MeetingSummary {
  occurrenceStart: string;
  occurrenceEnd: string;
}

export interface MeetingInput {
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  invitees: string[];
  recurrence: Recurrence | null;
  lobby: boolean;
  /** string = set, '' = remove, undefined = keep */
  password?: string;
}

export interface MeetingPreview {
  meetingId: string | null;
  code: string;
  title: string;
  organizerName: string;
  startAt: string;
  endAt: string;
  recurrence: string;
  invited: boolean;
  needsPassword: boolean;
  cancelled: boolean;
  conversationId: string | null;
}

@Injectable({ providedIn: 'root' })
export class MeetingApiService {
  private readonly api = `${environment.apiUrl}/meetings`;

  constructor(private http: HttpClient) {}

  range(from: Date, to: Date): Promise<MeetingOccurrence[]> {
    const params = new HttpParams().set('from', from.toISOString()).set('to', to.toISOString());
    return firstValueFrom(this.http.get<{ data: MeetingOccurrence[] }>(this.api, { params, context: this.quiet() }).pipe(map((r) => r.data)));
  }

  get(id: string): Promise<MeetingSummary> {
    return firstValueFrom(this.http.get<{ data: MeetingSummary }>(`${this.api}/${id}`).pipe(map((r) => r.data)));
  }

  create(input: MeetingInput): Promise<MeetingSummary> {
    return firstValueFrom(this.http.post<{ data: MeetingSummary }>(this.api, input, { context: this.quiet() }).pipe(map((r) => r.data)));
  }

  update(id: string, input: Partial<MeetingInput>): Promise<MeetingSummary> {
    return firstValueFrom(this.http.patch<{ data: MeetingSummary }>(`${this.api}/${id}`, input, { context: this.quiet() }).pipe(map((r) => r.data)));
  }

  cancel(id: string, occurrence?: string): Promise<unknown> {
    const params = occurrence ? new HttpParams().set('occurrence', occurrence) : undefined;
    return firstValueFrom(this.http.delete(`${this.api}/${id}`, { params }));
  }

  preview(code: string): Promise<MeetingPreview> {
    return firstValueFrom(this.http.get<{ data: MeetingPreview }>(`${this.api}/code/${encodeURIComponent(code)}`, { context: this.quiet() }).pipe(map((r) => r.data)));
  }

  join(code: string, password?: string): Promise<{ meetingId: string; conversationId: string }> {
    return firstValueFrom(this.http.post<{ data: { meetingId: string; conversationId: string } }>(
      `${this.api}/code/${encodeURIComponent(code)}/join`, { password }, { context: this.quiet() },
    ).pipe(map((r) => r.data)));
  }

  linkFor(code: string): string {
    return `${window.location.origin}/meet/${code}`;
  }

  /** The page shows these errors itself (forms, inline states). */
  private quiet(): HttpContext {
    return new HttpContext().set(SKIP_ERROR_TOAST, true);
  }
}

import { Injectable } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { RAW_ERRORS } from '../interceptors/error.interceptor';

export type ContactScope = 'member' | 'external';

export interface ContactLookup {
  found: boolean;
  message?: string;
  user?: { _id: string; username: string; avatar: string };
  external?: boolean;
  conversationId?: string | null;
}

/** Client-side check only, to give instant feedback; the server validates again. */
export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * Finding someone by exact email (there is no public directory). The server decides eligibility
 * (blocking, privacy, membership, the organization's external policy) and rate-limits lookups.
 * Errors are rethrown raw so callers can show policy / rate-limit messages precisely.
 */
@Injectable({ providedIn: 'root' })
export class ContactService {
  private readonly api = `${environment.apiUrl}/v1/contacts`;

  constructor(private http: HttpClient) {}

  async lookup(email: string, scope?: ContactScope): Promise<ContactLookup> {
    const res = await firstValueFrom(this.http.post<{ data: ContactLookup }>(`${this.api}/lookup`, { email, ...(scope ? { scope } : {}) }, { context: new HttpContext().set(RAW_ERRORS, true) }));
    return res.data;
  }

  async start(email: string, scope?: ContactScope): Promise<{ conversationId: string; external: boolean }> {
    const res = await firstValueFrom(this.http.post<{ data: { conversationId: string; external: boolean } }>(`${this.api}/start`, { email, ...(scope ? { scope } : {}) }, { context: new HttpContext().set(RAW_ERRORS, true) }));
    return res.data;
  }
}

/** The server's message from a raw HTTP error (v1 envelope), with a fallback. */
export function contactError(e: unknown): string {
  const err = e as { status?: number; error?: { error?: { message?: string } } };
  if (err?.status === 429) return err.error?.error?.message || 'Too many lookups. Please wait a few minutes and try again.';
  if (err?.status === 0) return "You're offline. Check your connection and try again.";
  return err?.error?.error?.message || 'Something went wrong. Please try again.';
}

import { HttpErrorResponse } from '@angular/common/http';

export type AppErrorCode =
  | 'ACTIONABLE_USER_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'PERMISSION_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'CONFLICT_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'UNKNOWN_ERROR';

export interface NormalizedError {
  code: AppErrorCode;
  /** Safe, user-facing text. Never a raw exception / stack / infrastructure detail. */
  message: string;
  /** True when the user can do something about it (fix input, sign in, pick another file...). */
  actionable: boolean;
  status?: number;
}

const GENERIC = 'Something went wrong. Please try again.';

const CODE_BY_STATUS: Record<number, AppErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'AUTHENTICATION_ERROR',
  403: 'PERMISSION_ERROR',
  404: 'NOT_FOUND_ERROR',
  409: 'CONFLICT_ERROR',
  413: 'VALIDATION_ERROR',
  415: 'VALIDATION_ERROR',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMIT_ERROR',
};

const DEFAULT_MESSAGE: Partial<Record<AppErrorCode, string>> = {
  AUTHENTICATION_ERROR: 'Your session has expired. Please sign in again.',
  PERMISSION_ERROR: "You don't have permission to perform this action.",
  NOT_FOUND_ERROR: "We couldn't find what you were looking for.",
  RATE_LIMIT_ERROR: "You're doing that too often. Please wait a moment and try again.",
  NETWORK_ERROR: "You're offline or the server can't be reached. Check your connection and try again.",
};

/**
 * Turns any HTTP / socket / thrown error into a classified, safe message.
 * `fallback` is the contextual message for internal failures ("We couldn't send the message...").
 */
export function normalizeError(error: unknown, fallback = GENERIC): NormalizedError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return { code: 'NETWORK_ERROR', message: DEFAULT_MESSAGE.NETWORK_ERROR!, actionable: true, status: 0 };
    }
    if (error.status === 413) {
      // Usually the reverse proxy's body-size limit (an HTML page with no JSON message)
      return { code: 'VALIDATION_ERROR', message: 'This file is too large. Please choose a smaller file.', actionable: true, status: 413 };
    }
    if (error.status >= 500) {
      return { code: 'SERVER_ERROR', message: fallback, actionable: false, status: error.status };
    }
    const code = (error.error?.error?.code as AppErrorCode) || CODE_BY_STATUS[error.status] || 'ACTIONABLE_USER_ERROR';
    // 4xx messages come from AppError on the server, which are written to be user-facing
    const serverMessage = typeof error.error?.message === 'string' ? error.error.message : '';
    return { code, message: serverMessage || DEFAULT_MESSAGE[code] || fallback, actionable: true, status: error.status };
  }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return normalizeMediaError(error, fallback);
  }
  if (typeof error === 'string' && error.trim()) {
    // Legacy: the interceptor and socket acks already produce safe strings
    return { code: 'ACTIONABLE_USER_ERROR', message: error, actionable: true };
  }
  return { code: 'UNKNOWN_ERROR', message: fallback, actionable: false };
}

/** getUserMedia / getDisplayMedia failures. */
export function normalizeMediaError(error: DOMException, fallback = GENERIC, kind: 'camera' | 'microphone' | 'screen' = 'camera'): NormalizedError {
  const device = kind === 'microphone' ? 'Microphone' : kind === 'screen' ? 'Screen sharing' : 'Camera';
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'PERMISSION_ERROR',
        message: kind === 'screen'
          ? 'Screen sharing was blocked. Check your browser permissions and try again.'
          : `${device} unavailable. Check your ${kind} permissions or select another ${kind}.`,
        actionable: true,
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'NotReadableError':
      return { code: 'ACTIONABLE_USER_ERROR', message: `${device} unavailable. Check your ${kind} permissions or select another ${kind}.`, actionable: true };
    case 'AbortError':
      return { code: 'UNKNOWN_ERROR', message: fallback, actionable: false };
    default:
      return { code: 'UNKNOWN_ERROR', message: fallback, actionable: false };
  }
}

/** Errors that should never produce a toast (user cancelled, component torn down...). */
export function isSilentError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return false;
}

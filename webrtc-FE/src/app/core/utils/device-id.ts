const KEY = 'callDeviceId';
let cached = '';

/**
 * Identifies this browser tab to the server's call sessions. Kept in sessionStorage: a reload or
 * socket reconnect of the same tab keeps its call, while another tab/browser/device is a different
 * device (and must take the call over explicitly).
 */
export function callDeviceId(): string {
  if (cached) {
    return cached;
  }
  try {
    cached = sessionStorage.getItem(KEY) || '';
  } catch {
    // storage blocked: one id for this page's lifetime
  }
  if (!/^[\w-]{8,64}$/.test(cached)) {
    cached = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try {
      sessionStorage.setItem(KEY, cached);
    } catch {
      // ignore
    }
  }
  return cached;
}

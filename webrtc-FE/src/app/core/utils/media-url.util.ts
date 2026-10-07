import { environment } from 'src/environments/environment';

const trimBase = (url: string | null | undefined) => (url || '').trim().replace(/\/+$/, '');

// Replaced at startup by the backend's value (GET /config, from its .env); the build value is a fallback
let base = trimBase(environment.s3BaseUrl);
// Links stored before the backend switched to plain keys (still in old JWTs / localStorage)
const LEGACY_FILE_LINK = /^(?:https?:\/\/[^/]+)?\/api\/files\//;

export function setMediaBaseUrl(url: string | null | undefined): void {
  if (trimBase(url)) {
    base = trimBase(url);
  }
}

/**
 * URL for a stored picture. The backend sends S3 keys for public objects
 * (e.g. "production/users/{id}/avatar/{uuid}.png"); full URLs (pre-signed attachments, legacy
 * external pictures) and local previews (data:/blob:) are used as they are.
 */
export function mediaUrl(value: string | null | undefined): string {
  const v = (value || '').trim();
  if (!v || (/^(?:https?:|data:|blob:)/i.test(v) && !LEGACY_FILE_LINK.test(v))) {
    return v;
  }
  return `${base}/${v.replace(LEGACY_FILE_LINK, '').replace(/^\/+/, '')}`;
}

/** APP_INITIALIZER: load the bucket address from the backend; never blocks startup for long. */
export function loadMediaBaseUrl(): () => Promise<void> {
  return async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${environment.apiUrl}/config`, { signal: ctrl.signal });
      if (res.ok) {
        setMediaBaseUrl((await res.json())?.data?.s3BaseUrl);
      }
    } catch {
      // Backend unreachable: keep the build-time fallback
    } finally {
      clearTimeout(timer);
    }
  };
}

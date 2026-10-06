import { environment } from 'src/environments/environment';

const BASE = environment.s3BaseUrl.replace(/\/+$/, '');
// Links stored before the backend switched to plain keys (still in old JWTs / localStorage)
const LEGACY_FILE_LINK = /^(?:https?:\/\/[^/]+)?\/api\/files\//;

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
  return `${BASE}/${v.replace(LEGACY_FILE_LINK, '').replace(/^\/+/, '')}`;
}

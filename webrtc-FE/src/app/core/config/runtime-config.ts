import { environment } from 'src/environments/environment';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { setMediaBaseUrl } from 'src/app/core/utils/media-url.util';

/** Public settings the backend serves from its .env (GET /config), so builds carry no keys. */
export interface RuntimeConfig {
  s3BaseUrl?: string;
  clerkPublishableKey?: string;
}

async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${environment.apiUrl}/config`, { signal: ctrl.signal });
    return res.ok ? ((await res.json())?.data as RuntimeConfig) || {} : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** APP_INITIALIZER: bucket address for pictures + Clerk, before any route or guard runs. */
export function initRuntime(clerk: ClerkService): () => Promise<void> {
  return async () => {
    const config = await fetchRuntimeConfig();
    setMediaBaseUrl(config.s3BaseUrl);
    await clerk.init(config.clerkPublishableKey);
  };
}

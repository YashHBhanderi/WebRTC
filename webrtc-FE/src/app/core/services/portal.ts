/**
 * Which SpreeWe portal this browser is using: the personal app (chat, calls, meetings…) or the
 * Developer Portal (applications, credentials, permissions, webhooks, API docs).
 *
 * Both portals use the same SpreeWe account (one Clerk sign-in). The portal is chosen on the public
 * landing page / sign-in link and remembered in localStorage so refreshes, deep links and full
 * reloads (workspace switch, account switch) land in the same portal.
 *
 * This separates the two user interfaces; it is NOT a server-side permission. The developer APIs
 * require a first-party SpreeWe session either way.
 */
export type Portal = 'personal' | 'developer';

const PORTAL_KEY = 'spreewe.portal';

export const PORTAL_HOME: Record<Portal, string> = {
  personal: '/chat',
  developer: '/developer',
};

export function parsePortal(value: string | null | undefined): Portal | null {
  return value === 'personal' || value === 'developer' ? value : null;
}

/** Portal a URL inside the app belongs to (null for portal-neutral pages such as /consent). */
export function portalOfUrl(url: string | null | undefined): Portal | null {
  if (!url || !url.startsWith('/')) return null;
  if (url === '/developer' || url.startsWith('/developer/') || url.startsWith('/developer?')) return 'developer';
  if (url === '/' || url.startsWith('/auth') || url.startsWith('/consent')) return null;
  return 'personal';
}

export function getPortal(): Portal {
  try {
    return parsePortal(localStorage.getItem(PORTAL_KEY)) ?? 'personal';
  } catch {
    return 'personal';
  }
}

export function setPortal(portal: Portal): void {
  try {
    localStorage.setItem(PORTAL_KEY, portal);
  } catch {
    // storage blocked: the default (personal) applies
  }
}

export function clearPortal(): void {
  try {
    localStorage.removeItem(PORTAL_KEY);
  } catch {
    // ignore
  }
}

export function portalHome(portal: Portal = getPortal()): string {
  return PORTAL_HOME[portal];
}

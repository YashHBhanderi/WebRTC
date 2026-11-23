import { ClerkService } from 'src/app/core/services/clerk.service';

/**
 * After the server added me to an organization (created, accepted, joined): select it in Clerk and do a
 * full reload into its home, so no state from the previous workspace survives and the socket
 * reconnects with a token for the new organization (same rule as the workspace switcher).
 */
export async function enterOrganization(clerk: ClerkService, clerkOrgId: string): Promise<void> {
  await clerk.activateNewOrganization(clerkOrgId);
  pageNavigation.assign('/organization');
}

/** Full-page navigation, replaceable in tests. */
export const pageNavigation = { assign: (url: string) => window.location.assign(url) };

/** URL name suggestion from an organization name. */
export function slugFrom(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', manager: 'Manager' };
export const JOIN_POLICY_LABEL: Record<string, string> = {
  invite: 'Invitation only',
  request: 'Anyone who finds it can ask to join',
  open: 'Anyone who finds it can join',
};

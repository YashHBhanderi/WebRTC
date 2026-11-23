import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { Portal, getPortal, portalHome } from 'src/app/core/services/portal';

/**
 * Keeps the two portals apart: a page of one portal opened while this browser uses the other
 * (typed URL, old bookmark, a reload that lands on /chat) goes to the current portal's home.
 * Runs after AuthGuard, so the session is already known to be valid.
 */
export function requirePortal(portal: Portal): CanActivateFn {
  return () => (getPortal() === portal ? true : inject(Router).parseUrl(portalHome()));
}

/**
 * Public landing page: signed-in visitors go straight to their portal. Clerk finishes loading
 * during APP_INITIALIZER, so the synchronous check is accurate here and visitors aren't kept waiting.
 */
export const landingGuard: CanActivateFn = () =>
  inject(ClerkService).isSignedIn ? inject(Router).parseUrl(portalHome()) : true;

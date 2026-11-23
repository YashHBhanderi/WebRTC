import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { safeReturnUrl } from 'src/app/authentication/login/login.component';
import { parsePortal, portalOfUrl, setPortal } from 'src/app/core/services/portal';

/**
 * Sign-in / sign-up pages: someone already signed in goes straight to their portal (or the deep
 * link they came for). A portal named in the link (?portal=developer) is honoured.
 */
export const guestGuard: CanActivateFn = (route) => {
  if (!inject(ClerkService).isSignedIn) return true;
  const portal = parsePortal(route.queryParamMap.get('portal'));
  if (portal) setPortal(portal);
  const returnUrl = route.queryParamMap.get('returnUrl');
  const linkPortal = portalOfUrl(returnUrl);
  if (linkPortal && !portal) setPortal(linkPortal);
  return inject(Router).parseUrl(safeReturnUrl(returnUrl));
};

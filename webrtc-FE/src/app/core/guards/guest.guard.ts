import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { safeReturnUrl } from 'src/app/authentication/login/login.component';

/** Sign-in / sign-up pages: someone already signed in goes straight to the chats. */
export const guestGuard: CanActivateFn = (route) =>
  inject(ClerkService).isSignedIn ? inject(Router).parseUrl(safeReturnUrl(route.queryParamMap.get('returnUrl'))) : true;

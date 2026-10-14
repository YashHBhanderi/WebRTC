import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { SocketService } from 'src/app/core/services/socket.service';

/** App pages: a Clerk session and the matching app account are required. */
@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate {
  constructor(
    private authService: AuthService,
    private clerk: ClerkService,
    private router: Router,
    private alertService: AlertService,
    private socket: SocketService,
  ) { }

  async canActivate(_route?: ActivatedRouteSnapshot, state?: RouterStateSnapshot): Promise<boolean | UrlTree> {
    if (!(await this.clerk.waitForSession())) {
      // Come back here after signing in (e.g. a meeting link)
      const returnUrl = state?.url && state.url !== '/' && !state.url.startsWith('/chat') ? state.url : null;
      return this.router.createUrlTree(['/auth/login'], returnUrl ? { queryParams: { returnUrl } } : undefined);
    }
    try {
      await this.authService.ensureAppUser();
      this.socket.ensureConnected();
      return true;
    } catch (error: any) {
      // Signed in to Clerk but no usable app account (e.g. unverified email): sign out so the
      // sign-in page doesn't bounce straight back here
      const message = error?.error?.message || error?.message;
      if (message && message !== 'Not signed in') {
        this.alertService.error(message);
      }
      await this.authService.logout(false);
      return this.router.createUrlTree(['/auth/login']);
    }
  }
}

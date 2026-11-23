import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { Portal, getPortal, parsePortal, portalHome, portalOfUrl, setPortal } from 'src/app/core/services/portal';

/** Only paths inside this app (never another site); otherwise the current portal's home. */
export function safeReturnUrl(value: string | null | undefined): string {
    // "/\evil.com" is treated like "//evil.com" by some browsers
    return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : portalHome();
}

/**
 * Portal chosen for this sign-in: ?portal=… from the landing page, else the portal of the deep link
 * being returned to, else the one this browser used last.
 */
export function choosePortal(portalParam: string | null, returnUrl: string | null): Portal {
    const portal = parsePortal(portalParam) ?? portalOfUrl(returnUrl) ?? getPortal();
    setPortal(portal);
    return portal;
}

/** Sign-in page: hosts Clerk's SignIn component. After sign-in Clerk navigates to the chosen portal. */
@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit, OnDestroy {
    @ViewChild('mount', { static: true }) mount!: ElementRef<HTMLDivElement>;
    unavailable = '';
    portal: Portal = 'personal';

    constructor(private clerk: ClerkService, private route: ActivatedRoute) { }

    ngOnInit(): void {
        const params = this.route.snapshot.queryParamMap;
        this.portal = choosePortal(params.get('portal'), params.get('returnUrl'));
        if (!this.clerk.loaded) {
            this.unavailable = this.clerk.loadError || 'Please check your connection and try again.';
            return;
        }
        this.clerk.mountSignIn(this.mount.nativeElement, safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')));
    }

    ngOnDestroy(): void {
        this.clerk.unmount(this.mount.nativeElement, 'signIn');
    }

    retry(): void {
        window.location.reload();
    }
}

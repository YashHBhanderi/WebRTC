import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';

/** Only paths inside this app (never another site). */
export function safeReturnUrl(value: string | null | undefined): string {
    // "/\evil.com" is treated like "//evil.com" by some browsers
    return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/chat';
}

/** Sign-in page: hosts Clerk's SignIn component. After sign-in Clerk navigates to /chat. */
@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['./login.component.scss']
})
export class LoginComponent implements OnInit, OnDestroy {
    @ViewChild('mount', { static: true }) mount!: ElementRef<HTMLDivElement>;
    unavailable = '';

    constructor(private clerk: ClerkService, private route: ActivatedRoute) { }

    ngOnInit(): void {
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

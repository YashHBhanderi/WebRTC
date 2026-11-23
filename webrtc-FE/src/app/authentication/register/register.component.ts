import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ClerkService } from 'src/app/core/services/clerk.service';
import { Portal, portalHome } from 'src/app/core/services/portal';
import { choosePortal } from '../login/login.component';

/**
 * Sign-up page: hosts Clerk's SignUp component. The app account (MongoDB) is created on the first
 * request after sign-up; picture, username and bio are edited in the Profile view.
 */
@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.scss']
})
export class RegisterComponent implements OnInit, OnDestroy {
  @ViewChild('mount', { static: true }) mount!: ElementRef<HTMLDivElement>;
  unavailable = '';
  portal: Portal = 'personal';

  constructor(private clerk: ClerkService, private route: ActivatedRoute) { }

  ngOnInit(): void {
    this.portal = choosePortal(this.route.snapshot.queryParamMap.get('portal'), null);
    if (!this.clerk.loaded) {
      this.unavailable = this.clerk.loadError || 'Please check your connection and try again.';
      return;
    }
    this.clerk.mountSignUp(this.mount.nativeElement, portalHome(this.portal));
  }

  ngOnDestroy(): void {
    this.clerk.unmount(this.mount.nativeElement, 'signUp');
  }

  retry(): void {
    window.location.reload();
  }
}

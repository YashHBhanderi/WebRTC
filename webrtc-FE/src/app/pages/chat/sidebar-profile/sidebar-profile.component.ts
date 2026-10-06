import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { ChatUser } from 'src/app/core/interfaces/chat';
import { AuthService } from 'src/app/core/services/auth.service';
import { UserService } from 'src/app/core/services/user.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

/** Same rules as the server (webrtc-BE userServices). */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const BIO_MAX = 160;
const USERNAME_PATTERN = /^[\p{L}\p{M}\p{N} ._'-]+$/u;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const AVATAR_MAX_MB = 5;

/**
 * The signed-in user's profile, shown in place of the chat list (sidebar → ⋮ → Profile).
 * Picture, username and bio are editable; email is read-only. One "Save changes" sends only
 * what changed.
 */
@Component({
  selector: 'app-sidebar-profile',
  templateUrl: './sidebar-profile.component.html',
  styleUrls: ['./sidebar-profile.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarProfileComponent implements OnInit, OnDestroy {
  @Output() back = new EventEmitter<void>();
  /** Fresh user after a successful save. */
  @Output() saved = new EventEmitter<ChatUser>();

  @ViewChild('nameInput') nameInput?: ElementRef<HTMLInputElement>;
  @ViewChild('bioInput') bioInput?: ElementRef<HTMLTextAreaElement>;

  readonly usernameMax = USERNAME_MAX;
  readonly bioMax = BIO_MAX;

  user: ChatUser | null = null;
  username = '';
  bio = '';
  editingName = false;
  editingBio = false;
  avatarFile: File | null = null;
  avatarPreview = '';
  saving = false;

  constructor(
    private auth: AuthService,
    private users: UserService,
    private alert: AlertService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    const me = this.auth.getLoggedInUser();
    if (me) {
      this.applyUser(me);
    }
    // The stored session can be stale (e.g. bio changed on another device)
    if (me?._id) {
      this.users.getUserById(me._id).subscribe({
        next: (res) => {
          if (res?.data && !this.dirty) {
            this.applyUser(res.data as unknown as ChatUser);
            this.cdr.markForCheck();
          }
        },
      });
    }
  }

  ngOnDestroy(): void {
    this.revokePreview();
  }

  get trimmedName(): string {
    return this.username.replace(/\s+/g, ' ').trim();
  }

  get usernameError(): string {
    const name = this.trimmedName;
    if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
      return `Use ${USERNAME_MIN}-${USERNAME_MAX} characters`;
    }
    if (!USERNAME_PATTERN.test(name)) {
      return "Letters, numbers, spaces and . _ ' - only";
    }
    return '';
  }

  get bioError(): string {
    return this.bio.trim().length > BIO_MAX ? `Max ${BIO_MAX} characters` : '';
  }

  get nameChanged(): boolean {
    return !!this.user && this.trimmedName !== (this.user.username || '');
  }

  get bioChanged(): boolean {
    return !!this.user && this.bio.trim() !== (this.user.bio || '');
  }

  get dirty(): boolean {
    return !!this.avatarFile || this.nameChanged || this.bioChanged;
  }

  get canSave(): boolean {
    return this.dirty && !this.saving && !(this.nameChanged && this.usernameError) && !this.bioError;
  }

  editName(): void {
    this.editingName = true;
    setTimeout(() => this.nameInput?.nativeElement.focus());
  }

  editBio(): void {
    this.editingBio = true;
    setTimeout(() => this.bioInput?.nativeElement.focus());
  }

  onAvatarChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    if (!AVATAR_TYPES.includes(file.type)) {
      this.alert.warning('Please choose a JPG, PNG, GIF or WebP image.');
      return;
    }
    if (file.size > AVATAR_MAX_MB * 1024 * 1024) {
      this.alert.warning(`Profile pictures can be up to ${AVATAR_MAX_MB} MB.`);
      return;
    }
    this.revokePreview();
    this.avatarFile = file;
    this.avatarPreview = URL.createObjectURL(file);
    this.cdr.markForCheck();
  }

  discardAvatar(): void {
    this.avatarFile = null;
    this.revokePreview();
  }

  save(): void {
    if (!this.canSave || !this.user) {
      return;
    }
    const form = new FormData();
    if (this.nameChanged) {
      form.append('username', this.trimmedName);
    }
    if (this.bioChanged) {
      form.append('bio', this.bio.trim());
    }
    if (this.avatarFile) {
      form.append('image', this.avatarFile);
    }
    this.saving = true;
    this.cdr.markForCheck();
    this.users.updateProfile(form).subscribe({
      next: (res) => {
        const fresh = res.data as unknown as ChatUser;
        this.auth.updateLoggedInUser({ username: fresh.username, avatar: fresh.avatar, bio: fresh.bio, status: fresh.status });
        this.avatarFile = null;
        this.revokePreview();
        this.applyUser(fresh);
        this.saving = false;
        this.saved.emit(fresh);
        this.alert.success('Profile updated');
        this.cdr.markForCheck();
      },
      error: () => {
        // The error interceptor already shows the server's reason
        this.saving = false;
        this.cdr.markForCheck();
      },
    });
  }

  private applyUser(user: ChatUser): void {
    this.user = user;
    this.username = user.username || '';
    this.bio = user.bio || '';
    this.editingName = false;
    this.editingBio = false;
  }

  private revokePreview(): void {
    if (this.avatarPreview) {
      URL.revokeObjectURL(this.avatarPreview);
      this.avatarPreview = '';
    }
  }
}

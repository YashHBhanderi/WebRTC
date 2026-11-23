import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnDestroy, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ContactLookup, ContactScope, ContactService, EMAIL_PATTERN, contactError } from 'src/app/core/services/contact.service';
import { UserService } from 'src/app/core/services/user.service';

type State = 'idle' | 'loading' | 'found' | 'none' | 'error';

/** One person in the list: someone from my directory, or from an existing external chat */
export interface NewChatPerson {
  _id: string;
  username: string;
  avatar?: string;
  external?: boolean;
}

/** Lookups wait for typing to pause (the server rate-limits them) */
const LOOKUP_DELAY_MS = 450;

/**
 * New chat: one search box. The people list is what the server already lists for this context
 * (organization members, or discoverable people when personal) plus people from my external chats,
 * filtered as I type. Anyone else is found by their exact email: a complete address is looked up
 * automatically — in an organization, members first, then people outside it (the organization's
 * policy decides; the server explains when it doesn't allow it).
 */
@Component({
  selector: 'app-new-chat-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .nc__search { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 44px; border-radius: 999px; background: var(--app-input); color: var(--app-muted); }
    .nc__search:focus-within { box-shadow: 0 0 0 2px var(--app-brand); }
    .nc__search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--app-text); font-size: .95rem; }
    .nc__section { margin: 14px 4px 4px; font-size: .72rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--app-muted); }
    .nc__list { list-style: none; margin: 0; padding: 0; max-height: min(52vh, 380px); overflow-y: auto; }
    .nc__msg { margin: 12px 4px 0; font-size: .86rem; color: var(--app-muted); display: flex; gap: 8px; align-items: flex-start; }
    .nc__msg--error { color: var(--app-danger); }
    .nc__go { margin-left: auto; font-size: .8rem; font-weight: 600; color: var(--app-brand); white-space: nowrap; }
  `],
  template: `
    <div class="modal-header">
      <div>
        <h2 class="modal-title h5" id="new-chat-title">New chat</h2>
        <p class="modal-subtitle">Search by name, or enter someone's email address.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="modal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <label class="nc__search">
        <i class="ti ti-search" aria-hidden="true"></i>
        <input type="search" [value]="query" (input)="onQuery($any($event.target).value)" (keydown.enter)="enter()"
               placeholder="Search people or enter an email" aria-label="Search people or enter an email" aria-describedby="nc-status"
               autocomplete="off" spellcheck="false" ngbAutofocus />
      </label>

      <div id="nc-status" aria-live="polite">
        <ng-container *ngIf="emailQuery">
          <div class="nc__section">By email</div>
          <div class="nc__msg" *ngIf="state === 'loading'"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Looking for {{ emailQuery }}…</div>
          <div class="nc__msg" *ngIf="state === 'none'"><i class="ti ti-user-off" aria-hidden="true"></i>{{ message }}</div>
          <div class="nc__msg nc__msg--error" *ngIf="state === 'error'" role="alert"><i class="ti ti-alert-triangle" aria-hidden="true"></i>{{ message }}</div>
          <button type="button" class="person-row" *ngIf="state === 'found' && result?.user as u" [disabled]="starting" (click)="start()">
            <app-avatar [src]="u.avatar" [name]="u.username" [size]="36"></app-avatar>
            <span class="person-row__text">
              <span class="person-row__name">{{ u.username }}<span class="badge-pill badge-pill--external" *ngIf="result?.external">External</span></span>
              <span class="person-row__hint">{{ result?.external ? 'Outside your organization. They see only this conversation.' : emailQuery }}</span>
            </span>
            <span class="nc__go">{{ starting ? 'Starting…' : (result?.conversationId ? 'Open chat' : 'Start chat') }}</span>
          </button>
        </ng-container>
      </div>

      <div class="nc__section" *ngIf="filtered.length">{{ query.trim() && !emailQuery ? 'People' : (emailQuery ? 'Also matching' : 'Suggested') }}</div>
      <ul class="nc__list" *ngIf="filtered.length">
        <li *ngFor="let p of filtered; trackBy: trackById">
          <button type="button" class="person-row" (click)="open(p)">
            <app-avatar [src]="p.avatar" [name]="p.username" [size]="36"></app-avatar>
            <span class="person-row__text">
              <span class="person-row__name">{{ p.username }}<span class="badge-pill badge-pill--external" *ngIf="p.external">External</span></span>
            </span>
          </button>
        </li>
      </ul>
      <div class="nc__msg" *ngIf="loadingPeople && !people.length"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span>Loading people…</div>
      <div class="nc__msg" *ngIf="!loadingPeople && !filtered.length && !emailQuery">
        <i class="ti ti-mail" aria-hidden="true"></i>
        <span>{{ query.trim() ? 'Nobody here matches “' + query.trim() + '”. ' : '' }}Not listed? Type their full email address to find them.</span>
      </div>
    </div>
  `,
})
export class NewChatDialogComponent implements OnInit, OnDestroy {
  /** Set by the opener: the tab shows an organization (members first, then people outside it) */
  @Input() inOrganization = false;
  /** Pre-filled address (e.g. typed into the global search): looked up right away */
  @Input() initialEmail = '';
  /** People from my existing external chats (labelled External) */
  @Input() externalPeople: NewChatPerson[] = [];
  query = '';
  people: NewChatPerson[] = [];
  loadingPeople = false;
  state: State = 'idle';
  message = '';
  result: ContactLookup | null = null;
  starting = false;
  /** Scope the found person was found in (sent again when starting the chat) */
  private foundScope: ContactScope | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lookupSeq = 0;

  constructor(
    public modal: NgbActiveModal,
    private contacts: ContactService,
    private users: UserService,
    private router: Router,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    void this.loadPeople();
    if (this.initialEmail) {
      this.query = this.initialEmail;
      void this.find();
    }
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** The query is a complete email address */
  get emailQuery(): string | null {
    const q = this.query.trim();
    return EMAIL_PATTERN.test(q) ? q : null;
  }

  get filtered(): NewChatPerson[] {
    const q = this.query.trim().toLowerCase();
    return q ? this.people.filter((p) => (p.username || '').toLowerCase().includes(q)) : this.people;
  }

  trackById = (_: number, p: NewChatPerson) => p._id;

  private async loadPeople(): Promise<void> {
    this.loadingPeople = true;
    this.cdr.markForCheck();
    const directory = await firstValueFrom(this.users.getAllUsersExceptCurrentUser()).then((r) => (r.data || []) as any[]).catch(() => [] as any[]);
    const byId = new Map<string, NewChatPerson>();
    for (const u of directory) byId.set(String(u._id), { _id: String(u._id), username: u.username, avatar: u.avatar });
    for (const p of this.externalPeople) if (!byId.has(String(p._id))) byId.set(String(p._id), { ...p, external: true });
    this.people = [...byId.values()].filter((p) => p.username).sort((a, b) => a.username.localeCompare(b.username));
    this.loadingPeople = false;
    this.cdr.markForCheck();
  }

  onQuery(value: string): void {
    this.query = value;
    this.result = null;
    this.state = 'idle';
    if (this.timer) clearTimeout(this.timer);
    if (this.emailQuery) this.timer = setTimeout(() => void this.find(), LOOKUP_DELAY_MS);
    this.cdr.markForCheck();
  }

  /** Enter: open the only match, or look the address up now */
  enter(): void {
    if (this.emailQuery) {
      if (this.state === 'found') void this.start();
      else {
        if (this.timer) clearTimeout(this.timer);
        void this.find();
      }
      return;
    }
    if (this.filtered.length === 1) this.open(this.filtered[0]);
  }

  async find(): Promise<void> {
    const email = this.emailQuery;
    if (!email) return;
    const seq = ++this.lookupSeq;
    this.state = 'loading';
    this.cdr.markForCheck();
    try {
      let scope: ContactScope | undefined = this.inOrganization ? 'member' : undefined;
      let result = await this.contacts.lookup(email, scope);
      // In an organization, someone who isn't a member may still be reachable as an external contact
      if (!result.found && this.inOrganization) {
        scope = 'external';
        result = await this.contacts.lookup(email, scope);
      }
      if (seq !== this.lookupSeq) return;
      this.result = result;
      this.foundScope = scope;
      this.state = result.found ? 'found' : 'none';
      this.message = result.message || 'No eligible account found for this email.';
    } catch (e) {
      if (seq !== this.lookupSeq) return;
      this.state = 'error';
      this.message = contactError(e);
    }
    this.cdr.markForCheck();
  }

  /** Someone from the list: the chat page resumes our chat, or starts one */
  open(p: NewChatPerson): void {
    this.modal.close();
    void this.router.navigate(['/chat'], { queryParams: { user: p._id } });
  }

  async start(): Promise<void> {
    const email = this.emailQuery;
    if (!this.result?.user || !email || this.starting) return;
    this.starting = true;
    this.cdr.markForCheck();
    try {
      const { conversationId } = await this.contacts.start(email, this.foundScope);
      this.modal.close(conversationId);
      void this.router.navigate(['/chat'], { queryParams: { c: conversationId, user: this.result.user._id } });
    } catch (e) {
      this.state = 'error';
      this.message = contactError(e);
      this.starting = false;
      this.cdr.markForCheck();
    }
  }
}

import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

export interface PickPerson {
  id: string;
  name: string;
  avatar?: string;
  /** Short label next to the name (role, "External"…) */
  badge?: string;
  /** external = amber, role = neutral */
  badgeTone?: 'external' | 'role';
  /** Second line (e.g. "Owner · joined May 2026") */
  hint?: string;
}

/**
 * Searchable list of people with picture, name and badges. Used for choosing members (channels, teams).
 * Filtering is local: the list only ever contains people the server already returned to this user.
 */
@Component({
  selector: 'app-person-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="pp__search">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input type="search" [(ngModel)]="q" [placeholder]="placeholder" [attr.aria-label]="placeholder" autocomplete="off" spellcheck="false" />
    </label>
    <div class="pp__selected" *ngIf="multiple && selected.size">{{ selected.size }} selected</div>
    <ul class="pp__list" role="listbox" [attr.aria-multiselectable]="multiple" [style.max-height.px]="maxHeight">
      <li *ngFor="let p of filtered; trackBy: trackById">
        <button type="button" class="person-row" role="option" [attr.aria-selected]="selected.has(p.id)" [class.person-row--on]="selected.has(p.id)" (click)="toggled.emit(p.id)">
          <app-avatar [src]="p.avatar" [name]="p.name" [size]="32"></app-avatar>
          <span class="person-row__text">
            <span class="person-row__name">{{ p.name }}<span class="badge-pill" [class.badge-pill--external]="p.badgeTone === 'external'" *ngIf="p.badge">{{ p.badge }}</span></span>
            <span class="person-row__hint" *ngIf="p.hint">{{ p.hint }}</span>
          </span>
          <span class="person-row__check" aria-hidden="true"><i class="ti ti-check"></i></span>
        </button>
      </li>
    </ul>
    <p class="pp__empty" *ngIf="!filtered.length">{{ people.length ? 'Nobody matches “' + q.trim() + '”' : empty }}</p>
  `,
  styles: [`
    :host { display: block; }
    .pp__search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 38px; border-radius: 999px; background: var(--app-input); color: var(--app-muted); }
    .pp__search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--app-text); font-size: .9rem; }
    .pp__selected { margin: 8px 4px 0; font-size: .78rem; color: var(--app-muted); }
    .pp__list { list-style: none; margin: 6px 0 0; padding: 0; overflow-y: auto; }
    .pp__empty { margin: 12px 4px 4px; font-size: .85rem; color: var(--app-muted); }
  `],
})
export class PersonPickerComponent {
  @Input() people: PickPerson[] = [];
  @Input() selected = new Set<string>();
  @Input() multiple = true;
  @Input() placeholder = 'Search people';
  @Input() empty = 'Nobody to choose yet';
  @Input() maxHeight = 280;
  @Output() toggled = new EventEmitter<string>();
  q = '';

  get filtered(): PickPerson[] {
    const q = this.q.trim().toLowerCase();
    return q ? this.people.filter((p) => p.name.toLowerCase().includes(q)) : this.people;
  }

  trackById = (_: number, p: PickPerson) => p.id;
}

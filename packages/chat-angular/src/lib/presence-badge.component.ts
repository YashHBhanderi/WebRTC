import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SPW_THEME } from './theme';

/** Presence dot + optional label. Pass the status string the SDK reports ('Available', 'Busy', …, 'Offline'). */
@Component({
  selector: 'spw-presence-badge',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dot" [ngClass]="kind" [attr.title]="status || 'Offline'"></span><span *ngIf="showLabel" class="muted">{{ status || 'Offline' }}</span>`,
  styles: [SPW_THEME, `
    :host { display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #9aa5ae; display: inline-block; }
    .on { background: #2e9d5b; } .busy { background: #c62828; } .away { background: #e0a400; }
  `],
})
export class SpwPresenceBadgeComponent {
  @Input() status: string | null | undefined;
  @Input() showLabel = false;
  get kind(): string {
    const s = (this.status || '').toLowerCase();
    return s === 'available' || s === 'online' ? 'on' : s === 'busy' || s === 'do not disturb' ? 'busy' : s === 'away' ? 'away' : '';
  }
}

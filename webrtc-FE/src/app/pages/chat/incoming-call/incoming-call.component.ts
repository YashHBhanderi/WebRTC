import { AvatarColors, avatarColors, avatarInitials } from 'src/app/core/utils/avatar.util';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { RingtoneService } from 'src/app/core/services/ringtone.service';
import { CallNotificationService } from 'src/app/core/services/call-notification.service';
import { mediaUrl } from 'src/app/core/utils/media-url.util';

export interface IncomingCall {
  callId: string;
  groupId: string;
  callType: 'audio' | 'video';
  isGroup: boolean;
  callerId: string;
  callerName: string;
  avatar?: string;
  groupName?: string;
}

/**
 * Ringing screen for an incoming call. Person-to-person calls also ring with this device's
 * ringtone and raise a system notification while the tab isn't in front; group calls (and
 * "Meet now", which never shows this card) stay silent. Both stop when the card goes away
 * (accepted, declined, cancelled by the caller or timed out).
 */
@Component({
  selector: 'app-incoming-call',
  templateUrl: './incoming-call.component.html',
  styleUrls: ['./incoming-call.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IncomingCallComponent implements OnInit, OnChanges, OnDestroy {
  @Input() call!: IncomingCall;
  @Output() accept = new EventEmitter<void>();
  @Output() decline = new EventEmitter<void>();

  private alerting = false;

  constructor(private ringtone: RingtoneService, private notifications: CallNotificationService) {}

  get title(): string {
    return this.call.isGroup ? this.call.groupName || 'Group call' : this.call.callerName;
  }

  get subtitle(): string {
    const kind = this.call.callType === 'video' ? 'video' : 'voice';
    return this.call.isGroup ? `${this.call.callerName} is calling · ${kind}` : `Incoming ${kind} call`;
  }

  get initial(): string {
    return avatarInitials(this.title);
  }

  get colors(): AvatarColors {
    return avatarColors(this.title);
  }

  ngOnInit(): void {
    if (this.call.isGroup) {
      return;
    }
    this.alerting = true;
    void this.ringtone.start();
    this.notify();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // The caller's name/picture can arrive after the card opened: refresh the notification
    const prev = changes['call']?.previousValue as IncomingCall | undefined;
    if (this.alerting && prev && (prev.callerName !== this.call.callerName || prev.avatar !== this.call.avatar)) {
      this.notify();
    }
  }

  ngOnDestroy(): void {
    if (this.alerting) {
      this.ringtone.stop();
      void this.notifications.close(this.call.callId);
    }
  }

  private notify(): void {
    void this.notifications.showIncoming({
      callId: this.call.callId,
      callerName: this.call.callerName,
      callType: this.call.callType,
      icon: mediaUrl(this.call.avatar) || undefined,
    });
  }
}

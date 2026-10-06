import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { Subscription, firstValueFrom } from 'rxjs';
import Swal from 'sweetalert2';
import { ChatUser, GroupSummary } from 'src/app/core/interfaces/chat';
import { ChatActionsService } from 'src/app/core/services/chat-actions.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { UserService } from 'src/app/core/services/user.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { MediaOpenEvent } from '../message-item/message-item.component';

interface SharedMediaItem {
  _id: string;
  fileUrl: string;
  thumbnailUrl: string;
  type: string;
}

/**
 * Right-side contact / group info: picture, name, about, members (with admin tools for
 * admins), shared media, and a sticky "Save changes" that only appears when edits exist.
 */
@Component({
  selector: 'app-conversation-info-panel',
  templateUrl: './conversation-info-panel.component.html',
  styleUrls: ['./conversation-info-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConversationInfoPanelComponent implements OnInit, OnChanges, OnDestroy {
  @Input() conversationId = '';
  @Input() isGroup = false;
  /** 1:1 only: the other person. */
  @Input() peerId = '';
  @Input() myUserId = '';
  /** Everyone the user can add (contacts list). */
  @Input() contacts: ChatUser[] = [];
  @Output() close = new EventEmitter<void>();
  @Output() openMedia = new EventEmitter<MediaOpenEvent>();
  @Output() leaveGroup = new EventEmitter<void>();
  @Output() groupChanged = new EventEmitter<GroupSummary>();

  loading = true;
  peer: ChatUser | null = null;
  group: GroupSummary | null = null;
  media: SharedMediaItem[] = [];

  // Editable group fields (admins)
  editName = '';
  editDescription = '';
  avatarFile: File | null = null;
  avatarPreview = '';
  saving = false;

  addingMembers = false;
  memberSearch = '';
  selectedToAdd = new Set<string>();
  busyMemberId: string | null = null;

  private subs = new Subscription();

  constructor(
    private users: UserService,
    private actions: ChatActionsService,
    private socket: SocketService,
    private alert: AlertService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.subs.add(this.socket.onGroupUpdated().subscribe((data: any) => {
      if (this.isGroup && data?.groupId === this.conversationId && data.group) {
        this.applyGroup(data.group, false);
      }
    }));
    this.subs.add(this.socket.onPresence().subscribe((data: any) => {
      const apply = (u: ChatUser | null | undefined) => {
        if (u && String(u._id) === String(data?.userId)) {
          u.isOnline = !!data.isOnline;
          if (data.lastSeen) {
            u.lastSeen = data.lastSeen;
          }
        }
      };
      apply(this.peer);
      this.group?.members.forEach(apply);
      this.cdr.markForCheck();
    }));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['conversationId'] || changes['peerId'] || changes['isGroup']) {
      void this.load();
    }
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    this.revokeAvatarPreview();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!document.querySelector('.swal2-container, app-emoji-picker, .dropdown-menu.show')) {
      this.close.emit();
    }
  }

  get isAdmin(): boolean {
    return !!this.group && this.group.groupAdmins.includes(this.myUserId);
  }

  get dirty(): boolean {
    if (!this.group || !this.isAdmin) {
      return false;
    }
    return (
      !!this.avatarFile ||
      this.editName.trim() !== (this.group.groupName || '') ||
      this.editDescription.trim() !== (this.group.groupDescription || '')
    );
  }

  get onlineCount(): number {
    return (this.group?.members || []).filter((m) => m.isOnline || String(m._id) === this.myUserId).length;
  }

  get sortedMembers(): ChatUser[] {
    const admins = new Set(this.group?.groupAdmins || []);
    return [...(this.group?.members || [])].sort((a, b) => {
      const rank = (u: ChatUser) => (String(u._id) === this.myUserId ? 0 : admins.has(String(u._id)) ? 1 : 2);
      return rank(a) - rank(b) || (a.username || '').localeCompare(b.username || '');
    });
  }

  get addCandidates(): ChatUser[] {
    const members = new Set((this.group?.members || []).map((m) => String(m._id)));
    const q = this.memberSearch.trim().toLowerCase();
    return this.contacts.filter((u) => !members.has(String(u._id)) && (!q || (u.username || '').toLowerCase().includes(q)));
  }

  isMemberAdmin(userId: string): boolean {
    return !!this.group?.groupAdmins.includes(String(userId));
  }

  trackUser(_: number, u: ChatUser): string {
    return u._id;
  }

  // ---------------------------------------------------------------- editing
  onAvatarChosen(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.alert.warning('Choose an image for the group photo.');
      return;
    }
    this.revokeAvatarPreview();
    this.avatarFile = file;
    this.avatarPreview = URL.createObjectURL(file);
  }

  discardChanges(): void {
    if (this.group) {
      this.editName = this.group.groupName || '';
      this.editDescription = this.group.groupDescription || '';
    }
    this.avatarFile = null;
    this.revokeAvatarPreview();
  }

  async save(): Promise<void> {
    if (!this.group || !this.dirty || this.saving) {
      return;
    }
    if (!this.editName.trim()) {
      this.alert.warning('Group name cannot be empty.');
      return;
    }
    this.saving = true;
    this.cdr.markForCheck();
    try {
      const changes: { groupName?: string; groupDescription?: string; groupAvatarKey?: string } = {};
      if (this.editName.trim() !== (this.group.groupName || '')) {
        changes.groupName = this.editName.trim();
      }
      if (this.editDescription.trim() !== (this.group.groupDescription || '')) {
        changes.groupDescription = this.editDescription.trim();
      }
      if (this.avatarFile) {
        const uploaded = await firstValueFrom(this.socket.uploadFile(this.avatarFile, { purpose: 'group-avatar', groupId: this.group._id }));
        changes.groupAvatarKey = uploaded.storageKey;
      }
      const res = await this.actions.updateGroup(this.group._id, changes);
      this.avatarFile = null;
      this.revokeAvatarPreview();
      this.applyGroup(res.group, true);
      this.alert.success('Group updated');
    } catch (error: any) {
      this.alert.error(error?.message || 'Could not save changes');
    } finally {
      this.saving = false;
      this.cdr.markForCheck();
    }
  }

  // ---------------------------------------------------------------- members
  async setAdmin(member: ChatUser, admin: boolean): Promise<void> {
    await this.memberAction(member, () => this.actions.setAdmin(this.conversationId, member._id, admin));
  }

  async removeMember(member: ChatUser): Promise<void> {
    const confirm = await Swal.fire({
      title: `Remove ${member.username}?`,
      text: 'They will no longer receive messages from this group.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Remove',
      confirmButtonColor: '#dc2626',
    });
    if (confirm.isConfirmed) {
      await this.memberAction(member, () => this.actions.removeMember(this.conversationId, member._id));
    }
  }

  toggleAddMembers(): void {
    this.addingMembers = !this.addingMembers;
    this.memberSearch = '';
    this.selectedToAdd.clear();
  }

  toggleCandidate(userId: string): void {
    if (this.selectedToAdd.has(userId)) {
      this.selectedToAdd.delete(userId);
    } else {
      this.selectedToAdd.add(userId);
    }
  }

  async addSelected(): Promise<void> {
    if (!this.selectedToAdd.size) {
      return;
    }
    this.busyMemberId = 'add';
    this.cdr.markForCheck();
    try {
      const res = await this.actions.addMembers(this.conversationId, [...this.selectedToAdd]);
      this.applyGroup(res.group, false);
      this.addingMembers = false;
      this.selectedToAdd.clear();
    } catch (error: any) {
      this.alert.error(error?.message || 'Could not add members');
    } finally {
      this.busyMemberId = null;
      this.cdr.markForCheck();
    }
  }

  open(item: SharedMediaItem): void {
    this.openMedia.emit({ url: item.fileUrl, type: item.type });
  }

  // ---------------------------------------------------------------- loading
  private async memberAction(member: ChatUser, run: () => Promise<{ group: GroupSummary }>): Promise<void> {
    this.busyMemberId = member._id;
    this.cdr.markForCheck();
    try {
      const res = await run();
      this.applyGroup(res.group, false);
    } catch (error: any) {
      this.alert.error(error?.message || 'Action failed');
    } finally {
      this.busyMemberId = null;
      this.cdr.markForCheck();
    }
  }

  private applyGroup(group: GroupSummary, resetEdits: boolean): void {
    const editedName = this.group && this.editName.trim() !== (this.group.groupName || '');
    const editedDescription = this.group && this.editDescription.trim() !== (this.group.groupDescription || '');
    this.group = { ...group, groupAdmins: (group.groupAdmins || []).map(String) };
    // Keep the admin's unsaved edits when someone else updates the group
    if (resetEdits || !editedName) {
      this.editName = group.groupName || '';
    }
    if (resetEdits || !editedDescription) {
      this.editDescription = group.groupDescription || '';
    }
    this.groupChanged.emit(this.group);
    this.cdr.markForCheck();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.peer = null;
    this.group = null;
    this.media = [];
    this.addingMembers = false;
    this.discardChanges();
    this.cdr.markForCheck();
    const id = this.conversationId;
    try {
      if (this.isGroup) {
        const res = await firstValueFrom(this.users.getGroupInfo(id));
        if (id !== this.conversationId) {
          return;
        }
        const info = res.data;
        this.applyGroup({
          _id: String(info._id),
          groupName: info.groupName,
          groupDescription: info.groupDescription,
          groupAvatar: info.groupAvatar,
          groupAdmins: info.groupAdmins || [],
          members: info.membersDetails || [],
        }, true);
      } else if (this.peerId) {
        const res = await firstValueFrom(this.users.getUserById(this.peerId));
        if (id !== this.conversationId) {
          return;
        }
        this.peer = res.data as unknown as ChatUser;
      }
      const media = await firstValueFrom(this.users.getSharedMedia(id));
      if (id === this.conversationId) {
        this.media = (media.data || []) as SharedMediaItem[];
      }
    } catch {
      // The error interceptor already shows the reason
    } finally {
      if (id === this.conversationId) {
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  private revokeAvatarPreview(): void {
    if (this.avatarPreview) {
      URL.revokeObjectURL(this.avatarPreview);
      this.avatarPreview = '';
    }
  }
}

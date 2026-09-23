import { Component, Input, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { ProfileComponent } from '../profile/profile.component';
import { UserService } from 'src/app/core/services/user.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

@Component({
  selector: 'app-group-info',
  templateUrl: './group-info.component.html',
  styleUrls: ['./group-info.component.scss']
})
export class GroupInfoComponent implements OnInit {

  @Input() groupId!: string;
  group!: any;
  isLoading: Boolean = false;

  showAddMembers: boolean = false;
  allUsers: any[] = [];
  selectedUserIds: Set<string> = new Set();
  mediaList: any[] = [];
  @ViewChild('addMembersModal') addMembersModalRef!: TemplateRef<any>;


  constructor(
    private userService: UserService,
    private alertService: AlertService,
    public activeModal: NgbActiveModal,
    private modalService: NgbModal

  ) { }

  ngOnInit(): void {
    this.getGroupInfo(this.groupId);
    this.getSharedMedia(this.groupId);
  }

  getGroupInfo(groupId: string) {
    this.isLoading = true;
    this.userService.getGroupInfo(groupId).subscribe({
      next: (response) => {
        this.isLoading = false;
        this.group = response.data;
      },
      error: (error) => {
        this.alertService.error(`${error || 'Unknown error'}`);
        this.isLoading = false;
      }
    });
  }

  getSharedMedia(groupId: string) {
    this.userService.getSharedMedia(groupId).subscribe({
      next: (response) => {
        this.mediaList = response.data;
      },
      error: (error) => {
        console.error('Error fetching media:', error);
      }
    });
  }

  openMedia(url: string) {
    if (url) window.open(url, '_blank');
  }

  closeModal() {
    this.activeModal.close();
  }

  toggleUserSelection(userId: string) {
    if (this.selectedUserIds.has(userId)) {
      this.selectedUserIds.delete(userId);
    } else {
      this.selectedUserIds.add(userId);
    }
  }

  fetchUsers() {
    this.userService.getAllUsersExceptCurrentUser().subscribe({
      next: (res) => {
        this.allUsers = res.data;
      },
      error: (error) => {
        this.alertService.error(`${error || 'Unknown error'}`);
      }
    });
  }


  addSelectedUsers() {
    const userIds = Array.from(this.selectedUserIds);
    if (!userIds.length) return;

    this.userService.addMembersToGroup(this.groupId, userIds).subscribe({
      next: () => {
        this.alertService.success("Members added successfully");
        this.getGroupInfo(this.groupId);
        this.selectedUserIds.clear();
        this.showAddMembers = false;
      },
      error: (error) => {
        this.alertService.error(`${error || 'Unknown error'}`);
      }
    });
  }

  openAddMembersModal() {
    if (this.allUsers.length === 0) {
      this.fetchUsers();
    }
    this.modalService.open(this.addMembersModalRef, {
      centered: true,
      backdrop: 'static',
      size: 'lg'
    });
  }

  removeMember(userId: string) {
    this.userService.removeMemberFromGroup(this.groupId, userId).subscribe({
      next: () => {
        this.alertService.success("Member removed successfully");
        this.getGroupInfo(this.groupId);
      },
      error: (error) => {
        this.alertService.error(`${error || 'Unknown error'}`);
      }
    });
  }

  makeGroupAdmin(userId: string) {
    this.alertService.info("This feature is currently under development.");
  }

  openUserProfile(userId: string) {
    const modalRef = this.modalService.open(ProfileComponent, {
      windowClass: 'custom-modal'
    });

    modalRef.componentInstance.userId = userId;
    modalRef.componentInstance.modalRef = modalRef;
  }
}

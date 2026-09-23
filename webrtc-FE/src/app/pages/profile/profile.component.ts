import { Component, Input, OnInit } from '@angular/core';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { IUser } from 'src/app/core/interfaces/user';
import { UserService } from 'src/app/core/services/user.service';
import { AuthService } from 'src/app/core/services/auth.service';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.component.html',
  styleUrls: ['./profile.component.scss']
})
export class ProfileComponent implements OnInit {

  @Input() userId!: string;
  @Input() conversationId?: string;
  user!: IUser;
  isLoading: boolean = false;
  isCurrentUser: boolean = false;
  isEditing: boolean = false;
  mediaList: any[] = [];
  selectedFile: File | null = null;
  previewAvatar: string | null = null;

  constructor(
    private userService: UserService,
    private authService: AuthService,
    private alertService: AlertService,
    public activeModal: NgbActiveModal
  ) { }

  ngOnInit(): void {
    const loggedInUser = this.authService.getLoggedInUser();
    this.isCurrentUser = loggedInUser?._id === this.userId;
    this.getUserData(this.userId);
    if (this.conversationId) {
      this.getSharedMedia(this.conversationId);
    }
  }

  getUserData(userId: string) {
    this.isLoading = true;
    this.userService.getUserById(userId).subscribe({
      next: (response) => {
        this.isLoading = false;
        this.user = response.data;
      },
      error: (error) => {
        this.isLoading = false;
        this.alertService.error(`Failed to fetch user details: ${error || 'Unknown error'}`);
      }
    });
  }

  getSharedMedia(conversationId: string) {
    this.userService.getSharedMedia(conversationId).subscribe({
      next: (res) => {
        this.mediaList = res.data;
      }
    });
  }

  toggleEdit() {
    this.isEditing = !this.isEditing;
    if (!this.isEditing) {
      this.selectedFile = null;
      this.previewAvatar = null;
    }
  }

  onAvatarChange(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.selectedFile = file;
      const reader = new FileReader();
      reader.onload = (e: any) => this.previewAvatar = e.target.result;
      reader.readAsDataURL(file);
    }
  }

  updateProfile() {
    this.isLoading = true;
    const formData = new FormData();
    formData.append('bio', this.user.bio || '');
    formData.append('status', this.user.status || 'Available');
    if (this.selectedFile) {
      formData.append('image', this.selectedFile);
    }

    this.userService.updateProfile(formData).subscribe({
      next: (res) => {
        this.isLoading = false;
        this.user = res.data;
        this.isEditing = false;
        this.alertService.success('Profile updated successfully!');
        // Update local storage user if current user
        if (this.isCurrentUser) {
          localStorage.setItem('user', JSON.stringify(this.user));
        }
      },
      error: (err) => {
        this.isLoading = false;
        this.alertService.error('Failed to update profile');
      }
    });
  }

  closeModal() {
    this.activeModal.close();
  }

  openMedia(url: string) {
    if (url) window.open(url, '_blank');
  }
}

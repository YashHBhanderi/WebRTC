import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { AuthService } from 'src/app/core/services/auth.service';

const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const AVATAR_MAX_MB = 5;

@Component({
  selector: 'app-register',
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.scss']
})
export class RegisterComponent implements OnInit {
  registerForm!: FormGroup;
  submitted: boolean = false;
  avatarFile!: File | null;
  avatarPreview: string | null = null;
  loading: boolean = false;

  constructor(
    private fb: FormBuilder,
    private router: Router,
    private authService: AuthService,
    private alertService: AlertService,
  ) { }

  ngOnInit(): void {
    this.registerForm = this.fb.group({
      username: ['', [Validators.required, Validators.minLength(3)]],
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(6)]],
    });
  }

  /** Optional picture: same rules as the server (JPG/PNG/GIF/WebP, up to 5 MB). */
  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      if (!AVATAR_TYPES.includes(file.type)) {
        this.alertService.warning('Please choose a JPG, PNG, GIF or WebP image.');
        this.removeAvatar(input);
        return;
      }
      if (file.size > AVATAR_MAX_MB * 1024 * 1024) {
        this.alertService.warning(`Profile pictures can be up to ${AVATAR_MAX_MB} MB.`);
        this.removeAvatar(input);
        return;
      }
      this.avatarFile = file;

      const reader = new FileReader();
      reader.onload = () => {
        this.avatarPreview = reader.result as string;
      };
      reader.readAsDataURL(this.avatarFile);
    }
  }

  removeAvatar(input?: HTMLInputElement) {
    this.avatarFile = null;
    this.avatarPreview = null;
    if (input) {
      input.value = '';
    }
  }

  onSubmit() {
    this.submitted = true;
    if (this.registerForm.invalid) {
      this.alertService.warning('Please complete all required fields in the form before submitting.');
      return;
    }
    this.loading = true;
    const formData = new FormData();
    formData.append('username', this.registerForm.get('username')?.value);
    formData.append('email', this.registerForm.get('email')?.value);
    formData.append('password', this.registerForm.get('password')?.value);

    if (this.avatarFile) {
      formData.append('image', this.avatarFile);
    }
    this.alertService.loading('Registering...');
    this.authService.register(formData as any).subscribe({
      next: () => {
        this.loading = false;
        this.alertService.close();
        this.router.navigate(['auth/login']).then(() => {
          this.alertService.success('Account created successfully!');
        });
      },
      error: (error) => {
        this.loading = false;
        this.alertService.close();
        this.alertService.error(error || 'Registration failed. Please try again.');
      },
    }
    )
  }

  hasError(controlName: string, errorName: string): boolean {
    return this.registerForm.controls[controlName].touched && this.registerForm.controls[controlName].hasError(errorName);
  }
}

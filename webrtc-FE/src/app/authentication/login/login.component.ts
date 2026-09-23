import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AlertService } from 'src/app/_shared/alert/alert.service';
import { AuthService } from 'src/app/core/services/auth.service';
import { SocketService } from 'src/app/core/services/socket.service';
@Component({
    selector: 'app-login',
    templateUrl: './login.component.html',
    styleUrls: ['./login.component.scss']
})

export class LoginComponent implements OnInit {

    loginForm!: FormGroup;
    summited: boolean = false;
    formData: any = [];
    loading: boolean = false;

    constructor(
        private fb: FormBuilder,
        private router: Router,
        private authService: AuthService,
        private socketService: SocketService,
        private alertService: AlertService,
    ) { }

    ngOnInit(): void {
        this.loginForm = this.fb.group({
            email: ['', [Validators.required, Validators.email]],
            password: ['', [Validators.required]]
        });
    }

    onSubmit() {
        this.summited = true;
        if (this.loginForm.invalid) {
            this.alertService.warning('Please complete all required fields in the form before submitting.');
            return;
        }
        this.loading = true;
        const email = this.loginForm.get('email')?.value;
        const password = this.loginForm.get('password')?.value;
        this.alertService.loading('Logging in...');
        this.authService.loginUser(email, password).subscribe({
            next: (response) => {
                this.loading = false;
                const token = response.data.token;
                if (token) {
                    this.socketService.connectWithToken();
                    this.router.navigate(['/chat']);
                }
                this.alertService.success('Login Successfully');
            },
            error: (error) => {
                this.loading = false;
                this.alertService.error(error);
            }
        });
    }

    hasError(controlName: string, errorName: string): boolean {
        return this.loginForm.controls[controlName].touched && this.loginForm.controls[controlName].hasError(errorName);
    }
}
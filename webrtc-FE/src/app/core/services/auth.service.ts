import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { IUser } from '../interfaces/user';
import { environment } from 'src/environments/environment';


const TOKEN_KEY = 'auth_token';
const USER_KEY = 'user';

/** True when the JWT's `exp` has passed (or the token can't be read). Checked locally, no request. */
export function tokenExpired(token: string, nowMs = Date.now()): boolean {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    return typeof exp === 'number' && exp * 1000 <= nowMs;
  } catch {
    return true;
  }
}

/** Forget the stored session. Plain function so the HTTP interceptor can use it without DI cycles. */
export function clearStoredSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = `${environment.apiUrl}/web/user`;  
  private tokenKey = TOKEN_KEY;

  constructor(
    private http: HttpClient, 
    private router: Router
  ) { }

  register(user: IUser): Observable<IUser> {
    return this.http.post<IUser>(`${this.apiUrl}/register`, user);
  }



  loginUser(email: string, password: string): Observable<any> {
    const body = { email, password };
    return this.http.post<any>(`${this.apiUrl}/login`, body).pipe(
      map(response => {
        const token = response.data.token;
        if (!token) return;
        localStorage.setItem(this.tokenKey, token);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        return response;
      })
    );
  }

  getToken(): string | null {
    return localStorage.getItem(this.tokenKey);
  }

  /** Signed in = a stored user and a token that has not expired. An expired session is cleared. */
  loggedIn(): boolean {
    const token = this.getToken();
    if (!token || !localStorage.getItem(USER_KEY)) {
      return false;
    }
    if (tokenExpired(token)) {
      clearStoredSession();
      return false;
    }
    return true;
  }

  getHeaders(): HttpHeaders {
    const token = this.getToken();
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    });
  }

  logout() {
    clearStoredSession();
    this.router.navigate(['/auth/login']);
  }

  getLoggedInUser() {
    const loggedInUser = localStorage.getItem('user');
    return loggedInUser ? JSON.parse(loggedInUser) : null;
  }

  /** Merge fresh profile fields (after a profile save) into the stored session user. */
  updateLoggedInUser(changes: Record<string, unknown>) {
    const current = this.getLoggedInUser();
    if (current) {
      localStorage.setItem('user', JSON.stringify({ ...current, ...changes }));
    }
  }
}

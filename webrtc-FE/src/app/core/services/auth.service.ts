import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { IUser } from '../interfaces/user';
import { environment } from 'src/environments/environment';


@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = `${environment.apiUrl}/web/user`;  
  private tokenKey = 'auth_token';

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

  loggedIn(): boolean {
    return !!localStorage.getItem('user');
  }

  getHeaders(): HttpHeaders {
    const token = this.getToken();
    return new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    });
  }

  logout() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem('user');
    this.router.navigate(['/auth/login']);
  }

  getLoggedInUser() {
    const loggedInUser = localStorage.getItem('user');
    return loggedInUser ? JSON.parse(loggedInUser) : null;
  }
}

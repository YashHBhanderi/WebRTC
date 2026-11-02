import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { Subject } from 'rxjs';
import { UserService } from './user.service';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

describe('UserService', () => {
  it('loads conversations from the API (archived ones on request)', () => {
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        { provide: SocketService, useValue: new Proxy({}, { get: () => () => new Subject() }) },
        { provide: AuthService, useValue: { getToken: () => Promise.resolve('t'), loggedIn: () => true } },
        { provide: AlertService, useValue: jasmine.createSpyObj('AlertService', ['error']) },
      ],
    });
    const service = TestBed.inject(UserService);
    const http = TestBed.inject(HttpTestingController);
    service.getUserConversations().subscribe();
    service.getUserConversations(true).subscribe();
    expect(http.match((r) => /\/conversations$/.test(r.url)).length).toBe(1);
    expect(http.match((r) => /\/conversations\?archived=true$/.test(r.url)).length).toBe(1);
  });
});

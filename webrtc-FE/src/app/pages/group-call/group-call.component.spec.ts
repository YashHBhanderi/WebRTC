import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { of } from 'rxjs';
import { GroupCallComponent } from './group-call.component';
import { AuthService } from '../../core/services/auth.service';
import { SocketService } from '../../core/services/socket.service';
import { MediasoupService } from '../../core/services/mediasoup.service';
import { UserService } from '../../core/services/user.service';
import { CallPipService } from '../../core/services/call-pip.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

const stub = () => new Proxy({}, { get: (_t, name) => (name === 'then' ? undefined : () => of(null)) });

// Construction only: joining a call needs a real mediasoup router (verified by the staging call tests).
describe('GroupCallComponent', () => {
  it('is created with its dependencies', () => {
    TestBed.configureTestingModule({
      declarations: [GroupCallComponent],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [AuthService, SocketService, MediasoupService, UserService, CallPipService, AlertService].map((provide) => ({ provide, useValue: stub() })),
    });
    expect(TestBed.createComponent(GroupCallComponent).componentInstance).toBeTruthy();
  });
});

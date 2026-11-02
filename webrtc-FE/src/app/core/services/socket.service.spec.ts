import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { Socket } from 'ngx-socket-io';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

/**
 * Connection lifecycle. Restarting a connection that is still being established opened a gap in
 * which an incoming call could be lost (Phase 5B finding); ensureConnected must not do that.
 */
describe('SocketService', () => {
  let ioSocket: { connected: boolean; active: boolean; auth: unknown };
  let socket: { ioSocket: typeof ioSocket; connect: jasmine.Spy; disconnect: jasmine.Spy; on: jasmine.Spy; emit: jasmine.Spy; fromEvent: jasmine.Spy };
  let auth: { loggedIn: jasmine.Spy; getToken: jasmine.Spy };
  let service: SocketService;

  beforeEach(() => {
    ioSocket = { connected: false, active: false, auth: null };
    socket = { ioSocket, connect: jasmine.createSpy('connect'), disconnect: jasmine.createSpy('disconnect'), on: jasmine.createSpy(), emit: jasmine.createSpy(), fromEvent: jasmine.createSpy() };
    auth = { loggedIn: jasmine.createSpy().and.returnValue(true), getToken: jasmine.createSpy().and.resolveTo('session-token') };
    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        { provide: Socket, useValue: socket },
        { provide: AuthService, useValue: auth },
        { provide: AlertService, useValue: jasmine.createSpyObj('AlertService', ['error']) },
      ],
    });
    service = TestBed.inject(SocketService); // constructor connects once
    socket.connect.calls.reset();
    socket.disconnect.calls.reset();
  });

  it('does not restart a connection that is still being established', () => {
    ioSocket.active = true;
    service.ensureConnected();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('does nothing when already connected', () => {
    ioSocket.connected = true;
    ioSocket.active = true;
    service.ensureConnected();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('connects when idle, with a fresh (uncached) session token in the handshake', async () => {
    service.ensureConnected();
    expect(socket.connect).toHaveBeenCalledTimes(1);
    const token = await new Promise<any>((resolve) => (ioSocket.auth as (cb: (d: any) => void) => void)(resolve));
    expect(auth.getToken).toHaveBeenCalledWith({ skipCache: true });
    expect(token.token).toBe('session-token');
  });

  it('does not connect when signed out', () => {
    auth.loggedIn.and.returnValue(false);
    service.ensureConnected();
    expect(socket.connect).not.toHaveBeenCalled();
  });
});

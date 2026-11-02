import { TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { of, Subject } from 'rxjs';
import { CallManagerService } from './call-manager.service';
import { SocketService } from './socket.service';
import { UserService } from './user.service';
import { MessageSenderService } from './message-sender.service';
import { CallNotificationService } from './call-notification.service';
import { AlertService } from 'src/app/_shared/alert/alert.service';

/**
 * Incoming calls across reconnects (Phase 5C). After every (re)connect the server sends the calls still
 * ringing for this user (`call:pending-rings`); the client must show one it missed and drop a ring that
 * was cancelled / answered while it was disconnected — but never a ring that arrived after reconnecting.
 */
describe('CallManagerService — pending rings after reconnect', () => {
  let streams: Record<string, Subject<any>>;
  let calls: CallManagerService;
  const flush = () => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    streams = {};
    const stream = (name: string) => (streams[name] ??= new Subject<any>());
    const socket = new Proxy({}, { get: (_t, name: string) => () => stream(name) });
    const users = {
      getUserConversations: () => of({ data: [] }),
      getUserGropuConversations: () => of({ data: [] }),
      getUserById: () => of({ data: { _id: 'u1', username: 'Alice' } }),
    };
    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      providers: [
        { provide: SocketService, useValue: socket },
        { provide: UserService, useValue: users },
        { provide: MessageSenderService, useValue: {} },
        { provide: CallNotificationService, useValue: { actions$: new Subject(), show: () => undefined, close: () => undefined, ring: () => undefined, stop: () => undefined } },
        { provide: AlertService, useValue: jasmine.createSpyObj('AlertService', ['error', 'warning', 'info', 'success']) },
      ],
    });
    calls = TestBed.inject(CallManagerService);
    calls.start();
  });

  const ring = (callId: string, extra: Record<string, unknown> = {}) => ({ callId, groupId: 'g-' + callId, callType: 'audio', mode: 'ring', initiatedBy: 'u1', ...extra });

  it('shows a ring that was missed while disconnected', async () => {
    streams['onConnect'].next(undefined);
    streams['onPendingRings'].next({ calls: [ring('c1', { resent: true })] });
    await flush();
    expect(calls.incomingCall?.callId).toBe('c1');
  });

  it('drops a ring shown before the reconnect that is no longer pending (cancelled / answered elsewhere)', async () => {
    streams['onIncomingGroupCall'].next(ring('c1'));
    await flush();
    expect(calls.incomingCall?.callId).toBe('c1');
    await new Promise((r) => setTimeout(r, 5));
    streams['onConnect'].next(undefined);
    streams['onPendingRings'].next({ calls: [] });
    expect(calls.incomingCall).toBeNull();
  });

  it('keeps a ring that arrived AFTER reconnecting even if the (older) list does not contain it', async () => {
    streams['onConnect'].next(undefined);
    await new Promise((r) => setTimeout(r, 5));
    streams['onIncomingGroupCall'].next(ring('c2'));
    await flush();
    streams['onPendingRings'].next({ calls: [] });
    expect(calls.incomingCall?.callId).toBe('c2');
  });

  it('does not ring twice for the same call (live ring + resent ring)', async () => {
    streams['onIncomingGroupCall'].next(ring('c3'));
    await flush();
    const first = calls.incomingCall;
    streams['onPendingRings'].next({ calls: [ring('c3', { resent: true })] });
    await flush();
    expect(calls.incomingCall).toBe(first);
  });

  it('ignores Meet Now entries (no ring popup for them)', async () => {
    streams['onConnect'].next(undefined);
    streams['onPendingRings'].next({ calls: [ring('c4', { mode: 'meetNow' })] });
    await flush();
    expect(calls.incomingCall).toBeNull();
  });
});

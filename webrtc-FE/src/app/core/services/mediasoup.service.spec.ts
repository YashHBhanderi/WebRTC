import { TestBed } from '@angular/core/testing';
import { MediasoupService } from './mediasoup.service';
import { SocketService } from './socket.service';
import { AuthService } from './auth.service';
import { VideoEffectsService } from './video-effects.service';

// Construction only: the media paths need a real mediasoup router (covered by the staging call tests)
describe('MediasoupService', () => {
  it('can be created with its dependencies', () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: SocketService, useValue: { on: () => undefined, emit: () => undefined } },
        { provide: AuthService, useValue: {} },
        { provide: VideoEffectsService, useValue: {} },
      ],
    });
    expect(TestBed.inject(MediasoupService)).toBeTruthy();
  });
});

// SEC-005: the server refuses transports until the call is joined, so the client must not ask before
describe('MediasoupService transport ordering (SEC-005)', () => {
  let service: MediasoupService;
  let emitted: string[];
  let joinResponse: any;

  const fakeTransport = (id: string) => ({ id, closed: false, direction: 'x', on: () => undefined });

  beforeEach(() => {
    emitted = [];
    joinResponse = { success: true, producers: [] };
    const socket = {
      on: () => undefined,
      emit: () => undefined,
      emitWithAck: (event: string, _data: unknown, cb: (r: any) => void) => {
        emitted.push(event);
        if (event === 'mediasoup:joinCall') cb(joinResponse);
        else if (event === 'mediasoup:createSendTransport') cb({ id: 'send-1' });
        else if (event === 'mediasoup:createRecvTransport') cb({ id: 'recv-1' });
        else cb({});
      },
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SocketService, useValue: socket },
        { provide: AuthService, useValue: {} },
        { provide: VideoEffectsService, useValue: {} },
      ],
    });
    service = TestBed.inject(MediasoupService);
    const s = service as any;
    // A loaded device stand-in (no real router in unit tests)
    s.device = { createSendTransport: (o: any) => fakeTransport(o.id), createRecvTransport: (o: any) => fakeTransport(o.id) };
    spyOn(s, 'startQualityMonitor').and.stub();
    spyOn(s, 'watchTransportConnection').and.stub();
    spyOn(s, 'startProducerSyncLoop').and.stub();
    spyOn(s, 'syncProducers').and.returnValue(Promise.resolve());
  });

  const transportEvents = () => emitted.filter((e) => /Transport$/.test(e));

  it('initialize() creates no transports', async () => {
    await service.initialize();
    expect(transportEvents()).toEqual([]);
  });

  it('does not create transports while waiting in the lobby', async () => {
    joinResponse = { lobby: true };
    const response = await service.joinCall('call-1', 'audio');
    expect(response.lobby).toBeTrue();
    expect(transportEvents()).toEqual([]);
  });

  it('creates send and receive transports only after a successful join', async () => {
    await service.initialize();
    await service.joinCall('call-1', 'audio');
    expect(emitted).toEqual(['mediasoup:joinCall', 'mediasoup:createSendTransport', 'mediasoup:createRecvTransport']);
  });

  it('rejects the join when the server refuses a transport (NOT_JOINED)', async () => {
    const s = service as any;
    s.socketService.emitWithAck = (event: string, _d: unknown, cb: (r: any) => void) => {
      emitted.push(event);
      cb(event === 'mediasoup:joinCall' ? { success: true, producers: [] } : { error: 'Join the call before using media', code: 'NOT_JOINED' });
    };
    await expectAsync(service.joinCall('call-1', 'audio')).toBeRejectedWithError(/Join the call/);
    expect(s.startProducerSyncLoop).not.toHaveBeenCalled();
  });
});

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

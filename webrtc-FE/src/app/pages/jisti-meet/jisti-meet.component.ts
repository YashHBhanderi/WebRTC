import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren
} from '@angular/core';

import {
  ActivatedRoute,
  Router
} from '@angular/router';

import { Subscription } from 'rxjs';

import { AuthService } from 'src/app/core/services/auth.service';
import { SocketService } from 'src/app/core/services/socket.service';
import { MediasoupService } from 'src/app/core/services/mediasoup.service';

@Component({
  selector: 'app-jisti-meet',
  templateUrl: './jisti-meet.component.html',
  styleUrls: ['./jisti-meet.component.scss']
})
export class JistiMeetComponent
  implements OnInit, OnDestroy {

  groupId!: string;
  callId!: string;
  callType!: 'audio' | 'video';

  remoteStreams: {
    userId: string;
    stream: MediaStream;
  }[] = [];

  private remoteStreamSubscription?: Subscription;
  localStream?: MediaStream;
  private localStreamSubscription?: Subscription;
  @ViewChild('localVideo') localVideo!: ElementRef<HTMLVideoElement>;
  @ViewChildren('remoteVideo') remoteVideos!: QueryList<ElementRef<HTMLVideoElement>>;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private authService: AuthService,
    private socketService: SocketService,
    private mediasoupService: MediasoupService
  ) { }

  async ngOnInit(): Promise<void> {
    this.groupId =
      this.route.snapshot.params['groupId'];

    this.callId =
      this.route.snapshot.queryParams['callId'];

    this.callType =
      this.route.snapshot.queryParams['callType'];

    console.log('Group ID:', this.groupId);
    console.log('Call ID:', this.callId);

    if (!this.callId) {
      console.error('Call ID is missing');
      return;
    }

    this.remoteStreamSubscription =
      this.mediasoupService.remoteStream$
        .subscribe((data) => {

          const existing =
            this.remoteStreams.find(
              x => x.userId === data.userId
            );

          if (existing) {
            existing.stream = data.stream;
          } else {
            this.remoteStreams.push({
              userId: data.userId,
              stream: data.stream
            });
          }

          console.log(
            'Remote stream:',
            data.userId,
            data.stream
          );

          this.updateRemoteVideos();
        });

    this.localStreamSubscription =
      this.mediasoupService.localStream$
        .subscribe((stream) => {

          this.localStream = stream;

          this.setLocalVideo(stream);
        });

    try {
      // 1. Initialize mediasoup
      await this.mediasoupService.initialize();

      console.log(
        'Group call mediasoup initialized'
      );

      // 2. Join the call FIRST
      const response =
        await this.mediasoupService.joinCall(
          this.callId,
          this.callType
        );

      console.log(
        'Joined mediasoup call:',
        this.callId
      );

      console.log(
        'Existing producers:',
        response.producers
      );

      // 3. Consume producers that already exist
      if (response.producers?.length) {
        for (const producer of response.producers) {
          await this.mediasoupService.consumeProducer(
            producer.producerId,
            producer.userId,
            producer.kind
          );
        }
      }

      // 4. Start local microphone/camera AFTER joining
      await this.mediasoupService.startLocalMedia(
        this.callType
      );

      console.log(
        'Local media started'
      );

    } catch (error) {
      console.error(
        'Failed to initialize group call:',
        error
      );
    }
  }

  private updateRemoteVideos(): void {
    setTimeout(() => {
      this.remoteVideos.forEach((video, index) => {

        const remote = this.remoteStreams[index];

        if (remote) {
          video.nativeElement.srcObject =
            remote.stream;
        }

      });
    });
  }

  private setLocalVideo(stream: MediaStream): void {
    if (!this.localVideo) {
      setTimeout(() => {
        this.setLocalVideo(stream);
      });

      return;
    }

    this.localVideo.nativeElement.srcObject = stream;
  }

  ngOnDestroy(): void {
    this.remoteStreamSubscription?.unsubscribe();
    this.localStreamSubscription?.unsubscribe();
  }
}
import * as mediasoup from 'mediasoup';

export interface MediasoupPeer {
  userId: string;
  socketId: string;
  callId?: string;

  callType?: 'audio' | 'video';

  sendTransport?: mediasoup.types.WebRtcTransport;
  recvTransport?: mediasoup.types.WebRtcTransport;

  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
}
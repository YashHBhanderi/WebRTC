/** What the chat hands to the call surface to open (or resume) a call. */
export interface CallLaunch {
  groupId: string;
  callId: string;
  callType: 'audio' | 'video';
  isGroup: boolean;
  /** Group name, or the other person's name in a 1:1 call */
  title: string;
  avatar?: string;
  /** Known conversation members — avoids a profile request per participant */
  members?: CallMember[];
  /** I started this ring (outgoing "Calling…" state) */
  isInitiator?: boolean;
  /** Show the pre-join screen (camera/mic check) before entering */
  prejoin?: boolean;
  /** 1:1 only: whether the callee was online when the call started */
  peerOnline?: boolean;
}

export interface CallMember {
  _id: string;
  username?: string;
  avatar?: string;
}

/** Result of the pre-join screen. */
export interface PrejoinResult {
  stream: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
}

export type StageItemKind = 'self' | 'remote' | 'screen';

/** One renderable tile on the call stage (main view, PiP or side strip). */
export interface StageItem {
  key: string;
  kind: StageItemKind;
  userId: string;
  name: string;
  avatar?: string;
  stream: MediaStream | null;
  /** A live video track exists and the owner has the camera on */
  showVideo: boolean;
  mirror: boolean;
  audioOn: boolean;
  speaking: boolean;
  handRaised: boolean;
  connecting: boolean;
  isHost: boolean;
}

export const CALL_REACTIONS = ['👍', '❤️', '😂', '👏', '😮', '😢'] as const;

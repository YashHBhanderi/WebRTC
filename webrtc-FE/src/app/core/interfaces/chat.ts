/** Public user fields as returned by the API (never contains credentials). */
export interface ChatUser {
  _id: string;
  username: string;
  email?: string;
  avatar?: string;
  isOnline?: boolean;
  lastSeen?: string | Date;
  bio?: string;
  status?: string;
}

export interface ChatReaction {
  userId: string;
  emoji: string;
}

export interface ChatMessage {
  _id: string;
  user: any;
  userId?: string;
  content?: string;
  fileUrl?: string;
  type: string;
  isDeleted: boolean;
  isRead?: boolean;
  createdAt: string;
  senderName?: string;
  replyTo?: any;
  reactions?: ChatReaction[];
  thumbnailUrl?: string;
  conversationId?: string;
  /** Stored attachments: original file name, size in bytes and MIME type. */
  fileName?: string;
  /** Pre-signed link that downloads the attachment under its original name. */
  downloadUrl?: string;
  fileSize?: number;
  mimeType?: string;
}

export type UploadTarget =
  | { purpose: 'message'; conversationId: string }
  | { purpose: 'group-avatar'; groupId: string };

/** POST /upload response. */
export interface UploadResult {
  storageKey: string;
  fileUrl: string;
  thumbnailUrl: string;
  type: 'image' | 'video' | 'audio' | 'pdf';
  mimeType: string;
  originalName: string;
  size: number;
}

/** What a composer hands to the sender. */
export interface MessageDraft {
  text: string;
  file: File | null;
  replyToId?: string | null;
}

export interface GroupSummary {
  _id: string;
  groupName?: string;
  groupDescription?: string;
  groupAvatar?: string;
  groupAdmins: string[];
  members: ChatUser[];
}

export interface ChatState {
  isArchived: boolean;
  archivedAt: string | null;
  clearedAt: string | null;
  isGroup: boolean;
  peerId: string | null;
  blockedByMe: boolean;
}

export interface SearchResult {
  _id: string;
  content: string;
  type: string;
  createdAt: string;
  user: { _id: string; username?: string; avatar?: string };
}

export interface SearchCursor {
  before: string;
  beforeId: string;
}

export interface SearchPage {
  results: SearchResult[];
  nextCursor: SearchCursor | null;
}

export const MEDIA_TYPE_LABELS: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  pdf: 'Document',
};

/** Text or media caption. Without a caption the server stores the type name as content. */
export function messageHasText(msg: Pick<ChatMessage, 'content' | 'type'>): boolean {
  return !!msg.content && msg.type !== 'call' && msg.type !== 'system' && msg.content !== msg.type;
}

export function messagePreview(msg: Pick<ChatMessage, 'content' | 'type'> | null | undefined): string {
  if (!msg) {
    return '';
  }
  if (messageHasText(msg)) {
    return msg.content || '';
  }
  return MEDIA_TYPE_LABELS[msg.type] || msg.content || '';
}

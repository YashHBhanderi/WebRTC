export interface IConversation {
    _id: string;
    members: string[];
    messages: string[];
    isGroup: boolean;
    groupName?: string;
    groupAdmin?: string;
    groupAvatar?: string;
    groupDescription?: string;
    timestamp: Date;
  }
  
  export interface IMessage {
    _id: string;
    userId: string;
    content: string;
    fileUrl: string;
    thumbnailUrl: string;
    type: "text" | "image" | "video" | "audio" | "pdf";
    isRead: boolean;
    isDeleted: boolean;
    createdAt: Date;
  }
  
 
import { Router } from "express";
import { requireUser } from "../middleware/authMiddleware";
import SearchController from "../controllers/search.controller";
import NotificationController from "../controllers/notification.controller";
import CallHistoryController from "../controllers/call-history.controller";
import MeetingController from "../controllers/meeting.controller";
import RecordingController from "../controllers/recording.controller";
import UserController from "../controllers/userController";
import ConversationController from "../controllers/conversationController";
import { uploadSingle } from "../utils/multer";
import MessageController  from "../controllers/message.controller";

const router = Router();

// Sign-up / sign-in happen in Clerk; the app account is linked or created on the first request
router.get('/web/user/me', requireUser("profile:read"), UserController.me);
router.get('/web/users', requireUser("directory:read"), UserController.getAllUser);
router.delete('/web/deleteUser/:id', requireUser(null), UserController.deleteUser);
router.get('/web/user/:userId', requireUser("profile:read"), UserController.getUserById);
router.get('/web/users/except-current', requireUser("directory:read"), UserController.getAllUsersExceptCurrentUser);

router.get('/conversations', requireUser("conversations:read"), ConversationController.getUserConversations);
router.post('/conversations', requireUser("conversations:write"), ConversationController.createOrGetConversation);
router.get('/messages/:conversationId', requireUser("messages:read"), ConversationController.getMessagesByConversationId);
router.get('/messages/:conversationId/search', requireUser("messages:read"), ConversationController.searchMessages);
router.get('/messages/:conversationId/position/:messageId', requireUser("messages:read"), ConversationController.messagePosition);
router.get('/conversations/:conversationId/state', requireUser("conversations:read"), ConversationController.getChatState);

router.post('/conversations/group', requireUser("groups:write"), uploadSingle('image'), ConversationController.createGroupConversation);
router.put('/conversations/group/:id/add-member', requireUser("groups:manage"), ConversationController.addMembersInGroup);
router.put('/conversations/group/:id/remove-member', requireUser("groups:manage"), ConversationController.removeMemberFromGroup);

router.get('/groupConversations', requireUser("groups:read"), ConversationController.getUserGroupsConversations);
router.get('/conversations/:id/group', requireUser("groups:read"), ConversationController.getGroupInfo);
router.delete('/conversations/:conversationId', requireUser("conversations:delete"), ConversationController.deleteConversation);

router.delete('/messages/:messageId', requireUser("messages:delete"), MessageController.deleteMessage);
router.put('/messages/:messageId/save', requireUser("messages:react"), MessageController.setSaved);
router.get('/saved-messages', requireUser("messages:read"), MessageController.listSaved);


router.get('/search', requireUser("search:read"), SearchController.search);
router.get('/files', requireUser("files:read"), SearchController.files);
router.get('/calls', requireUser("calls:read"), CallHistoryController.list);

router.get('/meetings', requireUser("meetings:read"), MeetingController.range);
router.post('/meetings', requireUser("meetings:write"), MeetingController.create);
router.get('/meetings/code/:code', requireUser("meetings:read"), MeetingController.preview);
router.post('/meetings/code/:code/join', requireUser("meetings:write"), MeetingController.join);
router.get('/meetings/:id', requireUser("meetings:read"), MeetingController.get);
router.patch('/meetings/:id', requireUser("meetings:write"), MeetingController.update);
router.delete('/meetings/:id', requireUser("meetings:write"), MeetingController.cancel);

router.get('/recordings/:id', requireUser("recordings:read"), RecordingController.get);
router.get('/recordings/:id/transcript', requireUser("recordings:read"), RecordingController.transcript);
router.get('/recordings/:id/transcript/export', requireUser("recordings:read"), RecordingController.exportTranscript);
router.post('/recordings/:id/transcript/retry', requireUser("recordings:write"), RecordingController.retryTranscript);
router.get('/conversations/:conversationId/recordings', requireUser("recordings:read"), RecordingController.list);

router.get('/notifications', requireUser("notifications:read"), NotificationController.list);
router.get('/notifications/unread-count', requireUser("notifications:read"), NotificationController.unreadCount);
router.post('/notifications/read', requireUser("notifications:write"), NotificationController.markRead);

router.get('/conversations/:conversationId/media', requireUser("files:read"), ConversationController.getSharedMedia);
router.patch('/web/user/profile', requireUser("profile:write"), uploadSingle('image'), UserController.updateProfile);

export default router;

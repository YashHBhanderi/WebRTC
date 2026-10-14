import { Router } from "express";
import verifyToken from "../middleware/authMiddleware";
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
router.get('/web/user/me', verifyToken, UserController.me);
router.get('/web/users', verifyToken, UserController.getAllUser);
router.delete('/web/deleteUser/:id', verifyToken, UserController.deleteUser);
router.get('/web/user/:userId', verifyToken, UserController.getUserById);
router.get('/web/users/except-current', verifyToken, UserController.getAllUsersExceptCurrentUser);

router.get('/conversations', verifyToken, ConversationController.getUserConversations);
router.post('/conversations', verifyToken, ConversationController.createOrGetConversation);
router.get('/messages/:conversationId', verifyToken, ConversationController.getMessagesByConversationId);
router.get('/messages/:conversationId/search', verifyToken, ConversationController.searchMessages);
router.get('/messages/:conversationId/position/:messageId', verifyToken, ConversationController.messagePosition);
router.get('/conversations/:conversationId/state', verifyToken, ConversationController.getChatState);

router.post('/conversations/group', verifyToken, uploadSingle('image'), ConversationController.createGroupConversation);
router.put('/conversations/group/:id/add-member', verifyToken, ConversationController.addMembersInGroup);
router.put('/conversations/group/:id/remove-member', verifyToken, ConversationController.removeMemberFromGroup);

router.get('/groupConversations', verifyToken, ConversationController.getUserGroupsConversations);
router.get('/conversations/:id/group', verifyToken, ConversationController.getGroupInfo);
router.delete('/conversations/:conversationId', verifyToken, ConversationController.deleteConversation);

router.delete('/messages/:messageId', verifyToken, MessageController.deleteMessage);
router.put('/messages/:messageId/save', verifyToken, MessageController.setSaved);
router.get('/saved-messages', verifyToken, MessageController.listSaved);


router.get('/search', verifyToken, SearchController.search);
router.get('/files', verifyToken, SearchController.files);
router.get('/calls', verifyToken, CallHistoryController.list);

router.get('/meetings', verifyToken, MeetingController.range);
router.post('/meetings', verifyToken, MeetingController.create);
router.get('/meetings/code/:code', verifyToken, MeetingController.preview);
router.post('/meetings/code/:code/join', verifyToken, MeetingController.join);
router.get('/meetings/:id', verifyToken, MeetingController.get);
router.patch('/meetings/:id', verifyToken, MeetingController.update);
router.delete('/meetings/:id', verifyToken, MeetingController.cancel);

router.get('/recordings/:id', verifyToken, RecordingController.get);
router.get('/recordings/:id/transcript', verifyToken, RecordingController.transcript);
router.get('/recordings/:id/transcript/export', verifyToken, RecordingController.exportTranscript);
router.post('/recordings/:id/transcript/retry', verifyToken, RecordingController.retryTranscript);
router.get('/conversations/:conversationId/recordings', verifyToken, RecordingController.list);

router.get('/notifications', verifyToken, NotificationController.list);
router.get('/notifications/unread-count', verifyToken, NotificationController.unreadCount);
router.post('/notifications/read', verifyToken, NotificationController.markRead);

router.get('/conversations/:conversationId/media', verifyToken, ConversationController.getSharedMedia);
router.patch('/web/user/profile', verifyToken, uploadSingle('image'), UserController.updateProfile);

export default router;

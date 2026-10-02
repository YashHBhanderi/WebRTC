import { Router } from "express";
import verifyToken from "../middleware/authMiddleware";
import UserController from "../controllers/userController";
import ConversationController from "../controllers/conversationController";
import uploadCloudnary from "../utils/cloudinary";
import MessageController  from "../controllers/message.controller";
import JitsiCallController from "../controllers/jitsiCall.Controller";

const router = Router();

router.post('/web/user/register', uploadCloudnary.single('image'), UserController.creatUser);
router.post('/web/user/login', UserController.loginUser);
router.get('/web/users', UserController.getAllUser);
router.delete('/web/deleteUser/:id', verifyToken, UserController.deleteUser);
router.get('/web/user/:userId', verifyToken, UserController.getUserById);
router.get('/web/users/except-current', verifyToken, UserController.getAllUsersExceptCurrentUser);

router.get('/conversations', verifyToken, ConversationController.getUserConversations);
router.post('/conversations', verifyToken, ConversationController.createOrGetConversation);
router.get('/messages/:conversationId', verifyToken, ConversationController.getMessagesByConversationId);

router.post('/conversations/group', verifyToken, uploadCloudnary.single('image'), ConversationController.createGroupConversation);
router.put('/conversations/group/:id/add-member', verifyToken, ConversationController.addMembersInGroup);
router.put('/conversations/group/:id/remove-member', verifyToken, ConversationController.removeMemberFromGroup);

router.get('/groupConversations', verifyToken, ConversationController.getUserGroupsConversations);
router.get('/conversations/:id/group', verifyToken, ConversationController.getGroupInfo);
router.delete('/conversations/:conversationId', verifyToken, ConversationController.deleteConversation);

router.delete('/messages/:messageId', verifyToken, MessageController.deleteMessage);

router.get('/jitsi-room/:roomName', verifyToken, JitsiCallController.generateJitsiToken);

router.get('/conversations/:conversationId/media', verifyToken, ConversationController.getSharedMedia);
router.patch('/web/user/profile', verifyToken, uploadCloudnary.single('image'), UserController.updateProfile);

export default router;

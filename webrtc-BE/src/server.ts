import express, { Request, Response } from "express";
import connectDB from "./config/database";
import * as dotenv from 'dotenv';
import { Server } from "socket.io";
import http from "http";
import path from 'path';
import cors from 'cors';
import router from "./routes/routes";
import Message from "./models/messageModel";
import Conversation from "./models/conversationModel";
import mongoose from "mongoose";
import User, { IUser } from "./models/userModel";
import { v2 as cloudinary } from "cloudinary";
import uploadCloudnary from "./utils/cloudinary";
import { JwtUtills } from "./utils/jwtUtiils";
import { logger } from "./utils/logger";
import ConversationService from "./services/conversationService";
import callService from "./services/call.service";
import dns from "dns";
import mediasoupService from "./services/mediasoup.service";
import * as mediasoup from 'mediasoup';
import { rewriteIceCandidates } from "./utils/network";

dotenv.config();
dns.setDefaultResultOrder('ipv4first');

const app = express();
const port = process.env.PORT ?? 8080;
const server = http.createServer(app);
const userSockets = new Map<string, string>();
/** One screen sharer per call room key */
const screenShareByCall = new Map<string, { userId: string; socketId: string }>();

function releaseScreenShare(
  callKey: string,
  userId?: string,
  broadcast = true
) {
  const current = screenShareByCall.get(callKey);
  if (!current) {
    return;
  }
  if (userId && current.userId !== userId) {
    return;
  }
  screenShareByCall.delete(callKey);
  if (broadcast) {
    io.to(callKey).emit("screen:stopped", {
      callId: callKey,
      userId: current.userId,
    });
  }
}


const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  maxHttpBufferSize: 1e8
});

app.use(logger);
app.use(express.json({ limit: "1000mb" }));
app.use(express.urlencoded({ extended: true, limit: "1000mb" }));
app.use(cors());
app.use("/", router);

app.post("/upload", uploadCloudnary.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const mimeType = req.file.mimetype;
    let resourceType: "image" | "video" | "auto" | "raw" = "auto";
    if (mimeType.startsWith("video/")) {
      resourceType = "video";
    } else if (mimeType.startsWith("image/")) {
      resourceType = "image";
    } else if (mimeType.startsWith("application/pdf")) {
      resourceType = "raw";
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a video or image." });
    }
    const base64String = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(base64String, {
      folder: "uploads",
      resource_type: resourceType,
    });
    const fileUrl = result.secure_url;
    let thumbnailUrl = fileUrl;

    if (resourceType === "image") {
      thumbnailUrl = cloudinary.url(result.public_id, {
        width: 250,
        height: 250,
        crop: "thumb",
        gravity: "face",
        secure: true
      });
    } else if (resourceType === "video") {
      thumbnailUrl = cloudinary.url(result.public_id, {
        resource_type: "video",
        format: "jpg",
        width: 250,
        height: 250,
        crop: "thumb",
        secure: true
      });
    }

    res.status(200).json({ fileUrl, thumbnailUrl });
  } catch (error) {
    res.status(500).json({ status: false, data: null, message: [error.message].join(', ') });
  }
});

io.use((socket, next) => {
  const token = socket.handshake.query.token;
  if (!token) {
    return next(new Error("Authentication error"));
  }
  try {
    const decoded = JwtUtills.verifyToken(token as string) as { userId: string };
    socket.data.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});


io.on("connection", async (socket) => {
  const userId = socket.data.userId;
  if (!userId) {
    socket.disconnect();
    return;
  }

  const peer = mediasoupService.createPeer(
    userId,
    socket.id
  );

  console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);
  await User.findByIdAndUpdate(userId, { isOnline: true });
  userSockets.set(userId, socket.id);

  socket.on("joinConversation", async (conversationId) => {
    socket.join(conversationId);
    console.log(`User ${socket.data.userId} joined conversation: ${conversationId}`);
  });

  socket.on("sendMessage", async (messageData: { user: IUser, conversationId: mongoose.Schema.Types.ObjectId, content: string, fileUrl?: string, thumbnailUrl?: string, type: string, replyTo?: string }) => {

    const newMessage = new Message({
      userId: messageData.user._id,
      content: messageData.content || messageData.type,
      fileUrl: messageData.fileUrl || "",
      thumbnailUrl: messageData.thumbnailUrl || messageData.fileUrl || "",
      type: messageData.type,
      replyTo: messageData.replyTo ? new mongoose.Types.ObjectId(messageData.replyTo) : null,
      createdAt: new Date(),
    });

    await newMessage.save();

    const conversation = await Conversation.findById(messageData.conversationId);
    if (conversation) {
      conversation.messages.push(newMessage._id as mongoose.Schema.Types.ObjectId);
      await conversation.save();

      const populatedMessage = await Message.findById(newMessage._id).populate('replyTo');

      io.to(messageData.conversationId.toString()).emit("receiveMessage", {
        ...populatedMessage?.toObject(),
        user: messageData.user,
        conversationId: messageData.conversationId,
      });

      conversation.members.forEach((member) => {
        if (userSockets.has(member.toString()) && member.toString() !== messageData.user._id.toString()) {
          io.to(userSockets.get(member.toString())!).emit("receiveMessage", {
            ...populatedMessage?.toObject(),
            conversationId: messageData.conversationId,
          });
        }
      });
    } else {
      console.log("Conversation not found");
    }
  });

  socket.on("reactToMessage", async (data: { messageId: string, emoji: string, conversationId: string }) => {
    try {
      const updatedMessage = await ConversationService.addReaction(data.messageId, socket.data.userId, data.emoji);
      io.to(data.conversationId).emit("messageReactionUpdated", {
        messageId: data.messageId,
        reactions: updatedMessage.reactions,
        conversationId: data.conversationId
      });
    } catch (error) {
      console.error("Error adding reaction:", error);
    }
  });

  socket.on("typing", (conversationId: mongoose.Schema.Types.ObjectId | string, userId: mongoose.Schema.Types.ObjectId) => {
    socket.broadcast.to(conversationId as string).emit("userTyping", { userId, isTyping: true });
  });

  socket.on("stopTyping", (conversationId: mongoose.Schema.Types.ObjectId | string, userId: mongoose.Schema.Types.ObjectId) => {
    socket.broadcast.to(conversationId as string).emit("userTyping", { userId, isTyping: false });
  });

  socket.on("markMessagesRead", async (conversationId: mongoose.Schema.Types.ObjectId, userId: mongoose.Schema.Types.ObjectId) => {
    try {
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;
      await Message.updateMany(
        {
          _id: { $in: conversation.messages },
          isRead: false,
          userId: { $ne: userId }
        },
        { $set: { isRead: true } }
      );
      io.to(conversationId.toString()).emit("messagesMarkedRead", { conversationId, userId });
    } catch (error) {
      console.error("Error marking messages as read:", error);
    }
  });

  socket.on("callUser", ({ userToCall, signalData, from, callType }) => {
    const socketId = userSockets.get(userToCall);
    if (socketId) {
      io.to(socketId).emit("incomingCall", { from, offer: signalData, callType, to: userToCall });
    }
  });


  socket.on("answerCall", (data) => {
    const socketId = userSockets.get(data.to);
    if (socketId) {
      io.to(socketId).emit("callAccepted", { answer: data.signal });
    } else {
      console.error("Caller not found for answer forwarding.");
    }
  });

  socket.on("iceCandidate", ({ userToCall, candidate }) => {
    const socketId = userSockets.get(userToCall);
    if (socketId) {
      io.to(socketId).emit("iceCandidate", { candidate, from: socket.data.userId });
    }
  });

  socket.on('call-ended', ({ to }) => {
    const socketId = userSockets.get(to);
    if (socketId) {
      io.to(socketId).emit('callEnded', { from: socket.data.userId });
    }
  });



  socket.on("disconnect", async () => {
    const disconnectedSocketId = socket.id;
    console.log(`User disconnected: ${userId} (Socket ID: ${disconnectedSocketId})`);
    await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen: new Date() });

    for (const [callKey, sharer] of screenShareByCall.entries()) {
      if (sharer.socketId === disconnectedSocketId) {
        releaseScreenShare(callKey, userId);
      }
    }

    // Only clear mapping if this socket is still the active one
    if (userSockets.get(userId) === disconnectedSocketId) {
      userSockets.delete(userId);
    }

    // Grace period: socket.io reconnects often mid-call; don't kill media immediately
    setTimeout(async () => {
      const currentSocketId = userSockets.get(userId);
      if (currentSocketId && currentSocketId !== disconnectedSocketId) {
        // Reconnected on a new socket — peer already rebound in connection handler
        console.log(`User ${userId} reconnected; keeping mediasoup peer`);
        return;
      }
      if (currentSocketId === disconnectedSocketId) {
        return;
      }

      console.log(`User ${userId} did not reconnect — cleaning mediasoup peer`);
      const peer = mediasoupService.getPeer(disconnectedSocketId);
      // Only clean THIS socket's peer — never the rebound live peer
      if (!peer || peer.socketId !== disconnectedSocketId) {
        return;
      }
      const callId = peer.callId;

      mediasoupService.leaveCall(disconnectedSocketId);
      mediasoupService.removePeer(disconnectedSocketId);

      if (callId) {
        try {
          const call = await callService.leaveCall(callId as any, userId as any);
          io.to(callId.toString()).emit("call:participant-left", {
            callId,
            userId,
          });

          const remainingMedia = mediasoupService.getPeersByCallId(callId.toString());
          const remainingJoined = callService.countJoined(call);
          const shouldEnd = remainingJoined === 0 && remainingMedia.length === 0;

          if (shouldEnd) {
            await callService.endCall(call._id);
            const endedPayload = {
              callId: call._id.toString(),
              groupId: call.conversationId.toString(),
            };
            io.to(call._id.toString()).emit("call:ended", endedPayload);
            const group = await Conversation.findById(call.conversationId);
            notifyConversationMembers(group?.members, "call:ended", endedPayload);
          }
        } catch (error) {
          console.error("Error leaving call after disconnect:", error);
        }
      }
    }, 12000);
  });

  const notifyConversationMembers = (
    memberIds: any[] | undefined,
    event: string,
    payload: Record<string, unknown>,
    skipUserId?: string
  ) => {
    (memberIds || []).forEach((member) => {
      const memberId = member.toString();
      if (skipUserId && memberId === skipUserId) {
        return;
      }
      const socketId = userSockets.get(memberId);
      if (socketId) {
        io.to(socketId).emit(event, payload);
      }
    });
  };

  socket.on("call:start", async (data) => {
    try {
      const { groupId, callType } = data;
      const mode: "ring" | "meetNow" =
        data.mode === "meetNow" || data.mode === "ring"
          ? data.mode
          : callType === "video"
            ? "meetNow"
            : "ring";

      const group = await Conversation.findById(groupId);
      if (!group) {
        socket.emit("call:error", { message: "Conversation not found" });
        return;
      }

      const existing = await callService.getActiveCall(groupId);
      if (existing) {
        socket.emit("call:started", {
          callId: existing._id,
          groupId,
          callType: existing.callType,
          mode: (existing as any).mode || "ring",
          initiatedBy: existing.initiatedBy,
          resumed: true,
        });
        return;
      }

      const call = await callService.createCall({
        conversationId: groupId,
        initiatedBy: socket.data.userId,
        callType,
        mode,
        participantIds: group.members ?? [],
      });

      socket.join(groupId);
      socket.join(call._id.toString());

      const payload = {
        callId: call._id,
        groupId,
        callType,
        mode,
        initiatedBy: socket.data.userId,
      };

      socket.emit("call:started", payload);

      // Meet Now: soft Join state for everyone (no ring popup)
      // Audio ring: force incoming popup
      if (mode === "meetNow") {
        notifyConversationMembers(group.members, "call:meeting-active", payload);
      } else {
        notifyConversationMembers(
          group.members,
          "call:incoming",
          payload,
          socket.data.userId
        );
      }

      console.log(`Group call started for ${groupId} by ${socket.data.userId} (${mode})`);
    } catch (error) {
      console.error("Error starting call:", error);
      socket.emit("call:error", {
        message: error instanceof Error ? error.message : "Failed to start call",
      });
    }
  });

  socket.on("call:getActive", async ({ groupId }, callback) => {
    try {
      if (!groupId) {
        return callback?.({ call: null });
      }
      const call = await callService.getActiveCall(groupId);
      if (!call) {
        return callback?.({ call: null });
      }
      callback?.({
        call: {
          callId: call._id,
          groupId: call.conversationId,
          callType: call.callType,
          mode: (call as any).mode || "ring",
          callStatus: call.callStatus,
          initiatedBy: call.initiatedBy,
        },
      });
    } catch (error) {
      callback?.({
        call: null,
        error: error instanceof Error ? error.message : "Failed to get active call",
      });
    }
  });

  socket.on("call:upgrade", async ({ callId, callType = "video" }, callback) => {
    try {
      const call = await callService.upgradeCallType(callId, callType);
      const payload = {
        callId: call._id,
        groupId: call.conversationId,
        callType: call.callType,
      };
      io.to(call._id.toString()).emit("call:media-updated", payload);
      callback?.({ success: true, ...payload });
    } catch (error) {
      callback?.({
        error: error instanceof Error ? error.message : "Failed to upgrade call",
      });
    }
  });

  socket.on("call:accept", async ({ callId }, callback) => {
    try {
      const call = await callService.acceptCall(
        callId,
        socket.data.userId
      );

      socket.join(call.conversationId.toString());
      socket.join(call._id.toString());

      io.to(call._id.toString()).emit(
        "call:participant-joined",
        {
          callId: call._id,
          userId: socket.data.userId,
        }
      );
      callback?.({ success: true, callId: call._id });
    } catch (error) {
      console.error("Error accepting call:", error);

      const message = error instanceof Error
        ? error.message
        : "Failed to accept call";
      socket.emit("call:error", { message });
      callback?.({ error: message });
    }
  });

  socket.on("call:reject", async ({ callId }) => {
    try {
      const call = await callService.rejectCall(
        callId,
        socket.data.userId
      );

      io.to(call._id.toString()).emit(
        "call:participant-rejected",
        {
          callId: call._id,
          userId: socket.data.userId,
        }
      );
    } catch (error) {
      console.error("Error rejecting call:", error);

      socket.emit("call:error", {
        message: error instanceof Error
          ? error.message
          : "Failed to reject call",
      });
    }
  });

  socket.on("call:leave", async ({ callId }) => {
    try {
      // Leave media first so remaining-peer count is accurate
      mediasoupService.leaveCall(socket.id);
      releaseScreenShare(callId.toString(), socket.data.userId);

      const call = await callService.leaveCall(
        callId,
        socket.data.userId
      );

      io.to(call._id.toString()).emit(
        "call:participant-left",
        {
          callId: call._id,
          userId: socket.data.userId,
        }
      );

      const remainingMedia = mediasoupService
        .getPeersByCallId(call._id.toString())
        .filter((p) => p.userId !== socket.data.userId);
      const remainingJoined = callService.countJoined(call);

      // Meet stays up until the LAST member leaves (DB + live media)
      const shouldEnd = remainingJoined === 0 && remainingMedia.length === 0;

      if (shouldEnd) {
        await callService.endCall(call._id);
        releaseScreenShare(call._id.toString(), undefined, true);
        const endedPayload = {
          callId: call._id.toString(),
          groupId: call.conversationId.toString(),
        };
        io.to(call._id.toString()).emit("call:ended", endedPayload);
        const group = await Conversation.findById(call.conversationId);
        notifyConversationMembers(group?.members, "call:ended", endedPayload);
      }
    } catch (error) {
      console.error("Error leaving call:", error);

      socket.emit("call:error", {
        message: error instanceof Error
          ? error.message
          : "Failed to leave call",
      });
    }
  });

  socket.on("call:end", async ({ callId }) => {
    try {
      const call = await callService.endCall(callId);

      releaseScreenShare(call._id.toString());
      mediasoupService.leaveCall(socket.id);

      const endedPayload = {
        callId: call._id,
        groupId: call.conversationId,
        endedBy: socket.data.userId,
      };
      io.to(call._id.toString()).emit("call:ended", endedPayload);
      const group = await Conversation.findById(call.conversationId);
      notifyConversationMembers(group?.members, "call:ended", endedPayload);
    } catch (error) {
      console.error("Error ending call:", error);

      socket.emit("call:error", {
        message:
          error instanceof Error
            ? error.message
            : "Failed to end call",
      });
    }
  });

  socket.on("screen:join", ({ callId }) => {
    if (callId) {
      socket.join(callId.toString());
    }
  });

  socket.on("screen:start", ({ callId }, callback) => {
    try {
      if (!callId) {
        return callback?.({ error: "callId is required" });
      }

      const key = callId.toString();
      const existing = screenShareByCall.get(key);

      if (existing && existing.userId !== socket.data.userId) {
        return callback?.({
          error: "Someone else is already sharing their screen",
          sharerUserId: existing.userId,
        });
      }

      screenShareByCall.set(key, {
        userId: socket.data.userId,
        socketId: socket.id,
      });

      socket.join(key);

      io.to(key).emit("screen:started", {
        callId: key,
        userId: socket.data.userId,
      });

      callback?.({ success: true });
    } catch (error) {
      callback?.({
        error: error instanceof Error ? error.message : "Failed to start screen share",
      });
    }
  });

  socket.on("screen:stop", ({ callId }, callback) => {
    try {
      if (!callId) {
        return callback?.({ error: "callId is required" });
      }
      releaseScreenShare(callId.toString(), socket.data.userId);
      callback?.({ success: true });
    } catch (error) {
      callback?.({
        error: error instanceof Error ? error.message : "Failed to stop screen share",
      });
    }
  });

  socket.on("screen:getState", ({ callId }, callback) => {
    const current = callId ? screenShareByCall.get(callId.toString()) : undefined;
    callback?.({
      sharerUserId: current?.userId || null,
    });
  });

  socket.on(
    'mediasoup:createSendTransport',
    async (_, callback) => {
      try {
        let peer = mediasoupService.getPeer(socket.id);
        if (!peer) {
          peer = mediasoupService.createPeer(socket.data.userId, socket.id);
        }

        // Never tear down a transport that still has live producers (kills remote A/V)
        if (peer.sendTransport && !peer.sendTransport.closed && peer.producers.size > 0) {
          return callback({
            id: peer.sendTransport.id,
            iceParameters: peer.sendTransport.iceParameters,
            iceCandidates: rewriteIceCandidates(peer.sendTransport.iceCandidates),
            dtlsParameters: peer.sendTransport.dtlsParameters,
            reused: true,
          });
        }

        if (peer.sendTransport && !peer.sendTransport.closed) {
          try { peer.sendTransport.close(); } catch { /* ignore */ }
        }

        const transport =
          await mediasoupService.createWebRtcTransport(socket.data.userId, 'send');

        peer.sendTransport = transport;

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: rewriteIceCandidates(transport.iceCandidates),
          dtlsParameters: transport.dtlsParameters,
        });

      } catch (error) {
        console.error(
          'Failed to create send transport:',
          error
        );

        callback({
          error: 'Failed to create send transport',
        });
      }
    }
  );

  socket.on(
    'mediasoup:createRecvTransport',
    async (_, callback) => {
      try {
        let peer = mediasoupService.getPeer(socket.id);
        if (!peer) {
          peer = mediasoupService.createPeer(socket.data.userId, socket.id);
        }

        if (peer.recvTransport && !peer.recvTransport.closed) {
          return callback({
            id: peer.recvTransport.id,
            iceParameters: peer.recvTransport.iceParameters,
            iceCandidates: rewriteIceCandidates(peer.recvTransport.iceCandidates),
            dtlsParameters: peer.recvTransport.dtlsParameters,
            reused: true,
          });
        }

        const transport =
          await mediasoupService.createWebRtcTransport(socket.data.userId, 'recv');

        peer.recvTransport = transport;

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: rewriteIceCandidates(transport.iceCandidates),
          dtlsParameters: transport.dtlsParameters,
        });

      } catch (error) {
        console.error(
          'Failed to create receive transport:',
          error
        );

        callback({
          error: 'Failed to create receive transport',
        });
      }
    }
  );

  socket.on(
    'mediasoup:connectTransport',
    async (
      {
        transportId,
        dtlsParameters,
      },
      callback
    ) => {
      try {
        const peer = mediasoupService.getPeer(socket.id);

        if (!peer) {
          return callback({
            error: 'Peer not found',
          });
        }

        let transport:
          | mediasoup.types.WebRtcTransport
          | undefined;

        if (peer.sendTransport?.id === transportId) {
          transport = peer.sendTransport;
        }

        if (peer.recvTransport?.id === transportId) {
          transport = peer.recvTransport;
        }

        if (!transport) {
          return callback({
            error: 'Transport not found',
          });
        }

        // Idempotent — reconnect / reused transport may already be connected
        if (transport.dtlsState === 'connected' || transport.dtlsState === 'connecting') {
          return callback({
            connected: true,
          });
        }

        await transport.connect({
          dtlsParameters,
        });

        callback({
          connected: true,
        });

      } catch (error) {
        console.error(
          'Failed to connect transport:',
          error
        );

        callback({
          error: 'Failed to connect transport',
        });
      }
    }
  );

  socket.on('mediasoup:getRouterRtpCapabilities', (_, callback) => {
    try {
      const router = mediasoupService.getRouter();

      callback({
        rtpCapabilities: router.rtpCapabilities,
      });
    } catch (error) {
      console.error(
        'Failed to get router RTP capabilities:',
        error
      );

      callback({
        error: 'Failed to get router RTP capabilities',
      });
    }
  });

  socket.on(
    'mediasoup:produce',
    async (
      {
        transportId,
        kind,
        rtpParameters,
        appData
      },
      callback
    ) => {

      try {
        const peer =
          mediasoupService.getPeer(socket.id);

        if (!peer) {
          return callback({
            error: 'Peer not found'
          });
        }

        if (!peer.sendTransport) {
          return callback({
            error: 'Send transport not found'
          });
        }

        if (peer.sendTransport.id !== transportId) {
          return callback({
            error: 'Invalid transport'
          });
        }

        if (!peer.callId) {
          return callback({
            error: 'Peer is not associated with a call'
          });
        }

        // Create producer
        const producer =
          await peer.sendTransport.produce({
            kind,
            rtpParameters,
            appData
          });

        // Store producer
        peer.producers.set(
          producer.id,
          producer
        );

        console.log(
          `Producer created: ${producer.id} (${kind})`
        );

        if (producer.kind === 'audio') {
          const producerStatsInterval = setInterval(async () => {
            try {
              if (producer.closed) {
                clearInterval(producerStatsInterval);
                return;
              }

              const stats = await producer.getStats();
              const s = stats[0];

              console.log('🎤 PRODUCER', {
                id: producer.id,
                user: userId,

                packets: s?.packetCount ?? 0,
                lost: s?.packetsLost ?? 0,
                jitter_ms: s?.jitter ?? 0,

                bitrateKbps: s?.bitrate
                  ? Math.round(s.bitrate / 1000)
                  : 0,

                rtt_ms: s?.roundTripTime
                  ? Math.round(s.roundTripTime * 1000)
                  : 0,

                score: s?.score,
              });
            } catch {
              // ignore debug errors
            }
          }, 2000);

          producer.on('transportclose', () => {
            clearInterval(producerStatsInterval);
          });

          producer.on('@close', () => {
            clearInterval(producerStatsInterval);
          });
        }

        const payload = {
          producerId: producer.id,
          userId: peer.userId,
          kind: producer.kind,
          source: appData?.source || 'camera',
        };

        const callKey = String(peer.callId);
        // Room + direct fan-out (room alone misses peers who haven't joined the socket room yet)
        socket.to(callKey).emit('mediasoup:newProducer', payload);
        mediasoupService.getPeersByCallId(callKey).forEach((other) => {
          if (other.userId === peer.userId) {
            return;
          }
          io.to(other.socketId).emit('mediasoup:newProducer', payload);
        });
        console.log(
          `Producer notified call=${callKey} peers=${mediasoupService.getPeersByCallId(callKey).length}`
        );

        producer.on('transportclose', () => {

          console.log(
            `Producer transport closed: ${producer.id}`
          );

          producer.close();

          peer.producers.delete(
            producer.id
          );

          io.to(peer.callId!.toString()).emit('mediasoup:producerClosed', {
            producerId: producer.id,
            userId: peer.userId,
            source: appData?.source || 'camera',
          });
        });

        callback({
          id: producer.id
        });

      } catch (error) {

        console.error(
          'Failed to create producer:',
          error
        );

        callback({
          error: 'Failed to create producer'
        });
      }
    }
  );

  socket.on(
    'mediasoup:consume',
    async (
      {
        producerId,
        rtpCapabilities
      },
      callback
    ) => {
      try {
        const peer =
          mediasoupService.getPeer(socket.id);

        if (!peer) {
          return callback({
            error: 'Peer not found'
          });
        }

        if (!peer.recvTransport) {
          return callback({
            error: 'Receive transport not found'
          });
        }

        const router =
          mediasoupService.getRouter();

        // Check whether router can consume this producer
        if (
          !router.canConsume({
            producerId,
            rtpCapabilities
          })
        ) {
          return callback({
            error: 'Cannot consume this producer'
          });
        }

        let producerSource = 'camera';
        let producerUserId = '';
        for (const p of mediasoupService.getPeersByCallId(peer.callId || '')) {
          const prod = p.producers.get(producerId);
          if (prod) {
            producerSource = (prod.appData as any)?.source || 'camera';
            producerUserId = p.userId;
            break;
          }
        }

        const consumer =
          await peer.recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
            appData: {
              source: producerSource,
              userId: producerUserId,
            },
          });

        if (consumer.kind === 'audio') {
          console.log('🔊 CONSUMER CREATED', {
            consumerId: consumer.id,
            producerId: consumer.producerId,
            userId,
          });

          const consumerStatsInterval = setInterval(async () => {
            try {
              if (consumer.closed) {
                clearInterval(consumerStatsInterval);
                return;
              }

              const stats = await consumer.getStats();

              const inbound = stats.find(
                (s: any) => s.type === 'inbound-rtp',
              );

              if (!inbound) {
                return;
              }

              console.log('🔊 CONSUMER', {
                id: consumer.id,
                producerId: consumer.producerId,

                packets: inbound.packetCount ?? 0,
                lost: inbound.packetsLost ?? 0,
                jitter_ms: inbound.jitter ?? 0,

                bitrateKbps: inbound.bitrate
                  ? Math.round(inbound.bitrate / 1000)
                  : 0,

                score: inbound.score,
              });
            } catch {
              // ignore debug errors
            }
          }, 2000);

          consumer.on('transportclose', () => {
            clearInterval(consumerStatsInterval);
          });

          consumer.on('producerclose', () => {
            clearInterval(consumerStatsInterval);
          }); 

          consumer.on('@close', () => {
            clearInterval(consumerStatsInterval);
          });
        }

        peer.consumers.set(
          consumer.id,
          consumer
        );

        consumer.on('transportclose', () => {
          console.log(
            `Consumer transport closed: ${consumer.id}`
          );

          peer.consumers.delete(
            consumer.id
          );
        });

        consumer.on('producerclose', () => {
          console.log(
            `Producer closed for consumer: ${consumer.id}`
          );

          const source = (consumer as any).appData?.source || 'camera';

          consumer.close();

          peer.consumers.delete(
            consumer.id
          );

          io.to(socket.id).emit(
            'mediasoup:producerClosed',
            {
              consumerId: consumer.id,
              producerId,
              userId: (consumer as any).appData?.userId,
              source,
            }
          );
        });

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          source: producerSource,
        });

      } catch (error) {
        console.error(
          'Failed to create consumer:',
          error
        );

        callback({
          error: 'Failed to create consumer'
        });
      }
    }
  );

  socket.on(
    'mediasoup:resumeConsumer',
    async (
      {
        consumerId
      },
      callback
    ) => {
      try {
        const peer =
          mediasoupService.getPeer(socket.id);

        if (!peer) {
          return callback({
            error: 'Peer not found'
          });
        }

        const consumer =
          peer.consumers.get(consumerId);

        if (!consumer) {
          return callback({
            error: 'Consumer not found'
          });
        }

        await consumer.resume();

        // Force a keyframe so remote tiles show immediately (avoids stuck black frames)
        if (consumer.kind === 'video') {
          const pump = async () => {
            try {
              await consumer.requestKeyFrame();
            } catch {
              // ignore
            }
          };
          await pump();
          // Extra keyframes help late joiners / multi-party tiles unstick
          setTimeout(() => void pump(), 400);
          setTimeout(() => void pump(), 1200);
          setTimeout(() => void pump(), 2500);
        }

        callback({
          success: true
        });

      } catch (error) {
        console.error(
          'Failed to resume consumer:',
          error
        );

        callback({
          error: 'Failed to resume consumer'
        });
      }
    }
  );

  socket.on(
    'mediasoup:joinCall',
    async ({ callId, callType }, callback) => {
      try {
        if (!callId) {
          return callback({
            error: 'callId is required'
          });
        }

        if (
          callType !== 'audio' &&
          callType !== 'video'
        ) {
          return callback({
            error: 'Invalid callType'
          });
        }

        let peer = mediasoupService.getPeer(socket.id);
        if (!peer) {
          peer = mediasoupService.createPeer(socket.data.userId, socket.id);
        }

        mediasoupService.joinCall(
          socket.id,
          callId,
          callType
        );

        socket.join(callId.toString());

        const existingPeers =
          mediasoupService.getPeersByCallId(callId);

        const producers: {
          producerId: string;
          userId: string;
          kind: 'audio' | 'video';
          source?: string;
        }[] = [];

        existingPeers.forEach((existingPeer) => {
          if (existingPeer.userId === peer!.userId) {
            return;
          }

          existingPeer.producers.forEach((producer) => {
            producers.push({
              producerId: producer.id,
              userId: existingPeer.userId,
              kind: producer.kind,
              source: (producer.appData as any)?.source || 'camera',
            });
          });
        });

        callback({
          success: true,
          producers
        });

      } catch (error) {
        console.error(
          'Failed to join mediasoup call:',
          error
        );

        callback({
          error: 'Failed to join call'
        });
      }
    });

  socket.on('mediasoup:syncProducers', ({ callId }, callback) => {
    try {
      if (!callId) {
        return callback?.({ producers: [] });
      }
      const peer = mediasoupService.getPeer(socket.id);
      const producers: {
        producerId: string;
        userId: string;
        kind: 'audio' | 'video';
        source?: string;
      }[] = [];

      mediasoupService.getPeersByCallId(callId.toString()).forEach((existingPeer) => {
        if (peer && existingPeer.userId === peer.userId) {
          return;
        }
        existingPeer.producers.forEach((producer) => {
          producers.push({
            producerId: producer.id,
            userId: existingPeer.userId,
            kind: producer.kind as 'audio' | 'video',
            source: (producer.appData as any)?.source || 'camera',
          });
        });
      });

      callback?.({ producers });
    } catch (error) {
      callback?.({
        producers: [],
        error: error instanceof Error ? error.message : 'sync failed',
      });
    }
  });

  socket.on('groupCallOffer', ({ groupId, toUserId, offer }) => {
    const toSocketId = userSockets.get(toUserId);
    if (toSocketId) {
      io.to(toSocketId).emit('groupCallOffer', { groupId, fromUserId: socket.data.userId, offer });
    }
  });

  socket.on('groupCallAnswer', ({ groupId, toUserId, answer }) => {
    const toSocketId = userSockets.get(toUserId);
    if (toSocketId) {
      io.to(toSocketId).emit('groupCallAnswer', { groupId, fromUserId: socket.data.userId, answer });
    }
  });

  socket.on('groupCallIceCandidate', ({ groupId, toUserId, candidate }) => {
    const toSocketId = userSockets.get(toUserId);
    if (toSocketId) {
      io.to(toSocketId).emit('groupCallIceCandidate', { groupId, fromUserId: socket.data.userId, candidate });
    }
  });

});

app.use('/uploads', express.static(path.join(__dirname, '/uploads')));

connectDB().then(async () => {
  await mediasoupService.init();
  server.listen(Number(port), "0.0.0.0", () => {
    console.log(`Server is running on port ${port}`);
  });
}).catch((error) => {
  console.log("Error starting server:", error.message);
});

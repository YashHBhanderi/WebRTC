import { Schema, model, Types } from "mongoose";

const participantSchema = new Schema(
  {
    userId: {
      type: Types.ObjectId,
      ref: "users",
      required: true,
    },

    status: {
      type: String,
      // removed = taken out by the host; blocks rejoining this call
      enum: ["invited", "ringing", "joined", "rejected", "left", "removed"],
      default: "invited",
    },

    joinedAt: Date,
    leftAt: Date,
    // Let in from the lobby by a host / co-host (lobby meetings only)
    admittedAt: Date,
  },
  { _id: false }
);

const callSchema = new Schema(
  {
    conversationId: {
      type: Types.ObjectId,
      ref: "conversations",
      required: true,
    },

    initiatedBy: {
      type: Types.ObjectId,
      ref: "users",
      required: true,
    },

    callType: {
      type: String,
      enum: ["audio", "video"],
      required: true,
    },

    // ring = force incoming popup; meetNow = soft Join in chat header
    mode: {
      type: String,
      enum: ["ring", "meetNow"],
      default: "ring",
    },

    callStatus: {
      type: String,
      enum: ["ringing", "active", "ended", "missed", "cancelled"],
      default: "ringing",
    },

    participants: [participantSchema],

    // Group meeting controls (hosts = organiser + group admins; co-hosts promoted by a host)
    settings: {
      lobby: { type: Boolean, default: false },
      allowUnmute: { type: Boolean, default: true },
      allowShare: { type: Boolean, default: true },
      cohosts: [{ type: Types.ObjectId, ref: "users" }],
    },

    startedAt: Date,
    endedAt: Date,

    // Why it ended (call history): completed | no-answer (ring timed out) | declined (everyone
    // declined) | cancelled (caller hung up while ringing) | failed
    endReason: {
      type: String,
      enum: ["completed", "no-answer", "declined", "cancelled", "failed"],
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

// getActiveCall: newest ringing/active call of a conversation
callSchema.index({ conversationId: 1, callStatus: 1, createdAt: -1 });
// Call history: my calls, newest first
callSchema.index({ "participants.userId": 1, createdAt: -1 });

export default model("calls", callSchema);
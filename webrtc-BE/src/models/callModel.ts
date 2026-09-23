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
      enum: ["invited", "ringing", "joined", "rejected", "left"],
      default: "invited",
    },

    joinedAt: Date,
    leftAt: Date,
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

    startedAt: Date,
    endedAt: Date,
  },
  {
    timestamps: true,
  }
);

export default model("calls", callSchema);
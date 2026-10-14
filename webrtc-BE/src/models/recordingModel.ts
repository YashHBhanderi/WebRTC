import mongoose, { Schema, Document } from "mongoose";

export type RecordingStatus = "recording" | "processing" | "completed" | "failed";
export type TranscriptStatus = "none" | "pending" | "processing" | "completed" | "failed";

export interface ITranscriptSegment {
    speakerId: mongoose.Types.ObjectId | null;
    speaker: string;
    /** Seconds from the start of the recording */
    startTime: number;
    endTime: number;
    text: string;
}

/** One captured stream (kept for processing; temp files are deleted afterwards). */
export interface IRecordingTrack {
    userId: mongoose.Types.ObjectId;
    kind: "audio" | "video";
    source: "camera" | "screen";
    /** Seconds from recording start of the stream's first packet / its end */
    startOffset: number;
    endOffset?: number | null;
    file: string;
}

/** What happened in the meeting while recording (drives the composed layout). */
export interface ITimelineEvent {
    /** Seconds from recording start */
    at: number;
    userId: mongoose.Types.ObjectId;
    type: "join" | "leave" | "media";
    audio?: boolean | null;
    video?: boolean | null;
}

/** When a participant was speaking (seconds from recording start). */
export interface ISpeechInterval {
    userId: mongoose.Types.ObjectId;
    start: number;
    end: number;
}

export interface IRecording extends Document {
    callId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    meetingId?: mongoose.Types.ObjectId | null;
    title: string;
    startedBy: mongoose.Types.ObjectId;
    stoppedBy?: mongoose.Types.ObjectId | null;
    startedAt: Date;
    endedAt?: Date | null;
    /** Seconds */
    duration: number;
    size: number;
    storageKey?: string | null;
    status: RecordingStatus;
    /** Safe, user-facing reason when failed (details are in the server log) */
    error?: string | null;
    tracks: IRecordingTrack[];
    timeline: ITimelineEvent[];
    speech: ISpeechInterval[];
    transcriptStatus: TranscriptStatus;
    transcriptError?: string | null;
    transcriptAttempts: number;
    transcript: ITranscriptSegment[];
    createdAt: Date;
    updatedAt: Date;
}

const SegmentSchema = new Schema<ITranscriptSegment>({
    speakerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    speaker: { type: String, default: "" },
    startTime: { type: Number, required: true },
    endTime: { type: Number, required: true },
    text: { type: String, required: true },
}, { _id: false });

const TrackSchema = new Schema<IRecordingTrack>({
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["audio", "video"], required: true },
    source: { type: String, enum: ["camera", "screen"], default: "camera" },
    startOffset: { type: Number, required: true },
    endOffset: { type: Number, default: null },
    file: { type: String, required: true },
}, { _id: false });

const TimelineSchema = new Schema<ITimelineEvent>({
    at: { type: Number, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["join", "leave", "media"], required: true },
    audio: { type: Boolean, default: null },
    video: { type: Boolean, default: null },
}, { _id: false });

const SpeechSchema = new Schema<ISpeechInterval>({
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    start: { type: Number, required: true },
    end: { type: Number, required: true },
}, { _id: false });

const RecordingSchema = new Schema<IRecording>({
    callId: { type: Schema.Types.ObjectId, ref: "calls", required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    meetingId: { type: Schema.Types.ObjectId, ref: "Meeting", default: null },
    title: { type: String, default: "Recording" },
    startedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    stoppedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    duration: { type: Number, default: 0 },
    size: { type: Number, default: 0 },
    storageKey: { type: String, default: null },
    status: { type: String, enum: ["recording", "processing", "completed", "failed"], default: "recording" },
    error: { type: String, default: null },
    tracks: { type: [TrackSchema], default: [] },
    timeline: { type: [TimelineSchema], default: [] },
    speech: { type: [SpeechSchema], default: [] },
    transcriptStatus: { type: String, enum: ["none", "pending", "processing", "completed", "failed"], default: "none" },
    transcriptError: { type: String, default: null },
    transcriptAttempts: { type: Number, default: 0 },
    transcript: { type: [SegmentSchema], default: [] },
}, { timestamps: true });

// A chat's / meeting's recordings, newest first; one live recording per call
RecordingSchema.index({ conversationId: 1, startedAt: -1 });
RecordingSchema.index({ callId: 1, status: 1 });

RecordingSchema.set("toJSON", {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
        // Server-local paths, storage keys, user ids of the timeline never leave the server
        delete ret.tracks;
        delete ret.storageKey;
        delete ret.timeline;
        delete ret.speech;
        delete ret.transcriptAttempts;
        return ret;
    },
});

const Recording = mongoose.model<IRecording>("Recording", RecordingSchema);
export default Recording;

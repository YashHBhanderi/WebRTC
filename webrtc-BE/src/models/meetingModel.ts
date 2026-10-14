import mongoose, { Schema, Document } from "mongoose";

export type RecurrenceFreq = "daily" | "weekdays" | "weekly" | "monthly";

/** Repeat rule. Occurrences are computed from it (never stored one by one). */
export interface IRecurrence {
    freq: RecurrenceFreq;
    /** Every N days / weeks / months */
    interval: number;
    /** weekly: 0 = Sunday … 6 = Saturday */
    byWeekday?: number[];
    /** Last day an occurrence may start (inclusive), or… */
    until?: Date | null;
    /** …a maximum number of occurrences */
    count?: number | null;
}

export interface IMeeting extends Document {
    title: string;
    description: string;
    organizerId: mongoose.Types.ObjectId;
    invitees: mongoose.Types.ObjectId[];
    /** The meeting's own chat (also where its calls happen) */
    conversationId: mongoose.Types.ObjectId;
    startAt: Date;
    endAt: Date;
    /** IANA time zone the organiser scheduled in (recurrences keep local wall-clock time) */
    timeZone: string;
    recurrence?: IRecurrence | null;
    /** Occurrence start times that were cancelled individually */
    cancelledOccurrences: Date[];
    /** Short code used in links (/meet/<code>) and as the meeting ID */
    code: string;
    /** scrypt hash ("salt:hash"); only people who were not invited are asked */
    passwordHash?: string | null;
    /** Start calls with the lobby on */
    lobby: boolean;
    status: "scheduled" | "cancelled";
    createdAt: Date;
    updatedAt: Date;
}

const RecurrenceSchema = new Schema<IRecurrence>({
    freq: { type: String, enum: ["daily", "weekdays", "weekly", "monthly"], required: true },
    interval: { type: Number, default: 1, min: 1, max: 30 },
    byWeekday: { type: [Number], default: undefined },
    until: { type: Date, default: null },
    count: { type: Number, default: null, min: 1, max: 500 },
}, { _id: false });

const MeetingSchema = new Schema<IMeeting>({
    title: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: "", maxlength: 2000 },
    organizerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invitees: [{ type: Schema.Types.ObjectId, ref: "User" }],
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timeZone: { type: String, default: "UTC" },
    recurrence: { type: RecurrenceSchema, default: null },
    cancelledOccurrences: { type: [Date], default: [] },
    code: { type: String, required: true },
    passwordHash: { type: String, default: null },
    lobby: { type: Boolean, default: false },
    status: { type: String, enum: ["scheduled", "cancelled"], default: "scheduled" },
}, { timestamps: true });

MeetingSchema.index({ code: 1 }, { unique: true });
MeetingSchema.index({ conversationId: 1 });
// Calendar: my meetings (organised or invited) by time
MeetingSchema.index({ organizerId: 1, startAt: 1 });
MeetingSchema.index({ invitees: 1, startAt: 1 });

MeetingSchema.set("toJSON", {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
        ret.hasPassword = !!ret.passwordHash;
        delete ret.passwordHash;
        return ret;
    },
});

const Meeting = mongoose.model<IMeeting>("Meeting", MeetingSchema);
export default Meeting;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, isSpreeWeError, backendTokenProvider, type SpreeWeClient, type SpreeWeError } from "@spreewe/core";
import { getMeetings, parseMeetingCode, type Meeting } from "@spreewe/meetings";
import { appClient, clientFor, eventually, grant, makeUser, registerApp, serverExchange, startSocketServer, type Session, type TestApp } from "./support";

/**
 * @spreewe/meetings against the real backend (webrtc-BE meeting.service.ts / meeting.controller.ts):
 * create, list by range (incl. recurrence and ranges longer than the server's 62-day cap), get,
 * update, live `meeting:updated` on an invitee's app socket, preview and join by code (password for
 * people who weren't invited), occurrence-only and whole-series cancel, and scope errors.
 */
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, carol: Session, owner: Session;
let full: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);
const ALL = [...SCOPES];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A start time well in the future, on a whole hour (local time of the test process) */
function futureStart(daysAhead = 2): Date {
    const d = new Date(Date.now() + daysAhead * DAY);
    d.setMinutes(0, 0, 0);
    return d;
}

let a: SpreeWeClient, b: SpreeWeClient, c: SpreeWeClient;

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, carol, owner] = (await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    const quotas = { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } };
    full = await registerApp(owner, ALL, quotas);
    for (const u of [alice, bob, carol]) await grant(u, full, ALL);
    a = track(appClient(base, full, String(alice.user._id)));
    b = track(appClient(base, full, String(bob.user._id)));
    c = track(appClient(base, full, String(carol.user._id)));
});

afterAll(async () => {
    clients.forEach((x) => x.destroy());
    await server?.close();
});

describe("meetings: one-off meeting lifecycle", () => {
    let meeting: Meeting;
    const start = futureStart(2);
    const end = new Date(start.getTime() + HOUR);

    it("creates a meeting with an invitee (the server creates its chat and a join code)", async () => {
        meeting = await getMeetings(a).create({
            title: "SDK planning",
            description: "Agenda in the chat",
            startAt: start,
            endAt: end,
            invitees: [String(bob.user._id)],
            password: "s3cret",
        });
        expect(meeting._id).toMatch(/^[a-f0-9]{24}$/);
        expect(meeting.conversationId).toMatch(/^[a-f0-9]{24}$/);
        expect(parseMeetingCode(meeting.code)).toBe(meeting.code);
        expect(meeting.isOrganizer).toBe(true);
        expect(meeting.hasPassword).toBe(true);
        expect(meeting.status).toBe("scheduled");
        expect(meeting.timeZone).toBeTruthy();
        expect(meeting.invitees.map((p) => p._id)).toEqual([String(bob.user._id)]);
        expect(meeting.organizer._id).toBe(String(alice.user._id));
    });

    it("passes server validation messages through as SpreeWeError", async () => {
        const err = (await getMeetings(a).create({ title: "Backwards", startAt: end, endAt: start }).catch((e) => e)) as SpreeWeError;
        expect(isSpreeWeError(err)).toBe(true);
        expect(err.status).toBe(400);
        expect(err.code).toBe("VALIDATION_ERROR");
        expect(err.message).toBe("The meeting must end after it starts");
        const noTitle = (await getMeetings(a).create({ title: " ", startAt: start, endAt: end }).catch((e) => e)) as SpreeWeError;
        expect(noTitle.message).toBe("Title is required");
    });

    it("lists the occurrence in a range for organiser and invitee", async () => {
        const range = { from: new Date(start.getTime() - DAY), to: new Date(start.getTime() + DAY) };
        const mine = await getMeetings(a).list(range);
        const item = mine.find((o) => o._id === meeting._id);
        expect(item).toBeDefined();
        expect(Date.parse(item!.occurrenceStart)).toBe(start.getTime());
        expect(Date.parse(item!.occurrenceEnd)).toBe(end.getTime());
        const theirs = await getMeetings(b).list(range);
        expect(theirs.find((o) => o._id === meeting._id)?.isOrganizer).toBe(false);
        // Not invited: not listed
        expect((await getMeetings(c).list(range)).some((o) => o._id === meeting._id)).toBe(false);
    });

    it("splits ranges longer than 62 days instead of getting a 400", async () => {
        const from = new Date(start.getTime() - 40 * DAY);
        const items = await getMeetings(a).list({ from, to: new Date(from.getTime() + 120 * DAY) });
        expect(items.filter((o) => o._id === meeting._id)).toHaveLength(1);
        // The raw route refuses it
        const raw = await a.http.get("/meetings", { query: { from: from.toISOString(), to: new Date(from.getTime() + 120 * DAY).toISOString() } }).catch((e) => e);
        expect((raw as SpreeWeError).message).toBe("Choose a range of up to 62 days");
    });

    it("gets one meeting (invitee view) and 404s for people who can't see it", async () => {
        const got = await getMeetings(b).get(meeting._id);
        expect(got.title).toBe("SDK planning");
        expect(got.isOrganizer).toBe(false);
        expect(got.conversationId).toBe(meeting.conversationId);
        const hidden = (await getMeetings(c).get(meeting._id).catch((e) => e)) as SpreeWeError;
        expect(hidden.status).toBe(404);
    });

    it("updates as organiser; the invitee's socket gets meeting:updated and its watched range follows", async () => {
        const mb = getMeetings(b);
        expect(await mb.startLive()).toBe(true);
        const events: string[] = [];
        const off = mb.onUpdated((e) => events.push(e.meetingId));
        const range = mb.watchRange(new Date(start.getTime() - DAY), new Date(start.getTime() + DAY));
        try {
            await eventually(() => expect(range.state.value.items.some((o) => o._id === meeting._id)).toBe(true));
            const updated = await getMeetings(a).update(meeting._id, { title: "SDK planning (moved)", startAt: new Date(start.getTime() + HOUR), endAt: new Date(end.getTime() + HOUR) });
            expect(updated.title).toBe("SDK planning (moved)");
            await eventually(() => expect(events).toContain(meeting._id));
            await eventually(() => {
                const o = range.state.value.items.find((x) => x._id === meeting._id);
                expect(o?.title).toBe("SDK planning (moved)");
                expect(Date.parse(o!.occurrenceStart)).toBe(start.getTime() + HOUR);
            });
        } finally {
            off();
            range.release();
        }
    });

    it("refuses updates from someone who isn't the organiser (permission, not a scope problem)", async () => {
        const err = (await getMeetings(b).update(meeting._id, { title: "Hijacked" }).catch((e) => e)) as SpreeWeError;
        expect(err.status).toBe(403);
        expect(err.code).toBe("PERMISSION_ERROR");
        expect(err.message).toBe("Only the organizer can change this meeting");
    });

    it("previews by code or link: invitees see the ids, others see only what the link shows", async () => {
        const forBob = await getMeetings(b).preview(meeting.code);
        expect(forBob.invited).toBe(true);
        expect(forBob.meetingId).toBe(meeting._id);
        expect(forBob.conversationId).toBe(meeting.conversationId);
        expect(forBob.needsPassword).toBe(false);
        const forCarol = await getMeetings(c).preview(`https://spreewe.example/meet/${meeting.code}`);
        expect(forCarol.invited).toBe(false);
        expect(forCarol.meetingId).toBeNull();
        expect(forCarol.conversationId).toBeNull();
        expect(forCarol.needsPassword).toBe(true);
        expect(forCarol.title).toBe("SDK planning (moved)");
        expect(forCarol.organizerName).toBe(alice.user.username);
        const missing = (await getMeetings(c).preview("zzz-zzzz-zzz").catch((e) => e)) as SpreeWeError;
        expect(missing.status).toBe(404);
    });

    it("joins by code: invitees get the conversationId; others need the password and are added to the chat", async () => {
        const bobJoin = await getMeetings(b).join(meeting.code);
        expect(bobJoin).toEqual({ meetingId: meeting._id, conversationId: meeting.conversationId, lobby: false, code: meeting.code });

        const wrong = (await getMeetings(c).join(meeting.code, { password: "nope" }).catch((e) => e)) as SpreeWeError;
        expect(wrong.status).toBe(403);
        expect(wrong.message).toBe("The meeting password is incorrect");

        const carolJoin = await getMeetings(c).join(meeting.code.toUpperCase(), { password: "s3cret" });
        expect(carolJoin.conversationId).toBe(meeting.conversationId);
        expect(carolJoin.code).toBe(meeting.code);
        // Now a participant: the meeting shows up for her
        expect((await getMeetings(c).preview(meeting.code)).invited).toBe(true);
        expect((await getMeetings(c).get(meeting._id)).invitees.map((p) => p._id)).toContain(String(carol.user._id));
    });

    it("cancels the meeting: it leaves the range, the invitee hears about it, joining answers 410", async () => {
        const mb = getMeetings(b);
        const events: string[] = [];
        const off = mb.onUpdated((e) => events.push(e.meetingId));
        const range = mb.watchRange(new Date(start.getTime() - DAY), new Date(start.getTime() + DAY));
        try {
            await eventually(() => expect(range.state.value.items.some((o) => o._id === meeting._id)).toBe(true));
            await getMeetings(a).cancel(meeting._id);
            await eventually(() => expect(events).toContain(meeting._id));
            await eventually(() => expect(range.state.value.items.some((o) => o._id === meeting._id)).toBe(false));
        } finally {
            off();
            range.release();
        }
        expect((await getMeetings(a).get(meeting._id)).status).toBe("cancelled");
        expect((await getMeetings(b).preview(meeting.code)).cancelled).toBe(true);
        const gone = (await getMeetings(b).join(meeting.code).catch((e) => e)) as SpreeWeError;
        expect(gone.status).toBe(410);
        expect(gone.message).toBe("This meeting was cancelled");
    });
});

describe("meetings: recurrence", () => {
    it("expands a weekly series and cancels a single occurrence", async () => {
        const start = futureStart(3);
        const ma = getMeetings(a);
        const series = await ma.create({
            title: "Weekly sync",
            startAt: start,
            endAt: new Date(start.getTime() + 30 * 60_000),
            invitees: [String(bob.user._id)],
            recurrence: { freq: "weekly", count: 3 },
        });
        expect(series.recurrence?.freq).toBe("weekly");
        expect(series.recurrence?.count).toBe(3);
        expect(series.recurrenceText).toMatch(/^Weekly/);

        const range = { from: new Date(start.getTime() - DAY), to: new Date(start.getTime() + 30 * DAY) };
        const all = (await ma.list(range)).filter((o) => o._id === series._id);
        expect(all).toHaveLength(3);
        expect(new Set(all.map((o) => o.occurrenceStart)).size).toBe(3);

        await ma.cancel(series._id, { occurrence: all[1].occurrenceStart });
        const left = (await ma.list(range)).filter((o) => o._id === series._id).map((o) => o.occurrenceStart);
        expect(left).toEqual([all[0].occurrenceStart, all[2].occurrenceStart]);
        // The series itself is still scheduled
        expect((await ma.get(series._id)).status).toBe("scheduled");

        // Removing the repeat rule turns it into a one-off meeting
        const single = await ma.update(series._id, { recurrence: null });
        expect(single.recurrence).toBeNull();
        expect((await ma.list(range)).filter((o) => o._id === series._id)).toHaveLength(1);
    });

    it("refuses an unknown repeat option with the server's message", async () => {
        const start = futureStart(4);
        const err = (await getMeetings(a)
            .create({ title: "Bad repeat", startAt: start, endAt: new Date(start.getTime() + HOUR), recurrence: { freq: "yearly" as any } })
            .catch((e) => e)) as SpreeWeError;
        expect(err.status).toBe(400);
        expect(err.message).toBe("Invalid repeat option");
    });
});

describe("meetings: scopes", () => {
    it("a token without meetings:write can read but gets 403 naming the scope when writing", async () => {
        const ro = track(
            clientFor(base, backendTokenProvider({ fetchToken: serverExchange(base, full, String(alice.user._id), { scopes: ["profile:read", "meetings:read"] }) })),
        );
        const start = futureStart(5);
        expect(Array.isArray(await getMeetings(ro).list({ from: start, to: new Date(start.getTime() + DAY) }))).toBe(true);
        const err = (await getMeetings(ro).create({ title: "Nope", startAt: start, endAt: new Date(start.getTime() + HOUR) }).catch((e) => e)) as SpreeWeError;
        expect(err.status).toBe(403);
        expect(err.message).toBe("The token lacks the meetings:write scope");
        // Live updates need realtime:connect: reported as "not live", never thrown
        expect(await getMeetings(ro).startLive()).toBe(false);
    });

    it("rejects input that isn't a meeting code before calling the server", async () => {
        const err = (await getMeetings(a).preview("not a code!").catch((e) => e)) as SpreeWeError;
        expect(isSpreeWeError(err, "INVALID_ARGUMENT")).toBe(true);
    });
});

describe("meetings: known backend issues", () => {
    // KNOWN BACKEND ISSUE (webrtc-BE/src/services/meeting.service.ts:172-174): update() only checks that the
    // meeting ends after it starts; the 24-hour cap that create() enforces (lines 121-123, documented for
    // PATCH too in docs/developer/rest-api/session-api.md) is missing. it.fails turns red once fixed.
    it.fails("PATCH refuses meetings longer than 24 hours, like POST does (fails until the backend is fixed)", async () => {
        const start = futureStart(6);
        const m = await getMeetings(a).create({ title: "Short", startAt: start, endAt: new Date(start.getTime() + HOUR) });
        const err = await getMeetings(a)
            .update(m._id, { endAt: new Date(start.getTime() + 25 * HOUR) })
            .then(() => null, (e) => e);
        expect(err?.message).toBe("A meeting can last up to 24 hours");
    });

    // KNOWN BACKEND ISSUE (webrtc-BE/src/services/meeting.service.ts:198-201): after invitees change,
    // `everyone` is computed from the NEW invitee list, so people who were removed never get
    // meeting:updated and their calendars keep showing the meeting until they reload.
    it.fails("a removed invitee receives meeting:updated (fails until the backend is fixed)", async () => {
        const start = futureStart(7);
        const ma = getMeetings(a);
        const mb = getMeetings(b);
        expect(await mb.startLive()).toBe(true);
        const events: string[] = [];
        const off = mb.onUpdated((e) => events.push(e.meetingId));
        try {
            const m = await ma.create({ title: "Shrinking", startAt: start, endAt: new Date(start.getTime() + HOUR), invitees: [String(bob.user._id)] });
            // Bob is told about the new meeting; then he is removed from it
            await eventually(() => expect(events).toContain(m._id));
            events.length = 0;
            await ma.update(m._id, { invitees: [] });
            await eventually(() => expect(events).toContain(m._id), 2500);
        } finally {
            off();
        }
    });
});

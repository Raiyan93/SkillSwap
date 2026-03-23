/**
 * SkillSwap Verification Server — server.js
 *
 * KEY FIXES THIS VERSION:
 * 1. Certificate name check — AI cross-checks recipient name on cert
 *    against profile owner's firstName + lastName sent from frontend.
 *    "Google cert issued to John Smith" submitted by "Raiyan Chougle" = FAIL.
 * 2. Rate limit removed — replaced with soft usage counter only.
 *    No more blocking. Returns usage { count, max } for frontend display.
 * 3. All previous fixes retained.
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const admin   = require('firebase-admin');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
    'http://localhost', 'http://127.0.0.1',
    'http://localhost:3000', 'http://localhost:5500',
    'http://127.0.0.1:5500', 'http://localhost:8080',
    // 'https://yourskillswapsite.com'
];
app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
        cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// ─────────────────────────────────────────────────────────────
// SOFT USAGE COUNTER — never blocks, just tracks & informs
// ─────────────────────────────────────────────────────────────
const usageStore = new Map();
const USAGE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const USAGE_MAX    = 20; // shown in UI as "X of 20 used today"

function trackUsage(ip) {
    const now   = Date.now();
    const entry = usageStore.get(ip);
    if (!entry || now > entry.resetAt) {
        usageStore.set(ip, { count: 1, resetAt: now + USAGE_WINDOW });
        return { count: 1, max: USAGE_MAX, remaining: USAGE_MAX - 1 };
    }
    entry.count++;
    return { count: entry.count, max: USAGE_MAX, remaining: Math.max(0, USAGE_MAX - entry.count) };
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of usageStore) if (now > e.resetAt) usageStore.delete(ip);
}, USAGE_WINDOW);

// ─────────────────────────────────────────────────────────────
// INPUT VALIDATION
// ─────────────────────────────────────────────────────────────
const MAX_SKILLS    = 200;
const MAX_EXPERTISE = 500;
const MAX_URL       = 300;

function sanitize(input, maxLen, field) {
    if (!input) return { value: '', error: null };
    if (typeof input !== 'string') return { value: '', error: `${field} must be a string` };
    if (input.length > maxLen) return { value: '', error: `${field} too long (max ${maxLen})` };
    return {
        value: input
            .replace(/ignore previous instructions/gi, '')
            .replace(/system:/gi, '')
            .replace(/\[INST\]/gi, '')
            .replace(/<\|.*?\|>/g, '')
            .trim(),
        error: null
    };
}

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const OWNERSHIP_CODE = 'SkillSwap2026';
const UNVERIFIED_CAP = 40;
const TIMEOUT_MS     = 35000;

const MODEL_CONFIG = {
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', temperature: 0, topP: 1, topK: 1 }
};

const LEVEL_CONTEXT = {
    beginner:     'BEGINNER — low bar. Basic syntax, 1-2 small projects sufficient.',
    intermediate: 'INTERMEDIATE — medium bar. Real working projects required.',
    expert:       'EXPERT — HIGH bar. Production quality, multiple substantial projects, depth required.'
};

const KNOWN_ISSUERS = [
    'Coursera','edX','Udemy','Google','Microsoft','AWS','Meta','IBM',
    'Stanford','MIT','Harvard','IIT','FreeCodeCamp','LinkedIn Learning',
    'Shaw Academy','Alison','Khan Academy','Codecademy','Pluralsight',
    'DataCamp','HackerRank','MongoDB University','Salesforce','Oracle',
    'Adobe','Autodesk','Cisco','CompTIA','NVIDIA','Infosys','TCS','NPTEL',
    'Simplilearn','Great Learning','upGrad','Scaler','GeeksforGeeks'
];

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const googleCalendarStateStore = new Map();
const GOOGLE_SCOPES = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/calendar.events'
];

function normalizePrivateKey(value) {
    return value ? value.replace(/\\n/g, '\n') : value;
}

function getFirebaseServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const parsed = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
        if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
        return parsed;
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
        return parsed;
    }
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        };
    }
    return null;
}

function ensureFirebaseAdmin() {
    if (admin.apps.length) return admin.app();
    const serviceAccount = getFirebaseServiceAccount();
    if (!serviceAccount) {
        throw new Error('Firebase Admin not configured. Set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_JSON, or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.');
    }
    return admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

function getAdminDb() {
    ensureFirebaseAdmin();
    return admin.firestore();
}

function assertGoogleCalendarConfig() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALENDAR_REDIRECT_URI) {
        throw new Error('Google Calendar OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALENDAR_REDIRECT_URI.');
    }
}

function createGoogleOAuthClient() {
    assertGoogleCalendarConfig();
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_CALENDAR_REDIRECT_URI
    );
}

function cleanupGoogleCalendarStates() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [stateToken, entry] of googleCalendarStateStore.entries()) {
        if (entry.createdAt < cutoff) googleCalendarStateStore.delete(stateToken);
    }
}
setInterval(cleanupGoogleCalendarStates, 5 * 60 * 1000);

async function requireAuth(req, res, next) {
    try {
        ensureFirebaseAdmin();
        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
        if (!idToken) return res.status(401).json({ error: 'Missing Firebase auth token.' });
        req.user = await admin.auth().verifyIdToken(idToken);
        next();
    } catch (err) {
        console.error('[auth]', err.message);
        res.status(401).json({ error: 'Invalid or expired Firebase auth token.' });
    }
}

function buildGoogleConnectionRef(uid) {
    return getAdminDb().collection('googleCalendarConnections').doc(uid);
}

async function getGoogleConnection(uid) {
    const snap = await buildGoogleConnectionRef(uid).get();
    return snap.exists ? snap.data() : null;
}

async function saveGoogleConnection(uid, payload) {
    await buildGoogleConnectionRef(uid).set({
        uid,
        provider: 'google-calendar',
        ...payload,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function createAuthedGoogleClient(uid) {
    const connection = await getGoogleConnection(uid);
    if (!connection || !connection.refreshToken) {
        const err = new Error('Google Calendar is not connected for this user.');
        err.statusCode = 409;
        throw err;
    }
    const oauth2Client = createGoogleOAuthClient();
    oauth2Client.setCredentials({
        access_token: connection.accessToken || undefined,
        refresh_token: connection.refreshToken,
        expiry_date: connection.expiryDate || undefined,
        scope: connection.scope || undefined,
        token_type: connection.tokenType || undefined
    });
    oauth2Client.on('tokens', async (tokens) => {
        try {
            await saveGoogleConnection(uid, {
                accessToken: tokens.access_token || connection.accessToken || null,
                refreshToken: tokens.refresh_token || connection.refreshToken || null,
                expiryDate: tokens.expiry_date || connection.expiryDate || null,
                scope: tokens.scope || connection.scope || null,
                tokenType: tokens.token_type || connection.tokenType || null,
                connected: true
            });
        } catch (persistErr) {
            console.error('[google-calendar tokens]', persistErr.message);
        }
    });
    await oauth2Client.getAccessToken();
    return { oauth2Client, connection };
}

function getMeetJoinUrl(event) {
    if (event?.hangoutLink) return event.hangoutLink;
    const entryPoints = event?.conferenceData?.entryPoints || [];
    const videoEntry = entryPoints.find(entry => entry.entryPointType === 'video' && entry.uri);
    return videoEntry ? videoEntry.uri : null;
}

function toIsoDate(input) {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function buildSessionDescription({ organizerName, partnerName, topic, skillRequested, appUrl }) {
    const lines = [
        'SkillSwap 1-on-1 session',
        `Topic: ${topic || 'Skill practice'}`,
        `Skill: ${skillRequested || 'General guidance'}`,
        `Participants: ${organizerName || 'Organizer'} and ${partnerName || 'Partner'}`
    ];
    if (appUrl) lines.push(`Open SkillSwap: ${appUrl}`);
    return lines.join('\n');
}

async function getAcceptedConnectionOrThrow(requestId, callerUid) {
    const db = getAdminDb();
    const connectionSnap = await db.collection('lessonConnections').doc(requestId).get();
    let data = connectionSnap.exists ? connectionSnap.data() : null;
    let resolvedId = requestId;

    if (!data) {
        const requestSnap = await db.collection('lessonRequests').doc(requestId).get();
        if (requestSnap.exists && requestSnap.data()?.status === 'accepted') {
            data = requestSnap.data();
            resolvedId = requestSnap.id;
        }
    }

    if (!data || data.status !== 'accepted') {
        const err = new Error('This lesson request is not accepted yet.');
        err.statusCode = 404;
        throw err;
    }
    if (![data.teacherUid, data.studentUid].includes(callerUid)) {
        const err = new Error('You are not part of this accepted connection.');
        err.statusCode = 403;
        throw err;
    }
    return { id: resolvedId, ...data };
}

async function getUserProfileOrThrow(uid) {
    const snap = await getAdminDb().collection('users').doc(uid).get();
    if (!snap.exists) {
        const err = new Error('User profile not found.');
        err.statusCode = 404;
        throw err;
    }
    return { uid: snap.id, ...snap.data() };
}

async function createCalendarBackedSession({
    organizerUid,
    acceptedConnection,
    topic,
    durationMinutes,
    startAt,
    partnerName,
    appUrl
}) {
    const db = getAdminDb();
    const teacherProfile = await getUserProfileOrThrow(acceptedConnection.teacherUid);
    const studentProfile = await getUserProfileOrThrow(acceptedConnection.studentUid);
    const organizerProfile = organizerUid === acceptedConnection.teacherUid ? teacherProfile : studentProfile;
    const partnerProfile = organizerUid === acceptedConnection.teacherUid ? studentProfile : teacherProfile;

    const organizerEmail = organizerProfile.email;
    const partnerEmail = partnerProfile.email;
    if (!organizerEmail || !partnerEmail) {
        const err = new Error('Both users need an email on their SkillSwap profile before scheduling.');
        err.statusCode = 400;
        throw err;
    }

    const { oauth2Client, connection } = await createAuthedGoogleClient(organizerUid);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const startDate = new Date(startAt);
    if (Number.isNaN(startDate.getTime())) {
        const err = new Error('Invalid session start date.');
        err.statusCode = 400;
        throw err;
    }
    const minutes = Math.max(15, Number(durationMinutes) || 60);
    const endDate = new Date(startDate.getTime() + minutes * 60 * 1000);
    const organizerName = organizerProfile.fullName || [organizerProfile.firstName, organizerProfile.lastName].filter(Boolean).join(' ') || organizerProfile.firstName || 'Organizer';
    const resolvedPartnerName = partnerName || partnerProfile.fullName || [partnerProfile.firstName, partnerProfile.lastName].filter(Boolean).join(' ') || partnerProfile.firstName || 'Partner';

    const eventResponse = await calendar.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1,
        sendUpdates: 'all',
        requestBody: {
            summary: `SkillSwap: ${topic || acceptedConnection.skillRequested || 'Session'}`,
            description: buildSessionDescription({
                organizerName,
                partnerName: resolvedPartnerName,
                topic,
                skillRequested: acceptedConnection.skillRequested,
                appUrl
            }),
            start: { dateTime: startDate.toISOString() },
            end: { dateTime: endDate.toISOString() },
            attendees: [
                { email: organizerEmail, displayName: organizerName },
                { email: partnerEmail, displayName: resolvedPartnerName }
            ],
            reminders: { useDefault: true },
            conferenceData: {
                createRequest: {
                    requestId: `skillswap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' }
                }
            }
        }
    });

    const event = eventResponse.data;
    const meetUrl = getMeetJoinUrl(event);
    if (!meetUrl) {
        const err = new Error('Google Calendar did not return a Meet link.');
        err.statusCode = 502;
        throw err;
    }

    const sessionPayload = {
        participants: [acceptedConnection.teacherUid, acceptedConnection.studentUid],
        teacherUid: acceptedConnection.teacherUid,
        studentUid: acceptedConnection.studentUid,
        requestId: acceptedConnection.requestId || acceptedConnection.id,
        topic: topic || acceptedConnection.skillRequested || 'Skill practice',
        title: `Session with ${resolvedPartnerName}`,
        partnerName: resolvedPartnerName,
        startAt: admin.firestore.Timestamp.fromDate(startDate),
        durationMinutes: minutes,
        status: 'upcoming',
        meetUrl,
        calendarEventId: event.id,
        calendarUrl: event.htmlLink || null,
        conferenceProvider: 'google-meet',
        scheduledByUid: organizerUid,
        organizerEmail,
        partnerEmail,
        skillRequested: acceptedConnection.skillRequested || 'General guidance',
        skillKey: (acceptedConnection.skillRequested || 'general_guidance').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'general_guidance',
        creditsAgreed: acceptedConnection.creditsOffered || 0,
        googleCalendarConnectionUid: organizerUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const sessionRef = await db.collection('sessions').add(sessionPayload);
    await Promise.all([
        db.collection('notifications').add({
            uid: acceptedConnection.teacherUid,
            type: 'session',
            title: 'Session Scheduled',
            message: `${organizerName} scheduled "${topic || acceptedConnection.skillRequested || 'your session'}" for ${startDate.toLocaleString()}.`,
            read: false,
            sessionId: sessionRef.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        db.collection('notifications').add({
            uid: acceptedConnection.studentUid,
            type: 'session',
            title: 'Session Scheduled',
            message: `${organizerName} scheduled "${topic || acceptedConnection.skillRequested || 'your session'}" for ${startDate.toLocaleString()}.`,
            read: false,
            sessionId: sessionRef.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
    ]);

    await saveGoogleConnection(organizerUid, {
        connected: true,
        email: connection.email || organizerEmail,
        displayName: connection.displayName || organizerName,
        lastScheduledAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
        sessionId: sessionRef.id,
        meetUrl,
        calendarUrl: event.htmlLink || null,
        calendarEventId: event.id,
        startAt: startDate.toISOString(),
        durationMinutes: minutes
    };
}

async function updateCalendarBackedSession(sessionId, callerUid, changes) {
    const db = getAdminDb();
    const sessionRef = db.collection('sessions').doc(sessionId);
    const snap = await sessionRef.get();
    if (!snap.exists) {
        const err = new Error('Session not found.');
        err.statusCode = 404;
        throw err;
    }
    const session = snap.data();
    if (!(session.participants || []).includes(callerUid)) {
        const err = new Error('You are not part of this session.');
        err.statusCode = 403;
        throw err;
    }
    const organizerUid = session.googleCalendarConnectionUid || session.scheduledByUid;
    if (!organizerUid) {
        const err = new Error('This session is not linked to Google Calendar.');
        err.statusCode = 409;
        throw err;
    }

    const { oauth2Client } = await createAuthedGoogleClient(organizerUid);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const patch = {
        summary: changes.topic ? `SkillSwap: ${changes.topic}` : undefined,
        description: changes.description,
        start: changes.startAt ? { dateTime: toIsoDate(changes.startAt) } : undefined,
        end: changes.endAt ? { dateTime: toIsoDate(changes.endAt) } : undefined,
        status: changes.status || undefined
    };
    Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);

    const eventResponse = await calendar.events.patch({
        calendarId: 'primary',
        eventId: session.calendarEventId,
        sendUpdates: 'all',
        conferenceDataVersion: 1,
        requestBody: patch
    });
    const event = eventResponse.data;
    const meetUrl = getMeetJoinUrl(event) || session.meetUrl || null;

    await sessionRef.set({
        topic: changes.topic || session.topic,
        startAt: changes.startAt ? admin.firestore.Timestamp.fromDate(new Date(changes.startAt)) : session.startAt,
        durationMinutes: changes.durationMinutes || session.durationMinutes,
        meetUrl,
        calendarUrl: event.htmlLink || session.calendarUrl || null,
        status: changes.status || session.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        cancelledAt: changes.status === 'cancelled' ? admin.firestore.FieldValue.serverTimestamp() : session.cancelledAt || null,
        cancelledBy: changes.status === 'cancelled' ? callerUid : session.cancelledBy || null
    }, { merge: true });

    return {
        sessionId,
        meetUrl,
        calendarUrl: event.htmlLink || session.calendarUrl || null,
        status: changes.status || session.status
    };
}

async function getSessionForParticipantOrThrow(sessionId, callerUid) {
    const db = getAdminDb();
    const sessionRef = db.collection('sessions').doc(sessionId);
    const snap = await sessionRef.get();
    if (!snap.exists) {
        const err = new Error('Session not found.');
        err.statusCode = 404;
        throw err;
    }
    const session = snap.data();
    if (!(session.participants || []).includes(callerUid)) {
        const err = new Error('You are not part of this session.');
        err.statusCode = 403;
        throw err;
    }
    return { db, sessionRef, session };
}

async function createTransactionRecord(db, payload) {
    await db.collection('transactions').add({
        ...payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function completeSkillSwapSession(sessionId, callerUid, rating, feedback, reportIssue, issueReason) {
    const { db, sessionRef, session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    const baseCredits = session.creditsAgreed || Math.round(((session.durationMinutes || 60) / 60) * 20);
    const isTeacher = session.teacherUid === callerUid;
    const learnerUid = session.studentUid;
    const teacherUid = session.teacherUid;
    const partnerUid = isTeacher ? learnerUid : teacherUid;

    if (session.ratings && session.ratings[callerUid]) {
        const err = new Error('You already submitted feedback for this session.');
        err.statusCode = 409;
        throw err;
    }

    const callerProfile = await getUserProfileOrThrow(callerUid);
    const partnerProfile = await getUserProfileOrThrow(partnerUid);
    const teacherProfile = await getUserProfileOrThrow(teacherUid);
    const learnerProfile = await getUserProfileOrThrow(learnerUid);
    const batch = db.batch();

    const sessionUpdate = {
        status: reportIssue ? 'disputed' : 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedBy: callerUid,
        [`ratings.${callerUid}`]: {
            rating,
            feedback: feedback || '',
            ratedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (reportIssue) {
        sessionUpdate.disputeReason = issueReason || 'Issue reported';
    }
    if (rating <= 2) sessionUpdate.lowRatingFlag = true;

    if (!reportIssue && !session.creditsTransferred) {
        const learnerBalance = Math.max(0, learnerProfile.creditBalance || 0);
        if (learnerBalance < baseCredits) {
            const err = new Error('The learner does not have enough credits to complete this session.');
            err.statusCode = 400;
            throw err;
        }
        sessionUpdate.creditsTransferred = true;
        batch.update(db.collection('users').doc(learnerUid), {
            creditBalance: learnerBalance - baseCredits
        });
        batch.update(db.collection('users').doc(teacherUid), {
            creditBalance: (teacherProfile.creditBalance || 0) + baseCredits
        });
        await Promise.all([
            createTransactionRecord(db, {
                uid: learnerUid,
                type: 'spend',
                amount: baseCredits,
                description: `Learned ${session.topic || 'a session'} from ${teacherProfile.fullName || teacherProfile.firstName || 'teacher'}`,
                category: 'session',
                relatedSessionId: sessionId,
                relatedUserId: teacherUid,
                balanceAfter: learnerBalance - baseCredits
            }),
            createTransactionRecord(db, {
                uid: teacherUid,
                type: 'earn',
                amount: baseCredits,
                description: `Taught ${session.topic || 'a session'} to ${learnerProfile.fullName || learnerProfile.firstName || 'student'}`,
                category: 'session',
                relatedSessionId: sessionId,
                relatedUserId: learnerUid,
                balanceAfter: (teacherProfile.creditBalance || 0) + baseCredits
            })
        ]);
    }

    if (!reportIssue) {
        const currentRating = partnerProfile?.stats?.averageRating || 0;
        const totalRatings = partnerProfile?.stats?.totalRatings || 0;
        const newAverage = ((currentRating * totalRatings) + rating) / (totalRatings + 1);
        batch.set(db.collection('users').doc(partnerUid), {
            stats: {
                averageRating: newAverage,
                totalRatings: admin.firestore.FieldValue.increment(1)
            }
        }, { merge: true });
    }

    batch.set(db.collection('users').doc(callerUid), {
        stats: { sessionsCompleted: admin.firestore.FieldValue.increment(1) }
    }, { merge: true });
    batch.set(sessionRef, sessionUpdate, { merge: true });
    batch.set(db.collection('notifications').doc(), {
        uid: partnerUid,
        type: reportIssue ? 'session-disputed' : 'session-completed',
        title: reportIssue ? 'Session Issue Reported' : 'Session Completed',
        message: reportIssue
            ? `${callerProfile.firstName || 'Your partner'} reported an issue with the ${session.topic || 'session'}.`
            : `${callerProfile.firstName || 'Your partner'} completed the ${session.topic || 'session'} session and shared feedback.`,
        sessionId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();
    return { ok: true };
}

async function reportSkillSwapNoShow(sessionId, callerUid, whoNoShowed) {
    const { db, sessionRef, session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    const baseCredits = session.creditsAgreed || Math.round(((session.durationMinutes || 60) / 60) * 20);
    const teacherUid = session.teacherUid;
    const learnerUid = session.studentUid;
    const teacherProfile = await getUserProfileOrThrow(teacherUid);
    const learnerProfile = await getUserProfileOrThrow(learnerUid);
    const batch = db.batch();

    batch.set(sessionRef, {
        status: 'no-show',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        noShowType: whoNoShowed,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (whoNoShowed === 'teacher') {
        batch.set(db.collection('users').doc(teacherUid), {
            stats: { noShowCount: admin.firestore.FieldValue.increment(1) }
        }, { merge: true });
        batch.set(db.collection('notifications').doc(), {
            uid: teacherUid,
            type: 'no-show-warning',
            title: 'No-Show Warning',
            message: 'You were marked as no-show for a SkillSwap session.',
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } else {
        const learnerBalance = Math.max(0, learnerProfile.creditBalance || 0);
        const intendedPenalty = Math.round(baseCredits * 0.5);
        const penalty = Math.min(learnerBalance, intendedPenalty);
        if (penalty > 0) {
            batch.update(db.collection('users').doc(learnerUid), {
                creditBalance: learnerBalance - penalty
            });
            batch.update(db.collection('users').doc(teacherUid), {
                creditBalance: (teacherProfile.creditBalance || 0) + penalty
            });
            await Promise.all([
                createTransactionRecord(db, {
                    uid: learnerUid,
                    type: 'spend',
                    amount: penalty,
                    description: `No-show penalty for ${session.topic || 'session'}`,
                    category: 'session',
                    relatedSessionId: sessionId,
                    relatedUserId: teacherUid,
                    balanceAfter: learnerBalance - penalty
                }),
                createTransactionRecord(db, {
                    uid: teacherUid,
                    type: 'earn',
                    amount: penalty,
                    description: `No-show compensation from ${learnerProfile.fullName || learnerProfile.firstName || 'student'}`,
                    category: 'session',
                    relatedSessionId: sessionId,
                    relatedUserId: learnerUid,
                    balanceAfter: (teacherProfile.creditBalance || 0) + penalty
                })
            ]);
        }
        batch.set(db.collection('users').doc(learnerUid), {
            stats: { noShowCount: admin.firestore.FieldValue.increment(1) }
        }, { merge: true });
    }

    await batch.commit();
    return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// GEMINI TIMEOUT + RETRY
// ─────────────────────────────────────────────────────────────
function withTimeout(p, ms, label) {
    return Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${label}`)), ms))
    ]);
}

async function callGemini(model, prompt, imageParts) {
    const call = () => imageParts?.length
        ? model.generateContent([prompt, ...imageParts])
        : model.generateContent(prompt);
    try {
        const r    = await withTimeout(call(), TIMEOUT_MS, 'Gemini');
        const text = r.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (e) {
        if (e instanceof SyntaxError) {
            const strict = prompt + '\n\nCRITICAL: Valid JSON only. No markdown. Start { end }.';
            const r2 = await withTimeout(
                imageParts?.length ? model.generateContent([strict, ...imageParts]) : model.generateContent(strict),
                TIMEOUT_MS, 'Gemini retry'
            );
            return JSON.parse(r2.response.text().replace(/```json/gi,'').replace(/```/g,'').trim());
        }
        throw e;
    }
}

// ─────────────────────────────────────────────────────────────
// DETERMINISTIC GITHUB SCORE
// ─────────────────────────────────────────────────────────────
function calcGitHubScore(profile, repos, langNames, skillLevels, ai) {
    let score = 0;
    const bd  = {};

    const ageMonths = (Date.now() - new Date(profile.created_at)) / (1000*60*60*24*30);
    const ageScore  = Math.min(15, Math.floor(ageMonths / 4));
    score += ageScore;
    bd.accountAge = `${ageScore}/15 (${Math.floor(ageMonths)}mo)`;

    const orig      = repos.filter(r => !r.isFork && r.size > 0);
    const forks     = repos.filter(r => r.isFork);
    const forkRatio = repos.length ? forks.length / repos.length : 0;
    let rScore = Math.min(20, orig.length * 2);
    if (forkRatio > 0.7) rScore = Math.max(0, rScore - 10);
    else if (forkRatio > 0.5) rScore = Math.max(0, rScore - 5);
    score += rScore;
    bd.originalRepos = `${rScore}/20 (${orig.length} original, ${forks.length} forks)`;

    const fresh = orig.filter(r => (Date.now()-new Date(r.createdAt))/(1000*60*60*24) < 7);
    if (fresh.length) {
        const fp = Math.min(15, fresh.length * 5);
        score -= fp;
        bd.freshRepoPenalty = `-${fp} (${fresh.length} repos < 7 days old)`;
    }

    const active = orig.filter(r => r.size > 10);
    const recent = active.filter(r => (Date.now()-new Date(r.updatedAt))/(1000*60*60*24*30) <= 12);
    const act = Math.min(20, active.length*2 + recent.length);
    score += act;
    bd.activity = `${act}/20 (${active.length} active, ${recent.length} recent)`;

    const ALIASES = {
        javascript: ['js','typescript','jsx','tsx','react','vue','node','angular','next'],
        python:     ['jupyter notebook','jupyter','django','flask','fastapi'],
        css:        ['ui/ux','sass','scss','less'],
        'c++':      ['cpp'],
        java:       ['kotlin','android'],
        php:        ['laravel','wordpress'],
    };
    const claimed  = Object.keys(skillLevels).map(s => s.toLowerCase());
    const ll       = langNames.map(l => l.toLowerCase());
    let langScore  = 0;
    claimed.forEach(skill => {
        if (ll.some(l => l.includes(skill) || skill.includes(l))) {
            langScore += Math.ceil(25 / Math.max(claimed.length, 1)); return;
        }
        for (const [base, aliases] of Object.entries(ALIASES)) {
            if (aliases.includes(skill) && ll.some(l => l.includes(base) || aliases.some(a => l.includes(a)))) {
                langScore += Math.ceil(25 / Math.max(claimed.length, 1)); return;
            }
        }
    });
    langScore = Math.min(25, langScore);
    score += langScore;
    bd.languageMatch = `${langScore}/25 (${langNames.slice(0,5).join(', ')||'none'})`;

    const aiScore = Math.min(20, Math.round((ai.qualityRating / 10) * 20));
    score += aiScore;
    bd.aiQuality = `${aiScore}/20 (rating: ${ai.qualityRating}/10)`;

    if (Object.values(skillLevels).some(l => l==='expert') && orig.length < 5) {
        score -= 15; bd.levelPenalty = '-15 (expert, <5 repos)';
    } else if (Object.values(skillLevels).some(l => l==='intermediate') && orig.length < 2) {
        score -= 8; bd.levelPenalty = '-8 (intermediate, <2 repos)';
    }

    return { score: Math.max(0, Math.min(100, score)), breakdown: bd };
}

// ─────────────────────────────────────────────────────────────
// GITHUB HELPERS
// ─────────────────────────────────────────────────────────────
function extractGitHubUsername(url) {
    const m = url?.match(/github\.com\/([^\/\?\s#]+)/);
    if (m) return m[1];
    if (url && !url.includes('/') && !url.includes('.') && !url.includes('@')) return url.trim();
    return null;
}

const ghGet = path => axios.get(`https://api.github.com${path}`, {
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }, timeout: 10000
});

const getProfile = u => ghGet(`/users/${u}`).then(r => r.data);

const getRepos = async u => {
    const r = await ghGet(`/users/${u}/repos?sort=updated&per_page=100`);
    return r.data.map(r => ({
        name: r.name, desc: r.description, language: r.language,
        stars: r.stargazers_count, forks: r.forks_count, topics: r.topics||[],
        updatedAt: r.updated_at, createdAt: r.created_at,
        size: r.size, isFork: r.fork,
    }));
};

const getLangs = async (u, repos) => {
    const targets = repos.filter(r => !r.isFork && r.size > 10).slice(0, 6);
    const lc      = {};
    await Promise.all(targets.map(r =>
        ghGet(`/repos/${u}/${r.name}/languages`).then(res => {
            for (const [l, b] of Object.entries(res.data)) lc[l] = (lc[l]||0) + b;
        }).catch(() => {})
    ));
    return Object.entries(lc).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([l])=>l);
};

const detectClones = async (u, repos) => {
    const suspects = [];
    for (const r of repos.filter(r=>!r.isFork&&r.size>50).sort((a,b)=>b.size-a.size).slice(0,4)) {
        try {
            const res  = await ghGet(`/repos/${u}/${r.name}/contributors`);
            const user = res.data.find(c => c.login.toLowerCase()===u.toLowerCase());
            const n    = user ? user.contributions : 0;
            if (n === 0) suspects.push({ name: r.name, reason: '0 commits by owner — likely cloned' });
            else if (n < 3 && r.stars > 30) suspects.push({ name: r.name, reason: `Only ${n} commit(s), ${r.stars} stars` });
        } catch (_) {}
    }
    return suspects;
};

// ─────────────────────────────────────────────────────────────
// IMAGE / YOUTUBE HELPERS
// ─────────────────────────────────────────────────────────────
const fetchB64 = async url => {
    try {
        const r    = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000 });
        const mime = r.headers['content-type'] || 'image/jpeg';
        if (mime.includes('pdf') || url.toLowerCase().endsWith('.pdf')) return null;
        return { inlineData: { data: Buffer.from(r.data).toString('base64'), mimeType: mime } };
    } catch (_) { return null; }
};

const extractYTId = url => {
    for (const p of [/youtu\.be\/([^?&\s#]+)/,/youtube\.com\/watch\?v=([^&\s#]+)/,/youtube\.com\/shorts\/([^?&\s#]+)/,/youtube\.com\/embed\/([^?&\s#]+)/]) {
        const m = url?.match(p); if (m) return m[1];
    }
    return null;
};

const getYTMeta = async id => {
    try {
        const r = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { timeout: 8000 });
        return { ...r.data, found: true };
    } catch (e) { return { found: false }; }
};

// ─────────────────────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
    const ip    = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const usage = trackUsage(ip); // soft counter only, never blocks

    const { type, skillLevels={}, portfolioUrls } = req.body;

    const svSkills    = sanitize(req.body.skills,    MAX_SKILLS,    'skills');
    const svExpertise = sanitize(req.body.expertise, MAX_EXPERTISE, 'expertise');
    if (svSkills.error)  return res.status(400).json({ error: svSkills.error });
    if (!svSkills.value) return res.status(400).json({ error: 'No skills provided.' });
    if (typeof skillLevels !== 'object' || Array.isArray(skillLevels))
        return res.status(400).json({ error: 'skillLevels must be an object.' });
    if (Object.keys(skillLevels).length > 15)
        return res.status(400).json({ error: 'Too many skills (max 15).' });

    const skills    = svSkills.value;
    const expertise = svExpertise.value;

    // Profile owner name — used for certificate name matching
    const firstName = (req.body.profileFirstName || '').trim().toLowerCase();
    const lastName  = (req.body.profileLastName  || '').trim().toLowerCase();
    const fullName  = `${firstName} ${lastName}`.trim();

    try {
        const model = genAI.getGenerativeModel(MODEL_CONFIG);

        // ── GITHUB ──────────────────────────────────────────
        if (type === 'technical') {
            const rawGH = req.body.githubUrl;
            if (!rawGH || rawGH.length > MAX_URL) return res.status(400).json({ error: 'Invalid GitHub URL.' });
            const username = extractGitHubUsername(rawGH);
            if (!username) return res.status(400).json({ error: 'Could not parse GitHub username.' });

            let profile, repos;
            try {
                [profile, repos] = await Promise.all([getProfile(username), getRepos(username)]);
            } catch (e) {
                if (e.response?.status === 404) return res.status(404).json({ error: `GitHub user "${username}" not found.` });
                if (e.response?.status === 403) return res.status(503).json({ error: 'GitHub API rate limit. Wait ~1 hour.' });
                throw e;
            }

            const bio               = profile.bio || '';
            const ownershipVerified = bio.toLowerCase().includes(OWNERSHIP_CODE.toLowerCase());

            const [langNames, clones] = await Promise.all([
                getLangs(username, repos),
                detectClones(username, repos)
            ]);

            const orig   = repos.filter(r => !r.isFork && r.size > 0);
            const fresh  = orig.filter(r => (Date.now()-new Date(r.createdAt))/(1000*60*60*24) < 7);
            const lvlLines = Object.entries(skillLevels).map(([s,l])=>`  - ${s}: ${LEVEL_CONTEXT[l]||LEVEL_CONTEXT.intermediate}`).join('\n') || `  ${skills}`;

            const aiPrompt = `Rate this developer's original code quality 1-10. Do NOT produce a confidence score.

Developer: ${profile.login} | Created: ${profile.created_at} | Followers: ${profile.followers}
Skills claimed:
${lvlLines}
Languages in original repos: ${langNames.join(', ')||'none'}
Original repos: ${orig.length} | Forks: ${repos.filter(r=>r.isFork).length}
${fresh.length?`⚠️ Fresh repos (<7 days): ${fresh.map(r=>r.name).join(', ')}`:''}
${clones.length?`⚠️ Clone suspects:\n${clones.map(s=>`- ${s.name}: ${s.reason}`).join('\n')}`:''}

Top original repos:
${JSON.stringify(orig.slice(0,15).map(r=>({name:r.name,desc:r.desc,language:r.language,stars:r.stars,topics:r.topics,size:r.size})),null,2)}

User description: "${expertise}"

Respond ONLY in valid JSON (no markdown):
{
  "qualityRating": number (1-10),
  "verifiedSkills": ["skills with clear repo evidence"],
  "unverifiedSkills": ["skills with no evidence"],
  "partialSkills": ["skills with weak evidence"],
  "reasoning": "3 sentences naming specific repos."
}`;

            const ai = await callGemini(model, aiPrompt, null);
            const { score, breakdown } = calcGitHubScore(profile, repos, langNames, skillLevels, ai);

            let finalScore = score, clonePenalty = 0;
            if (clones.length >= 3) { clonePenalty = 25; finalScore = Math.max(0, score-25); }
            else if (clones.length >= 1) { clonePenalty = 10; finalScore = Math.max(0, score-10); }

            const result = {
                isVerified:       finalScore >= 60 && (ai.verifiedSkills||[]).length > 0,
                confidenceScore:  finalScore,
                scoreBreakdown:   breakdown,
                verifiedSkills:   ai.verifiedSkills   || [],
                unverifiedSkills: ai.unverifiedSkills || [],
                partialSkills:    ai.partialSkills    || [],
                cloneWarning:     clones.length > 0,
                cloneDetails:     clones,
                clonePenalty,
                originalRepoCount: orig.length,
                forkedRepoCount:   repos.filter(r=>r.isFork).length,
                languagesFound:   langNames,
                reasoning:        ai.reasoning,
                ownershipVerified,
                usage,
            };

            if (!ownershipVerified) {
                result.isVerified      = false;
                result.confidenceScore = Math.min(finalScore, UNVERIFIED_CAP);
                result.ownershipWarning = `Score capped at ${UNVERIFIED_CAP}/100. Actual score: ${finalScore}/100. Add "${OWNERSHIP_CODE}" to your GitHub bio to unlock.`;
            }

            return res.json(result);
        }

        // ── PORTFOLIO / CERTIFICATE ──────────────────────────
        else if (type === 'creative') {
            if (!portfolioUrls?.length) return res.status(400).json({ error: 'No images provided.' });
            if (portfolioUrls.length > 5) return res.status(400).json({ error: 'Max 5 images.' });

            const imageResults = [];

            for (let i = 0; i < portfolioUrls.length; i++) {
                const url = portfolioUrls[i];
                if (url?.toLowerCase().endsWith('.pdf') || url?.includes('/raw/')) {
                    imageResults.push({ index:i+1, isVerified:false, confidenceScore:0, tamperDetected:false,
                        error:'PDF cannot be analyzed. Export as PNG or JPG and re-upload.' });
                    continue;
                }
                const part = await fetchB64(url);
                if (!part) {
                    imageResults.push({ index:i+1, isVerified:false, confidenceScore:0,
                        error:'Could not load image. If PDF, export as PNG/JPG first.' });
                    continue;
                }

                const lvlLines = Object.entries(skillLevels).map(([s,l])=>`- ${s}: claimed as ${l}`).join('\n') || skills;

                // NAME CHECK INSTRUCTION — core fix
                const nameInstruction = fullName
                    ? `CRITICAL NAME CHECK — TOP PRIORITY:
Profile owner's name: "${fullName}"
You MUST find the recipient/awardee name printed on this certificate.
Compare it strictly to "${fullName}".
- Allow: middle names, initials, shortened versions (e.g. "Raiyan A. Chougle" = match for "raiyan chougle")
- DO NOT allow: completely different first OR last name
- A certificate issued to "John Smith" submitted by "Raiyan Chougle" is a CLEAR MISMATCH → nameMismatch: true, isVerified: false, confidenceScore: 0`
                    : 'Name check: Profile name not provided — skip.';

                const prompt = `You are a strict document forensics expert and skill verifier.

${nameInstruction}

SKILLS TO VERIFY:
${lvlLines}
User description: "${expertise}"
Credible issuers: ${KNOWN_ISSUERS.join(', ')}

Image ${i+1} of ${portfolioUrls.length} — analyze this one only.

NAME VERIFICATION (do this first before anything else):
1. Find the name of the person this certificate was awarded to
2. Compare to profile owner: "${fullName}"
3. If no match → nameMismatch: true, isVerified: false, confidenceScore: 0

FORGERY DETECTION (conservative — only flag obvious artifacts):
- White halos or pixel smearing around text fields
- Clear font weight/style inconsistency on the same line
- Only flag HIGH if artifacts are obvious. Low-confidence = skip.

AI-GENERATED CERT DETECTION:
- Perfect typography with zero print variation
- Generic institution name ("World Cert Academy")
- Zero paper texture (real certs always have some)

SKILL VERIFICATION:
- Does subject match claimed skills?
- Is issuer credible?
- Grade/level match?

Respond ONLY in valid JSON (no markdown, no backticks):
{
  "recipientName": "name found on certificate or 'not visible'",
  "nameMismatch": boolean,
  "nameMismatchReason": "brief reason or 'Names match'",
  "isVerified": boolean,
  "confidenceScore": number (0-100, must be 0 if nameMismatch true),
  "tamperDetected": boolean,
  "tamperConfidence": "high / medium / low / none",
  "tamperDetails": "what looks edited OR 'No tampering detected'",
  "aiGeneratedSuspicion": boolean,
  "aiGeneratedReason": "why or 'Looks like a real document'",
  "issuer": "issuing body name",
  "issuerCredible": boolean,
  "certificateSubject": "what cert is for",
  "skillMatch": "direct / partial / none",
  "levelMatch": boolean,
  "reasoning": "3 sentences: name check, tamper, skill match"
}`;

                const j = await callGemini(model, prompt, [part]);

                // Hard: name mismatch = fail
                if (j.nameMismatch) { j.isVerified = false; j.confidenceScore = 0; }

                // Tamper
                if (j.tamperDetected) {
                    if (j.tamperConfidence === 'high') { j.isVerified = false; j.confidenceScore = Math.min(j.confidenceScore, 5); }
                    else if (j.tamperConfidence === 'medium') { j.confidenceScore = Math.min(j.confidenceScore, 40); j.tamperWarning = 'Possible editing — manual review recommended.'; }
                    else { j.tamperDetected = false; j.tamperDetails = 'Minor irregularities within normal scan range.'; }
                }

                // AI-generated
                if (j.aiGeneratedSuspicion) { j.isVerified = false; j.confidenceScore = Math.min(j.confidenceScore, 15); j.tamperWarning = `Possible AI-generated cert: ${j.aiGeneratedReason}`; }

                if (!j.issuerCredible) j.confidenceScore = Math.min(j.confidenceScore, 55);
                if (j.skillMatch === 'none') { j.isVerified = false; j.confidenceScore = Math.min(j.confidenceScore, 20); }

                imageResults.push({ index: i+1, url, ...j });
            }

            const forged      = imageResults.filter(r => r.tamperDetected && r.tamperConfidence==='high');
            const namesFailed = imageResults.filter(r => r.nameMismatch);
            const verified    = imageResults.filter(r => r.isVerified);
            const valid       = imageResults.filter(r => !r.error);
            const avgScore    = valid.length ? Math.round(valid.reduce((a,b)=>a+(b.confidenceScore||0),0)/valid.length) : 0;

            if (imageResults.every(r => r.error?.includes('PDF'))) {
                return res.json({ isVerified:false, confidenceScore:0, imageResults, pdfError:true,
                    summary:'All files are PDFs. Export as PNG or JPG and re-upload.' });
            }

            let summary;
            if (namesFailed.length)  summary = `Name mismatch on ${namesFailed.length} cert(s). Certificate must be issued to "${fullName || 'you'}".`;
            else if (forged.length)  summary = `FORGERY on ${forged.length} image(s). Rejected.`;
            else if (verified.length) summary = `${verified.length}/${imageResults.length} cert(s) verified.`;
            else summary = 'No certificates verified. Check skill match and image quality.';

            return res.json({
                isVerified:        namesFailed.length===0 && forged.length===0 && verified.length>0,
                confidenceScore:   (namesFailed.length||forged.length) ? 0 : avgScore,
                imageCount:        imageResults.length,
                imageResults,
                forgedCount:       forged.length,
                nameMismatchCount: namesFailed.length,
                verifiedCount:     verified.length,
                summary,
                usage,
            });
        }

        // ── YOUTUBE ──────────────────────────────────────────
        else if (type === 'video') {
            const rawYT = req.body.youtubeUrl;
            if (!rawYT || rawYT.length > MAX_URL) return res.status(400).json({ error: 'Invalid YouTube URL.' });
            const id = extractYTId(rawYT);
            if (!id) return res.status(400).json({ error: 'Invalid YouTube URL format.' });

            const isShort  = rawYT.includes('/shorts/');
            const maxScore = isShort ? 35 : 65;
            const meta     = await getYTMeta(id);
            if (!meta.found) return res.status(404).json({ error: 'Video not accessible. Must be PUBLIC.' });

            const thumb  = await fetchB64(`https://img.youtube.com/vi/${id}/maxresdefault.jpg`);
            const lvlLines = Object.entries(skillLevels).map(([s,l])=>`- ${s}: claimed as ${l}`).join('\n') || skills;

            const ytPrompt = `Evaluate this YouTube video as teaching proof.

Skills to verify:
${lvlLines}
User description: "${expertise}"

Video: Title="${meta.title}" | Channel="${meta.author_name}" | Is Short: ${isShort}
Thumbnail provided. You CANNOT watch the video.

Score 0-${maxScore} ONLY. 
Title directly names skill + educational = high. Title-stuffing = low. Unrelated = fail.
Shorts always: isVerified false, max 35.

Respond ONLY in valid JSON:
{
  "isVerified": boolean,
  "confidenceScore": number (0-${maxScore} HARD MAX),
  "titleRelevance": "direct / partial / none",
  "thumbnailQuality": "educational / average / clickbait / unclear",
  "channelFocused": boolean,
  "titleStuffingSuspected": boolean,
  "videoTitle": "${meta.title}",
  "channelName": "${meta.author_name}",
  "reasoning": "3 sentences. State video was not watchable.",
  "limitation": "Only title, thumbnail, channel analyzed. Full video not accessible.",
  "ownershipNote": "Channel ownership NOT verified."
}`;

            const j = await callGemini(model, ytPrompt, thumb ? [thumb] : null);

            j.confidenceScore = Math.min(j.confidenceScore, maxScore);
            if (j.titleStuffingSuspected) j.confidenceScore = Math.min(j.confidenceScore, 25);
            if (j.titleRelevance === 'none') { j.isVerified = false; j.confidenceScore = Math.min(j.confidenceScore, 10); }
            if (isShort) { j.isVerified = false; j.reasoning = (j.reasoning||'') + ' YouTube Shorts too short to demonstrate teaching.'; }
            j.isVerified = j.confidenceScore >= 50 && !isShort;

            return res.json({ ...j, usage, channelOwnershipVerified: false });
        }

        else {
            return res.status(400).json({ error: `Unknown type: "${type}"` });
        }

    } catch (err) {
        console.error('[verify]', err.message);
        if (err.message?.includes('SAFETY'))  return res.status(400).json({ error: 'Content flagged by safety filters.' });
        if (err instanceof SyntaxError)       return res.status(500).json({ error: 'AI returned malformed response. Try again.' });
        if (err.response?.status === 401)     return res.status(500).json({ error: 'GitHub token invalid.' });
        if (err.response?.status === 403)     return res.status(503).json({ error: 'GitHub API rate limit. Wait ~1 hour.' });
        if (err.message?.includes('Timeout')) return res.status(504).json({ error: 'Analysis timed out. Try again.' });
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// GROQ AI STUDY MATERIALS ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post('/api/generate-study-materials', async (req, res) => {
    try {
        const { topic, type } = req.body;

        if (!topic || typeof topic !== 'string' || topic.length > 200) {
            return res.status(400).json({ error: 'Invalid topic. Max 200 characters.' });
        }

        if (!process.env.GROQ_API_KEY) {
            return res.status(500).json({ error: 'GROQ_API_KEY not configured in .env file' });
        }

        // Sanitize topic
        const sanitizedTopic = topic
            .replace(/ignore previous instructions/gi, '')
            .replace(/system:/gi, '')
            .replace(/\[INST\]/gi, '')
            .trim();

        // Build prompt based on type
        let prompt = '';
        
        if (type === 'mindmap') {
            prompt = `You are an expert educator. Create a comprehensive mind map for learning "${sanitizedTopic}".

Return ONLY valid JSON (no markdown, no backticks) in this exact structure:
{
  "topic": "${sanitizedTopic}",
  "mindmap": {
    "central": "${sanitizedTopic}",
    "branches": [
      {
        "id": "b1",
        "title": "Branch Title",
        "color": "#7c5cfc",
        "subtopics": [
          { "id": "b1s1", "text": "Subtopic 1" },
          { "id": "b1s2", "text": "Subtopic 2" }
        ]
      }
    ]
  },
  "flowchart": [
    { "step": 1, "title": "Step Title", "description": "What to learn", "duration": "1 week" }
  ],
  "flashcards": [
    { "question": "Q text", "answer": "A text" }
  ],
  "quiz": [
    { "question": "Q text", "options": ["A", "B", "C", "D"], "correct": 0 }
  ],
  "notes": {
    "summary": "Overview paragraph",
    "keyPoints": ["Point 1", "Point 2"],
    "sections": [
      { "heading": "Section 1", "content": "Details..." }
    ]
  }
}

Create 3-5 branches, 10+ flashcards, 5+ quiz questions. Make it comprehensive and educational.`;
        }

        // Call Groq API
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert educational content creator. Always return valid JSON only, no markdown formatting.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.7,
                max_tokens: 4000
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        let aiText = response.data.choices[0].message.content.trim();
        
        // Clean markdown artifacts
        aiText = aiText.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        // Parse JSON
        const result = JSON.parse(aiText);
        
        res.json(result);

    } catch (err) {
        console.error('[generate-study-materials]', err.message);
        
        if (err.response?.status === 401) {
            return res.status(401).json({ error: 'Invalid Groq API key. Check .env file.' });
        }
        if (err.response?.status === 429) {
            return res.status(429).json({ error: 'Groq API rate limit reached. Try again in 1 minute.' });
        }
        if (err instanceof SyntaxError) {
            return res.status(500).json({ error: 'AI returned invalid JSON. Try again.' });
        }
        
        res.status(500).json({ error: err.message || 'Failed to generate study materials' });
    }
});

app.get('/api/google-calendar/auth-url', requireAuth, async (req, res) => {
    try {
        const oauth2Client = createGoogleOAuthClient();
        const stateToken = crypto.randomUUID();
        googleCalendarStateStore.set(stateToken, {
            uid: req.user.uid,
            createdAt: Date.now(),
            returnTo: req.query.returnTo || process.env.GOOGLE_CALENDAR_SUCCESS_URL || 'http://localhost:5500/MiniPROJECT/dashboard.html'
        });
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: GOOGLE_SCOPES,
            state: stateToken,
            include_granted_scopes: true
        });
        res.json({ url: authUrl });
    } catch (err) {
        console.error('[google-calendar auth-url]', err.message);
        res.status(500).json({ error: err.message || 'Could not start Google Calendar connection.' });
    }
});

app.get('/api/google-calendar/callback', async (req, res) => {
    const stateToken = req.query.state;
    const code = req.query.code;
    const stateEntry = stateToken ? googleCalendarStateStore.get(stateToken) : null;
    if (!stateEntry) {
        return res.status(400).send('<h2>SkillSwap</h2><p>This Google Calendar connection link expired. Return to SkillSwap and try again.</p>');
    }
    googleCalendarStateStore.delete(stateToken);

    try {
        const oauth2Client = createGoogleOAuthClient();
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const profile = await oauth2.userinfo.get();
        await saveGoogleConnection(stateEntry.uid, {
            connected: true,
            email: profile.data.email || null,
            displayName: profile.data.name || null,
            accessToken: tokens.access_token || null,
            refreshToken: tokens.refresh_token || null,
            expiryDate: tokens.expiry_date || null,
            scope: tokens.scope || null,
            tokenType: tokens.token_type || null,
            connectedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.set('Content-Type', 'text/html');
        res.send(`<!doctype html>
<html>
  <head><title>SkillSwap Calendar Connected</title></head>
  <body style="font-family:Arial,sans-serif;background:#0b1020;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
    <div style="max-width:420px;padding:28px;border-radius:20px;background:#121933;border:1px solid rgba(255,255,255,0.08);text-align:center">
      <div style="font-size:44px;margin-bottom:12px">📅</div>
      <h2 style="margin:0 0 10px">Google Calendar connected</h2>
      <p style="line-height:1.6;color:rgba(255,255,255,0.76)">You can close this window and return to SkillSwap. Meet links will now be created automatically when you schedule.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'skillswap-google-calendar-connected' }, '*');
          window.close();
        }
      } catch (e) {}
    </script>
  </body>
</html>`);
    } catch (err) {
        console.error('[google-calendar callback]', err.message);
        res.status(500).send('<h2>SkillSwap</h2><p>Google Calendar connection failed. Return to the app and try again.</p>');
    }
});

app.get('/api/google-calendar/status', requireAuth, async (req, res) => {
    try {
        const connection = await getGoogleConnection(req.user.uid);
        res.json({
            connected: !!(connection && connection.connected && connection.refreshToken),
            email: connection?.email || req.user.email || null,
            displayName: connection?.displayName || null,
            updatedAt: connection?.updatedAt || null
        });
    } catch (err) {
        console.error('[google-calendar status]', err.message);
        res.status(500).json({ error: err.message || 'Could not load Google Calendar status.' });
    }
});

app.post('/api/sessions/schedule-google-meet', requireAuth, async (req, res) => {
    try {
        const { requestId, topic, durationMinutes, startAt, partnerName, appUrl } = req.body || {};
        if (!requestId) return res.status(400).json({ error: 'Missing accepted request id.' });
        if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'Topic is required.' });
        if (!startAt) return res.status(400).json({ error: 'Start date is required.' });

        const acceptedConnection = await getAcceptedConnectionOrThrow(requestId, req.user.uid);
        const result = await createCalendarBackedSession({
            organizerUid: req.user.uid,
            acceptedConnection,
            topic: topic.trim(),
            durationMinutes,
            startAt,
            partnerName,
            appUrl
        });

        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('[schedule-google-meet]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not schedule the Google Meet session.' });
    }
});

app.post('/api/sessions/:id/reschedule', requireAuth, async (req, res) => {
    try {
        const { startAt, durationMinutes, topic } = req.body || {};
        if (!startAt) return res.status(400).json({ error: 'Start date is required.' });
        const startDate = new Date(startAt);
        if (Number.isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid start date.' });
        const minutes = Math.max(15, Number(durationMinutes) || 60);
        const endDate = new Date(startDate.getTime() + minutes * 60 * 1000);
        const updated = await updateCalendarBackedSession(req.params.id, req.user.uid, {
            startAt: startDate,
            endAt: endDate,
            durationMinutes: minutes,
            topic: topic || undefined
        });
        res.json({ ok: true, ...updated });
    } catch (err) {
        console.error('[reschedule-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not reschedule this session.' });
    }
});

app.post('/api/sessions/:id/cancel', requireAuth, async (req, res) => {
    try {
        const updated = await updateCalendarBackedSession(req.params.id, req.user.uid, { status: 'cancelled' });
        const db = getAdminDb();
        const sessionSnap = await db.collection('sessions').doc(req.params.id).get();
        if (sessionSnap.exists) {
            const session = sessionSnap.data();
            await Promise.all((session.participants || []).map(uid => db.collection('notifications').add({
                uid,
                type: 'session-cancelled',
                title: 'Session Cancelled',
                message: `A SkillSwap session${session.topic ? ' on ' + session.topic : ''} was cancelled.`,
                sessionId: req.params.id,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            })));
        }
        res.json({ ok: true, ...updated });
    } catch (err) {
        console.error('[cancel-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not cancel this session.' });
    }
});

app.post('/api/sessions/:id/complete', requireAuth, async (req, res) => {
    try {
        const rating = Number(req.body?.rating || 0);
        if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
        const reportIssue = !!req.body?.reportIssue;
        const issueReason = typeof req.body?.issueReason === 'string' ? req.body.issueReason : '';
        const result = await completeSkillSwapSession(req.params.id, req.user.uid, rating, feedback, reportIssue, issueReason);
        res.json(result);
    } catch (err) {
        console.error('[complete-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not complete this session.' });
    }
});

app.post('/api/sessions/:id/no-show', requireAuth, async (req, res) => {
    try {
        const whoNoShowed = req.body?.whoNoShowed;
        if (!['teacher', 'student'].includes(whoNoShowed)) {
            return res.status(400).json({ error: 'whoNoShowed must be "teacher" or "student".' });
        }
        const result = await reportSkillSwapNoShow(req.params.id, req.user.uid, whoNoShowed);
        res.json(result);
    } catch (err) {
        console.error('[no-show]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not record the no-show.' });
    }
});

app.get('/api/health', (_req, res) => res.json({
    status: 'ok',
    ownershipCode: OWNERSHIP_CODE,
    calendarConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI),
    firebaseAdminConfigured: !!getFirebaseServiceAccount(),
    ai: { verification: 'gemini', studyMaterials: 'groq' }
}));

app.listen(5000, () => {
    console.log('🚀 SkillSwap Verification Server — port 5000');
    console.log(`🔐 Ownership code: "${OWNERSHIP_CODE}" | Cap without it: ${UNVERIFIED_CAP}`);
    console.log(`🤖 Groq AI: ${process.env.GROQ_API_KEY ? 'Configured ✅' : 'NOT configured ❌'}`);
});

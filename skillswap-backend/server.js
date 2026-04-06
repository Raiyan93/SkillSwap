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
const path    = require('path');
const admin   = require('firebase-admin');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const skillPricing = require(path.join(__dirname, '..', 'MiniPROJECT', 'skill-pricing.js'));

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
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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

const CERT_LINK_PLATFORMS = [
    { name: 'Coursera', issuer: 'Coursera', hosts: ['coursera.org'], verifyPaths: [/accomplishments\/verify/i, /verify/i] },
    { name: 'Credly', issuer: 'Credly', hosts: ['credly.com'], verifyPaths: [/badges\//i, /public_profiles/i] },
    { name: 'LinkedIn Learning', issuer: 'LinkedIn Learning', hosts: ['linkedin.com', 'lnkd.in'], verifyPaths: [/learning/i, /certificate/i, /certificates/i] },
    { name: 'freeCodeCamp', issuer: 'freeCodeCamp', hosts: ['freecodecamp.org'], verifyPaths: [/certification/i] },
    { name: 'NPTEL', issuer: 'NPTEL', hosts: ['nptel.ac.in'], verifyPaths: [/verify/i, /certificate/i] },
    { name: 'edX', issuer: 'edX', hosts: ['edx.org'], verifyPaths: [/certificate/i] },
    { name: 'Udemy', issuer: 'Udemy', hosts: ['udemy.com'], verifyPaths: [/certificate/i] },
    { name: 'HackerRank', issuer: 'HackerRank', hosts: ['hackerrank.com'], verifyPaths: [/certificates/i, /skills-verification/i] },
    { name: 'Google', issuer: 'Google', hosts: ['grow.google', 'skillshop.exceedlms.com', 'skillshop.withgoogle.com'], verifyPaths: [/certificate/i, /badge/i, /award/i] },
    { name: 'AWS', issuer: 'AWS', hosts: ['aws.training', 'aws.amazon.com'], verifyPaths: [/certification/i, /badge/i] },
    { name: 'Microsoft Learn', issuer: 'Microsoft', hosts: ['learn.microsoft.com', 'credentials.microsoft.com'], verifyPaths: [/credentials/i, /certification/i, /badge/i] },
    { name: 'DataCamp', issuer: 'DataCamp', hosts: ['datacamp.com'], verifyPaths: [/statement-of-accomplishment/i, /certificate/i] },
    { name: 'MongoDB University', issuer: 'MongoDB University', hosts: ['learn.mongodb.com', 'university.mongodb.com'], verifyPaths: [/certificate/i, /badge/i] }
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

async function getAcceptedConnectionOrThrow(requestOrOptions, maybeCallerUid) {
    const db = getAdminDb();
    const options = typeof requestOrOptions === 'object' && requestOrOptions !== null
        ? requestOrOptions
        : { requestId: requestOrOptions, callerUid: maybeCallerUid };
    const callerUid = options.callerUid;
    const requestId = options.requestId || '';
    const connectionId = options.connectionId || '';
    let data = null;
    let resolvedRequestId = requestId || connectionId;
    let resolvedConnectionId = connectionId || null;
    let requestExists = false;

    if (connectionId) {
        const directConnectionSnap = await db.collection('lessonConnections').doc(connectionId).get();
        if (directConnectionSnap.exists) {
            data = directConnectionSnap.data();
            resolvedConnectionId = directConnectionSnap.id;
            resolvedRequestId = data.requestId || requestId || directConnectionSnap.id;
        }
    }

    if (!data && requestId) {
        const connectionSnap = await db.collection('lessonConnections').doc(requestId).get();
        if (connectionSnap.exists) {
            data = connectionSnap.data();
            resolvedConnectionId = connectionSnap.id;
            resolvedRequestId = data.requestId || requestId;
        }
    }

    if (!data && requestId) {
        const connectionQuerySnap = await db.collection('lessonConnections').where('requestId', '==', requestId).limit(1).get();
        if (!connectionQuerySnap.empty) {
            const docSnap = connectionQuerySnap.docs[0];
            data = docSnap.data();
            resolvedConnectionId = docSnap.id;
            resolvedRequestId = data.requestId || requestId || docSnap.id;
        }
    }

    if (!data && requestId) {
        const requestSnap = await db.collection('lessonRequests').doc(requestId).get();
        if (requestSnap.exists && requestSnap.data()?.status === 'accepted') {
            data = requestSnap.data();
            resolvedRequestId = requestSnap.id;
            requestExists = true;
        }
    } else if (resolvedRequestId) {
        const requestSnap = await db.collection('lessonRequests').doc(resolvedRequestId).get();
        requestExists = requestSnap.exists;
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
    return {
        id: resolvedConnectionId || resolvedRequestId,
        requestId: resolvedRequestId,
        connectionId: resolvedConnectionId,
        requestExists,
        ...data
    };
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

async function requireReviewer(req, res, next) {
    try {
        const profile = await getUserProfileOrThrow(req.user.uid);
        if (profile.appRole !== 'reviewer') {
            return res.status(403).json({ error: 'Reviewer access required.' });
        }
        req.reviewerProfile = profile;
        next();
    } catch (err) {
        console.error('[reviewer-auth]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not verify reviewer access.' });
    }
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getDisplayName(profile, fallback = 'SkillSwap User') {
    return profile.fullName
        || [profile.firstName, profile.lastName].filter(Boolean).join(' ')
        || profile.firstName
        || fallback;
}

function isPaidSession(session) {
    if (session.sessionType === 'credit') return true;
    if (session.sessionType === 'demo') return false;
    return Number(session.creditsAgreed || 0) > 0;
}

function getBadgeTier(completedPaidSessions) {
    if (completedPaidSessions >= 20) return 'gold';
    if (completedPaidSessions >= 10) return 'silver';
    if (completedPaidSessions >= 5) return 'bronze';
    return 'none';
}

function isSettledCompletedSession(session) {
    if (!session || session.status !== 'completed') return false;
    const settlement = String(session.settlementStatus || '').toLowerCase();
    return !settlement || settlement === 'settled' || settlement === 'completed';
}

function normalizeRatingFeedback(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function getCanonicalOrDerivedRatingEntry(session, raterUid) {
    if (!session || !raterUid) return null;
    const direct = session?.ratings?.[raterUid];
    if (direct) {
        const directRating = Number(direct.rating || 0);
        const directFeedback = normalizeRatingFeedback(direct.feedback);
        if (directRating > 0 || directFeedback) {
            return {
                rating: directRating > 0 ? directRating : 0,
                feedback: directFeedback,
                ratedAt: direct.ratedAt || null
            };
        }
    }
    if (!isSettledCompletedSession(session)) return null;
    const response = raterUid === session.teacherUid
        ? session.teacherResponse
        : (raterUid === session.studentUid ? session.studentResponse : null);
    if (!response) return null;
    const responseRating = Number(response.rating || 0);
    const responseFeedback = normalizeRatingFeedback(response.feedback || response.note || '');
    if (!(responseRating > 0 || responseFeedback)) return null;
    return {
        rating: responseRating > 0 ? responseRating : 0,
        feedback: responseFeedback,
        ratedAt: response.submittedAt || session.completedAt || null
    };
}

function buildRecoveredRatingsPayload(session) {
    const recoveredRatings = {};
    const patch = {};
    [session?.teacherUid, session?.studentUid].forEach((raterUid) => {
        if (!raterUid || session?.ratings?.[raterUid]) return;
        const derived = getCanonicalOrDerivedRatingEntry(session, raterUid);
        if (!derived) return;
        const entry = {
            rating: Number(derived.rating || 0),
            feedback: derived.feedback || '',
            ratedAt: derived.ratedAt || session.completedAt || null
        };
        recoveredRatings[raterUid] = entry;
        patch.ratings = patch.ratings || {};
        patch.ratings[raterUid] = {
            ...entry,
            ratedAt: entry.ratedAt || admin.firestore.FieldValue.serverTimestamp()
        };
    });
    return {
        patch,
        session: Object.keys(recoveredRatings).length
            ? { ...session, ratings: { ...(session.ratings || {}), ...recoveredRatings } }
            : session
    };
}

async function buildUserStatsSnapshot(uid, profile = null) {
    const db = getAdminDb();
    const [teacherSnap, learnerSnap] = await Promise.all([
        db.collection('sessions').where('teacherUid', '==', uid).get(),
        db.collection('sessions').where('studentUid', '==', uid).get()
    ]);
    const sessionMap = new Map();
    teacherSnap.forEach((docSnap) => {
        sessionMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    });
    learnerSnap.forEach((docSnap) => {
        if (!sessionMap.has(docSnap.id)) sessionMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    });

    let sessionsCompleted = 0;
    let sessionsTaught = 0;
    let paidSessionsTaught = 0;
    let teacherTotalRatings = 0;
    let teacherRatingTotal = 0;
    let learnerTotalRatings = 0;
    let learnerRatingTotal = 0;

    sessionMap.forEach((session) => {
        if (!isSettledCompletedSession(session)) return;
        if (session.teacherUid === uid || session.studentUid === uid) {
            sessionsCompleted += 1;
        }
        if (session.teacherUid === uid) {
            sessionsTaught += 1;
            if (isPaidSession(session)) paidSessionsTaught += 1;
        }
        if (session.teacherUid === uid) {
            const teacherRatingEntry = getCanonicalOrDerivedRatingEntry(session, session.studentUid);
            const teacherRatingValue = Number(teacherRatingEntry?.rating || 0);
            if (teacherRatingValue > 0) {
                teacherTotalRatings += 1;
                teacherRatingTotal += teacherRatingValue;
            }
        }
        if (session.studentUid === uid) {
            const learnerRatingEntry = getCanonicalOrDerivedRatingEntry(session, session.teacherUid);
            const learnerRatingValue = Number(learnerRatingEntry?.rating || 0);
            if (learnerRatingValue > 0) {
                learnerTotalRatings += 1;
                learnerRatingTotal += learnerRatingValue;
            }
        }
    });

    const teacherAverageRating = teacherTotalRatings ? teacherRatingTotal / teacherTotalRatings : Number(profile?.stats?.teacherAverageRating || 0);
    const learnerAverageRating = learnerTotalRatings ? learnerRatingTotal / learnerTotalRatings : Number(profile?.stats?.learnerAverageRating || 0);
    return {
        averageRating: teacherAverageRating || learnerAverageRating || Number(profile?.stats?.averageRating || 0),
        totalRatings: teacherTotalRatings,
        teacherAverageRating,
        teacherTotalRatings,
        learnerAverageRating,
        learnerTotalRatings,
        sessionsCompleted,
        sessionsTaught,
        paidSessionsTaught
    };
}

async function syncUserDerivedStats(uid) {
    const db = getAdminDb();
    const profile = await getUserProfileOrThrow(uid);
    const stats = await buildUserStatsSnapshot(uid, profile);
    await db.collection('users').doc(uid).set({
        stats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return stats;
}

const FULL_REFUND_CANCEL_WINDOW_MS = 12 * 60 * 60 * 1000;
const POST_SESSION_RESPONSE_DELAY_MS = 1 * 60 * 1000;
const LEARNER_CONFIRMATION_WINDOW_MS = 24 * 60 * 60 * 1000;

function getSessionCreditAmount(session) {
    const explicit = Number(session?.creditsAgreed || 0);
    if (explicit > 0) return explicit;
    if (session?.sessionType === 'demo') return 0;
    return skillPricing.getFallbackCredits('intermediate');
}

function getFallbackCreditByLevel(level) {
    return skillPricing.getFallbackCredits(level);
}

function sanitizeSkillCreditValue(rawCredits, fallbackLevel) {
    const parsed = Number(rawCredits || 0);
    if (parsed > 0 && parsed <= 100) return Math.round(parsed);
    return skillPricing.getCredits('', fallbackLevel);
}

function getSkillCreditFromProfile(profile, skillRequested) {
    const teachEntries = Array.isArray(profile?.skills?.toTeach) ? profile.skills.toTeach : [];
    if (!teachEntries.length) return skillPricing.getFallbackCredits('intermediate');
    const targetKey = skillPricing.resolveSkillKey(skillRequested || '');
    const matched = teachEntries.find(entry => skillPricing.resolveSkillKey(entry?.name || '') === targetKey)
        || teachEntries.find(entry => String(entry?.name || '').trim().toLowerCase() === String(skillRequested || '').trim().toLowerCase());
    if (matched) {
        return skillPricing.getCredits(matched?.name || skillRequested || '', matched?.level || 'intermediate');
    }
    return skillPricing.getCredits(skillRequested || '', 'intermediate');
}

function normalizeAcceptedConnectionCredits(connection, teacherProfile) {
    if (connection?.sessionType === 'demo') return 0;
    const rawCredits = Number(connection?.creditsOffered || 0);
    if (rawCredits > 0 && rawCredits <= 100) return Math.round(rawCredits);
    return getSkillCreditFromProfile(teacherProfile, connection?.skillRequested);
}

const ROADMAP_LEVEL_LABELS = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced'
};

function normalizeRoadmapLevel(level) {
    const value = String(level || '').trim().toLowerCase();
    if (!value) return null;
    if (['beginner', 'complete beginner', 'foundational', 'foundation'].includes(value)) return 'beginner';
    if (['intermediate', 'inter'].includes(value)) return 'intermediate';
    if (['advanced', 'adv'].includes(value)) return 'advanced';
    return null;
}

function formatRoadmapLevel(levelKey) {
    return ROADMAP_LEVEL_LABELS[levelKey] || ROADMAP_LEVEL_LABELS.beginner;
}

function getRoadmapSkillKey(skill) {
    return skillPricing.resolveSkillKey(skill || '')
        || String(skill || 'skill').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        || 'skill';
}

function getRoadmapSkillTitle(skill) {
    return String(skill || 'Skill')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getRoadmapCategory(skill) {
    const value = String(skill || '').toLowerCase();
    if (/(python|javascript|typescript|java|react|node|html|css|sql|c\+\+|go|rust|php|django|flask)/.test(value)) return 'programming';
    if (/(figma|design|photoshop|illustrator|ui|ux|blender|animation)/.test(value)) return 'design';
    if (/(english|french|spanish|german|japanese|hindi|language|speaking|grammar)/.test(value)) return 'language';
    if (/(data|machine learning|ml|ai|analytics|statistics)/.test(value)) return 'data';
    return 'general';
}

function buildFallbackRoadmap(skill, levelKey) {
    const skillTitle = getRoadmapSkillTitle(skill);
    const category = getRoadmapCategory(skillTitle);
    const templates = {
        programming: {
            beginner: {
                weeks: ['Set up tools and environment', 'Learn core syntax and data types', 'Practice control flow and functions', 'Work with files, markup, or APIs', 'Build one guided mini project', 'Ship a simple independent project'],
                syllabus: ['Tooling and environment basics', skillTitle + ' syntax essentials', 'Core problem-solving patterns', 'Debugging common mistakes', 'Mini project planning', 'Project presentation and next steps']
            },
            intermediate: {
                weeks: ['Review advanced fundamentals', 'Design cleaner project structure', 'Use testing and debugging workflows', 'Optimize performance and maintainability', 'Build a capstone project', 'Prepare for advanced specialization'],
                syllabus: ['Architecture choices in ' + skillTitle, 'Testing and debugging strategy', 'Performance and optimization', 'Code quality and maintainability', 'Capstone planning and delivery', 'Next specialization paths']
            },
            advanced: {
                weeks: ['Design production-grade architecture', 'Master advanced tooling and automation', 'Apply testing, profiling, and observability', 'Handle scale, security, and edge cases', 'Ship an advanced capstone with deployment', 'Prepare for expert specialization or interviews'],
                syllabus: ['Production architecture for ' + skillTitle, 'Advanced automation and workflows', 'Profiling and deep debugging', 'Security and reliability patterns', 'Deployment and scale considerations', 'Senior-level capstone review']
            }
        },
        design: {
            beginner: {
                weeks: ['Learn the interface and design workflow', 'Study typography, color, and spacing', 'Practice layout and hierarchy', 'Create simple reusable components', 'Rebuild an existing screen', 'Design one full beginner project'],
                syllabus: ['Design tool fundamentals', 'Visual hierarchy basics', 'Color and typography practice', 'Component thinking', 'Redesign exercise', 'Portfolio presentation']
            },
            intermediate: {
                weeks: ['Design with systems thinking', 'Handle complex user journeys', 'Improve accessibility and consistency', 'Prototype advanced interactions', 'Build a capstone case study', 'Prepare for interviews or client delivery'],
                syllabus: ['Design system structure', 'Accessibility reviews', 'Advanced prototyping', 'Stakeholder communication', 'Capstone delivery', 'Portfolio and interview refinement']
            },
            advanced: {
                weeks: ['Build robust design systems', 'Solve multi-surface user journeys', 'Lead accessibility and consistency reviews', 'Prototype nuanced product interactions', 'Run a senior-level case study', 'Prepare for design leadership or client delivery'],
                syllabus: ['Design system governance', 'Complex product flows', 'Accessibility at scale', 'Advanced prototyping systems', 'Stakeholder alignment and critique', 'Senior portfolio case study']
            }
        },
        language: {
            beginner: {
                weeks: ['Build your core vocabulary base', 'Practice pronunciation and listening', 'Learn essential grammar structures', 'Use the language in short conversations', 'Write simple personal responses', 'Hold a beginner conversation confidently'],
                syllabus: ['Vocabulary starter pack', 'Pronunciation drills', 'Essential grammar patterns', 'Listening practice', 'Speaking prompts', 'Simple writing tasks']
            },
            intermediate: {
                weeks: ['Strengthen fluency under pressure', 'Expand vocabulary by theme', 'Improve advanced grammar accuracy', 'Discuss opinions and explain ideas', 'Practice real-world speaking scenarios', 'Prepare for long-form conversation or exams'],
                syllabus: ['Fluency practice', 'Advanced vocabulary growth', 'Accuracy and correction', 'Opinion speaking', 'Listening to native-speed content', 'Exam or conversation prep']
            },
            advanced: {
                weeks: ['Speak with near-native fluency goals', 'Master nuance, idioms, and tone', 'Debate and explain complex topics', 'Analyze advanced written and spoken content', 'Practice professional or academic scenarios', 'Prepare for certification or real-world mastery'],
                syllabus: ['Nuance and idiomatic usage', 'Advanced listening comprehension', 'Formal and informal tone control', 'Debate and discussion skills', 'Professional or academic communication', 'High-level fluency review']
            }
        },
        data: {
            beginner: {
                weeks: ['Set up your data workflow', 'Understand datasets and basic analysis', 'Learn core formulas or syntax', 'Create first visualizations', 'Run one guided analysis project', 'Present your findings clearly'],
                syllabus: ['Data workflow basics', 'Core analysis concepts', 'Cleaning and preparation', 'Simple visualization', 'Guided analysis project', 'Insight communication']
            },
            intermediate: {
                weeks: ['Review advanced analysis concepts', 'Build a stronger workflow', 'Use validation and testing', 'Optimize dashboards or models', 'Deliver a capstone project', 'Prepare for specialization or interviews'],
                syllabus: ['Advanced analytics workflow', 'Validation and testing', 'Model or dashboard optimization', 'Capstone delivery', 'Insight communication', 'Interview-ready project review']
            },
            advanced: {
                weeks: ['Architect end-to-end analysis workflows', 'Handle large-scale or messy datasets', 'Validate advanced models and assumptions', 'Optimize dashboards, models, or pipelines', 'Deliver an advanced capstone with business impact', 'Prepare for senior analytics or ML specialization'],
                syllabus: ['End-to-end analytics systems', 'Large-scale data handling', 'Advanced validation strategies', 'Pipeline and dashboard optimization', 'Business-impact storytelling', 'Senior-level capstone review']
            }
        },
        general: {
            beginner: {
                weeks: ['Understand the basics', 'Practice core concepts', 'Apply them with guidance', 'Build confidence through repetition', 'Create one small project', 'Review and plan the next step'],
                syllabus: ['Core fundamentals', 'Guided practice', 'Simple exercises', 'Mini project', 'Feedback review', 'Next-step plan']
            },
            intermediate: {
                weeks: ['Strengthen advanced concepts', 'Handle more complex tasks', 'Build consistency and speed', 'Complete a capstone-style project', 'Review quality and polish', 'Plan your specialization path'],
                syllabus: ['Advanced concept review', 'Complex practice tasks', 'Capstone delivery', 'Quality improvement', 'Performance and polish', 'Specialization planning']
            },
            advanced: {
                weeks: ['Master higher-order concepts', 'Solve expert-level scenarios', 'Build systems with strong quality standards', 'Deliver a substantial capstone project', 'Refine performance and decision-making', 'Plan your expert specialization path'],
                syllabus: ['Expert concept review', 'Advanced scenario practice', 'Systems thinking and quality', 'Capstone execution', 'Performance refinement', 'Expert roadmap planning']
            }
        }
    };
    const templateGroup = templates[category] || templates.general;
    const template = templateGroup[levelKey] || templateGroup.beginner;
    const weeks = template.weeks.map((label, index) => ({
        label: label.replace(/^Learn /i, index === 0 ? 'Learn ' : 'Practice '),
        state: index === 0 ? 'active' : 'pending'
    }));
    const syllabus = template.syllabus.map((text) => ({ done: false, text: text.includes(skillTitle) ? text : `${skillTitle}: ${text}` }));
    return {
        skill: skillTitle,
        level: formatRoadmapLevel(levelKey),
        source: 'fallback',
        pct: 0,
        weeks,
        syllabus
    };
}

function sanitizeRoadmapPayload(skill, levelKey, rawRoadmap, source) {
    const fallback = buildFallbackRoadmap(skill, levelKey);
    const rawWeeks = Array.isArray(rawRoadmap?.weeks) ? rawRoadmap.weeks : fallback.weeks;
    const rawSyllabus = Array.isArray(rawRoadmap?.syllabus) ? rawRoadmap.syllabus : fallback.syllabus;
    const weeks = rawWeeks
        .map((week, index) => {
            const labelSource = typeof week === 'string'
                ? week
                : (week?.label || week?.title || week?.name || '');
            const label = sanitize(labelSource, 120, 'roadmap week').value || fallback.weeks[index % fallback.weeks.length].label;
            const requestedState = String(typeof week === 'string' ? '' : (week?.state || '')).toLowerCase();
            const state = ['done', 'active', 'pending'].includes(requestedState)
                ? requestedState
                : (index === 0 ? 'active' : 'pending');
            return { label, state };
        })
        .filter((week) => !!week.label)
        .slice(0, 8);
    if (!weeks.length) {
        fallback.weeks.forEach((week) => weeks.push(week));
    }
    if (!weeks.some((week) => week.state === 'active') && !weeks.some((week) => week.state === 'done')) {
        weeks[0].state = 'active';
    }
    const syllabus = rawSyllabus
        .map((item, index) => {
            const textSource = typeof item === 'string' ? item : (item?.text || item?.label || '');
            const text = sanitize(textSource, 160, 'roadmap syllabus item').value || fallback.syllabus[index % fallback.syllabus.length].text;
            return {
                done: !!(typeof item === 'object' && item?.done),
                text
            };
        })
        .filter((item) => !!item.text)
        .slice(0, 10);
    if (!syllabus.length) {
        fallback.syllabus.forEach((item) => syllabus.push(item));
    }
    const completedWeeks = weeks.filter((week) => week.state === 'done').length;
    return {
        skill: getRoadmapSkillTitle(skill),
        level: formatRoadmapLevel(levelKey),
        source: source || 'fallback',
        pct: Math.round((completedWeeks / weeks.length) * 100),
        weeks,
        syllabus
    };
}

async function generateRoadmapWithGroq(skill, levelKey) {
    if (!process.env.GROQ_API_KEY) return null;
    const levelLabel = formatRoadmapLevel(levelKey);
    const prompt = `Create a focused learning roadmap for "${skill}" at the "${levelLabel}" level.

Return ONLY valid JSON with this exact shape:
{
  "weeks": [
    { "label": "Week focus", "state": "active" },
    { "label": "Week focus", "state": "pending" }
  ],
  "syllabus": [
    "Learning item 1",
    "Learning item 2"
  ]
}

Requirements:
- 6 weeks exactly
- 6 to 8 syllabus items
- Make the roadmap specific to ${skill}
- Make it appropriate for ${levelLabel}
- Use only "active" for the first week and "pending" for the rest
- No markdown fences`;
    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content: 'You create concise study roadmaps and always return valid JSON only.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.4,
            max_tokens: 1200
        },
        {
            headers: {
                Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 20000
        }
    );
    const aiText = String(response?.data?.choices?.[0]?.message?.content || '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
    return aiText ? JSON.parse(aiText) : null;
}

function getCreditSnapshot(profile) {
    return {
        available: Math.max(0, Number(profile?.creditBalance || 0)),
        held: Math.max(0, Number(profile?.heldCreditBalance || 0))
    };
}

function getSessionEndDate(session) {
    const startDate = session?.startAt?.toDate ? session.startAt.toDate() : new Date(session?.startAt);
    if (Number.isNaN(startDate.getTime())) return null;
    return new Date(startDate.getTime() + (Math.max(15, Number(session?.durationMinutes || 60)) * 60 * 1000));
}

function getSessionResponseOpenDate(session) {
    const startDate = session?.startAt?.toDate ? session.startAt.toDate() : new Date(session?.startAt);
    if (Number.isNaN(startDate.getTime())) return null;
    return new Date(startDate.getTime() + POST_SESSION_RESPONSE_DELAY_MS);
}

function getLearnerResponseDueDate(session) {
    const endDate = getSessionEndDate(session);
    if (!endDate) return null;
    return new Date(endDate.getTime() + LEARNER_CONFIRMATION_WINDOW_MS);
}

function describeSessionTopic(session) {
    return session?.topic || session?.skillRequested || 'your session';
}

function buildSessionSettlementFields(session) {
    const paid = isPaidSession(session);
    const heldCredits = paid ? getSessionCreditAmount(session) : 0;
    return {
        creditStatus: paid ? 'held' : 'not_applicable',
        settlementStatus: 'scheduled',
        teacherAction: 'pending',
        studentAction: 'pending',
        teacherResponse: null,
        studentResponse: null,
        responseDueAt: null,
        heldCredits,
        releasedCredits: 0,
        refundedCredits: 0,
        creditReviewCaseId: null,
        creditsTransferred: false
    };
}

function buildTransactionDescription(type, session, actorProfile, partnerProfile, amount) {
    const topic = describeSessionTopic(session);
    if (type === 'hold') return `Reserved ${amount} credits for ${topic}`;
    if (type === 'spend') return `Completed ${topic} with ${getDisplayName(actorProfile, 'your teacher')}`;
    if (type === 'earn') return `Earned credits for ${topic} with ${getDisplayName(actorProfile, 'your learner')}`;
    if (type === 'refund') return `Refunded credits for ${topic}`;
    if (type === 'penalty') return `Late cancel or no-show penalty for ${topic}`;
    if (type === 'manual_grant') return `Reviewer top-up${partnerProfile ? ` from ${getDisplayName(partnerProfile, 'reviewer')}` : ''}`;
    return topic;
}

function createQueuedTransaction(tx, db, payload) {
    tx.set(db.collection('transactions').doc(), {
        ...payload,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

function createQueuedNotification(tx, db, payload) {
    tx.set(db.collection('notifications').doc(), {
        ...payload,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

async function reserveCreditsForScheduledSession({
    db,
    learnerUid,
    amount,
    actorUid
}) {
    if (amount <= 0) {
        return { availableAfter: 0, heldAfter: 0 };
    }
    const learnerRef = db.collection('users').doc(learnerUid);
    return db.runTransaction(async (tx) => {
        const learnerSnap = await tx.get(learnerRef);
        if (!learnerSnap.exists) {
            const err = new Error('Learner profile not found.');
            err.statusCode = 404;
            throw err;
        }
        const learnerData = learnerSnap.data() || {};
        const credits = getCreditSnapshot(learnerData);
        if (credits.available < amount) {
            const shortage = amount - credits.available;
            const actorIsLearner = !!(actorUid && actorUid === learnerUid);
            const err = new Error(
                actorIsLearner
                    ? `You need ${shortage} more credits to book this paid session. Earn more credits or switch to a demo session.`
                    : `The student needs ${shortage} more credits to book this paid session. They can earn more credits or switch to a demo session.`
            );
            err.statusCode = 400;
            throw err;
        }
        tx.set(learnerRef, {
            creditBalance: credits.available - amount,
            heldCreditBalance: credits.held + amount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return {
            availableAfter: credits.available - amount,
            heldAfter: credits.held + amount
        };
    });
}

async function rollbackScheduledCreditHold({
    db,
    learnerUid,
    amount
}) {
    if (amount <= 0) return;
    const learnerRef = db.collection('users').doc(learnerUid);
    await db.runTransaction(async (tx) => {
        const learnerSnap = await tx.get(learnerRef);
        if (!learnerSnap.exists) return;
        const learnerData = learnerSnap.data() || {};
        const credits = getCreditSnapshot(learnerData);
        tx.set(learnerRef, {
            creditBalance: credits.available + amount,
            heldCreditBalance: Math.max(0, credits.held - amount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
}

async function createCreditReviewCase({
    db,
    sessionRef,
    session,
    caseType,
    openedByUid,
    openedByRole,
    issueReason,
    openedAfterTimeout = false,
    recommendedSettlement = 'manual_review'
}) {
    if (session.creditReviewCaseId) {
        const existingRef = db.collection('creditReviewCases').doc(session.creditReviewCaseId);
        await existingRef.set({
            status: 'pending',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            caseType,
            issueReason: issueReason || session.issueReason || '',
            openedByUid,
            openedByRole,
            creditsHeld: Number(session.heldCredits || 0),
            teacherResponse: session.teacherResponse || null,
            studentResponse: session.studentResponse || null,
            teacherAction: session.teacherAction || 'pending',
            studentAction: session.studentAction || 'pending',
            openedAfterTimeout,
            recommendedSettlement,
            noShowType: session.noShowType || null
        }, { merge: true });
        await sessionRef.set({
            settlementStatus: 'review_pending',
            status: 'disputed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return session.creditReviewCaseId;
    }

    const caseRef = db.collection('creditReviewCases').doc();
    await caseRef.set({
        sessionId: sessionRef.id,
        teacherUid: session.teacherUid,
        studentUid: session.studentUid,
        teacherName: session.teacherName || '',
        studentName: session.studentName || '',
        topic: describeSessionTopic(session),
        caseType,
        status: 'pending',
        creditsHeld: Number(session.heldCredits || 0),
        issueReason: issueReason || '',
        openedByUid,
        openedByRole,
        teacherResponse: session.teacherResponse || null,
        studentResponse: session.studentResponse || null,
        teacherAction: session.teacherAction || 'pending',
        studentAction: session.studentAction || 'pending',
        openedAfterTimeout,
        recommendedSettlement,
        noShowType: session.noShowType || null,
        openedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        reviewNotes: ''
    });
    await sessionRef.set({
        creditReviewCaseId: caseRef.id,
        settlementStatus: 'review_pending',
        status: 'disputed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return caseRef.id;
}

async function applyCompletedSessionRatings(tx, db, sessionRef, session) {
    const ratings = session.ratings || {};
    const applied = session.ratingStatsApplied || {};
    const updates = {};

    if (ratings[session.studentUid] && !applied[session.studentUid]) {
        const teacherRef = db.collection('users').doc(session.teacherUid);
        const teacherSnap = await tx.get(teacherRef);
        const teacherData = teacherSnap.exists ? teacherSnap.data() || {} : {};
        const currentRating = Number(teacherData?.stats?.teacherAverageRating || 0);
        const totalRatings = Number(teacherData?.stats?.teacherTotalRatings || 0);
        const learnerRating = Number(ratings[session.studentUid].rating || 0);
        const newAverage = ((currentRating * totalRatings) + learnerRating) / (totalRatings + 1);
        tx.set(teacherRef, {
            stats: {
                averageRating: newAverage,
                totalRatings: totalRatings + 1,
                teacherAverageRating: newAverage,
                teacherTotalRatings: totalRatings + 1
            }
        }, { merge: true });
        updates[`ratingStatsApplied.${session.studentUid}`] = true;
    }

    if (ratings[session.teacherUid] && !applied[session.teacherUid]) {
        const learnerRef = db.collection('users').doc(session.studentUid);
        const learnerSnap = await tx.get(learnerRef);
        const learnerData = learnerSnap.exists ? learnerSnap.data() || {} : {};
        const currentRating = Number(learnerData?.stats?.learnerAverageRating || 0);
        const totalRatings = Number(learnerData?.stats?.learnerTotalRatings || 0);
        const teacherRating = Number(ratings[session.teacherUid].rating || 0);
        const newAverage = ((currentRating * totalRatings) + teacherRating) / (totalRatings + 1);
        tx.set(learnerRef, {
            stats: {
                learnerAverageRating: newAverage,
                learnerTotalRatings: totalRatings + 1
            }
        }, { merge: true });
        updates[`ratingStatsApplied.${session.teacherUid}`] = true;
    }

    const completionApplied = !!session.completionStatsApplied;
    if (!completionApplied) {
        tx.set(db.collection('users').doc(session.studentUid), {
            stats: {
                sessionsCompleted: admin.firestore.FieldValue.increment(1)
            }
        }, { merge: true });
        const teacherStatsPatch = {
            sessionsCompleted: admin.firestore.FieldValue.increment(1),
            sessionsTaught: admin.firestore.FieldValue.increment(1)
        };
        if (isPaidSession(session)) {
            teacherStatsPatch.paidSessionsTaught = admin.firestore.FieldValue.increment(1);
        }
        tx.set(db.collection('users').doc(session.teacherUid), {
            stats: teacherStatsPatch
        }, { merge: true });
        updates.completionStatsApplied = true;
    }

    if (Object.keys(updates).length) {
        tx.set(sessionRef, updates, { merge: true });
    }
}

async function settleHeldCredits(sessionId, options) {
    const db = getAdminDb();
    const sessionRef = db.collection('sessions').doc(sessionId);
    let teacherUidToSync = null;
    let learnerUidToSync = null;
    let settlementSummary = null;

    await db.runTransaction(async (tx) => {
        const sessionSnap = await tx.get(sessionRef);
        if (!sessionSnap.exists) {
            const err = new Error('Session not found.');
            err.statusCode = 404;
            throw err;
        }
        const session = { id: sessionSnap.id, ...sessionSnap.data() };
        teacherUidToSync = session.teacherUid;
        learnerUidToSync = session.studentUid;
        const isPaid = isPaidSession(session);
        const heldCredits = Math.max(0, Number(session.heldCredits || getSessionCreditAmount(session)));

        if (isPaid && !['held', 'manual'].includes(session.creditStatus || 'held') && options.force !== true) {
            const err = new Error('This session does not have held credits to settle.');
            err.statusCode = 409;
            throw err;
        }
        if (
            ['completed', 'cancelled', 'no-show'].includes(session.status)
            && (
                session.settlementStatus === 'settled'
                || ['released', 'refunded', 'split', 'manual'].includes(session.creditStatus)
            )
        ) {
            const err = new Error('This session has already been settled.');
            err.statusCode = 409;
            throw err;
        }

        const learnerRef = db.collection('users').doc(session.studentUid);
        const teacherRef = db.collection('users').doc(session.teacherUid);
        const learnerSnap = await tx.get(learnerRef);
        const teacherSnap = await tx.get(teacherRef);
        const learnerData = learnerSnap.exists ? learnerSnap.data() || {} : {};
        const teacherData = teacherSnap.exists ? teacherSnap.data() || {} : {};
        const learnerCredits = getCreditSnapshot(learnerData);
        const teacherCredits = getCreditSnapshot(teacherData);

        if (isPaid && learnerCredits.held < heldCredits) {
            const err = new Error('Held credit mismatch detected for this session. Please send it to reviewer credit ops.');
            err.statusCode = 409;
            throw err;
        }

        const payoutToTeacher = Math.max(0, Number(options.payoutToTeacher || 0));
        const refundToLearner = Math.max(0, Number(options.refundToLearner || 0));
        if (isPaid && payoutToTeacher + refundToLearner > heldCredits) {
            const err = new Error('Settlement amounts exceed held credits.');
            err.statusCode = 400;
            throw err;
        }

        const nextLearnerHeld = Math.max(0, learnerCredits.held - heldCredits);
        const nextLearnerAvailable = learnerCredits.available + refundToLearner;
        const nextTeacherAvailable = teacherCredits.available + payoutToTeacher;

        const learnerUserPatch = {
            creditBalance: nextLearnerAvailable,
            heldCreditBalance: nextLearnerHeld,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (options.bumpLearnerNoShow) {
            learnerUserPatch.stats = { noShowCount: admin.firestore.FieldValue.increment(1) };
        }
        tx.set(learnerRef, learnerUserPatch, { merge: true });

        const teacherUserPatch = {
            creditBalance: nextTeacherAvailable,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (options.bumpTeacherNoShow) {
            teacherUserPatch.stats = { noShowCount: admin.firestore.FieldValue.increment(1) };
        }
        tx.set(teacherRef, teacherUserPatch, { merge: true });

        const sessionPatch = {
            status: options.status || session.status,
            settlementStatus: options.settlementStatus || 'settled',
            creditStatus: options.creditStatus || (isPaid ? (refundToLearner && payoutToTeacher ? 'split' : (refundToLearner ? 'refunded' : 'released')) : 'not_applicable'),
            heldCredits: isPaid ? heldCredits : 0,
            releasedCredits: payoutToTeacher,
            refundedCredits: refundToLearner,
            creditsTransferred: payoutToTeacher > 0,
            noShowType: options.noShowType || session.noShowType || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (options.teacherAction) sessionPatch.teacherAction = options.teacherAction;
        if (options.studentAction) sessionPatch.studentAction = options.studentAction;
        if (options.caseId !== undefined) sessionPatch.creditReviewCaseId = options.caseId;
        if (options.completedBy) sessionPatch.completedBy = options.completedBy;
        if (options.completedAt !== false) sessionPatch.completedAt = admin.firestore.FieldValue.serverTimestamp();
        tx.set(sessionRef, sessionPatch, { merge: true });

        let sessionForSettlement = { ...session, ...sessionPatch };

        if (options.applyRatingsOnCompletion) {
            const recoveredRatings = buildRecoveredRatingsPayload(sessionForSettlement);
            if (Object.keys(recoveredRatings.patch).length) {
                tx.set(sessionRef, recoveredRatings.patch, { merge: true });
            }
        }

        if (isPaid && payoutToTeacher > 0) {
            const learnerType = options.learnerTransactionType || 'spend';
            createQueuedTransaction(tx, db, {
                uid: session.studentUid,
                type: learnerType,
                amount: payoutToTeacher,
                description: options.learnerTransactionDescription || buildTransactionDescription(learnerType, session, teacherData, null, payoutToTeacher),
                category: 'session',
                relatedSessionId: sessionId,
                relatedUserId: session.teacherUid,
                balanceAfter: nextLearnerAvailable,
                heldBalanceAfter: nextLearnerHeld
            });
            createQueuedTransaction(tx, db, {
                uid: session.teacherUid,
                type: 'earn',
                amount: payoutToTeacher,
                description: options.teacherTransactionDescription || buildTransactionDescription('earn', session, learnerData, null, payoutToTeacher),
                category: 'session',
                relatedSessionId: sessionId,
                relatedUserId: session.studentUid,
                balanceAfter: nextTeacherAvailable,
                heldBalanceAfter: teacherCredits.held
            });
        }

        if (isPaid && refundToLearner > 0) {
            createQueuedTransaction(tx, db, {
                uid: session.studentUid,
                type: 'refund',
                amount: refundToLearner,
                description: options.refundDescription || buildTransactionDescription('refund', session, teacherData, null, refundToLearner),
                category: 'session',
                relatedSessionId: sessionId,
                relatedUserId: session.teacherUid,
                balanceAfter: nextLearnerAvailable,
                heldBalanceAfter: nextLearnerHeld
            });
        }

        const notifications = options.notifications || [];
        notifications.forEach((note) => {
            createQueuedNotification(tx, db, {
                uid: note.uid,
                type: note.type || 'session',
                title: note.title,
                message: note.message,
                relatedSessionId: sessionId
            });
        });

        settlementSummary = {
            ok: true,
            sessionId,
            payoutToTeacher,
            refundToLearner,
            status: sessionPatch.status,
            settlementStatus: sessionPatch.settlementStatus,
            creditStatus: sessionPatch.creditStatus
        };
    });

    await Promise.all([
        teacherUidToSync ? syncUserDerivedStats(teacherUidToSync) : Promise.resolve(),
        learnerUidToSync ? syncUserDerivedStats(learnerUidToSync) : Promise.resolve()
    ]);
    if (teacherUidToSync) await syncTeacherReputation(teacherUidToSync);

    return settlementSummary || { ok: true, sessionId };
}

async function buildTeacherReviewSnapshot(uid) {
    const db = getAdminDb();
    const profile = await getUserProfileOrThrow(uid);
    const sessionsSnap = await db.collection('sessions').where('teacherUid', '==', uid).get();
    const sessions = [];
    sessionsSnap.forEach(docSnap => sessions.push({ id: docSnap.id, ...docSnap.data() }));

    const completedSessions = sessions.filter(isSettledCompletedSession);
    const recentFeedback = [];
    let completedDemoSessions = 0;
    let completedPaidSessions = 0;
    let writtenLearnerFeedbackCount = 0;
    let totalRatings = 0;
    let ratingTotal = 0;

    completedSessions.forEach(session => {
        if (isPaidSession(session)) completedPaidSessions += 1;
        else completedDemoSessions += 1;

        const learnerUid = session.studentUid || null;
        const learnerFeedback = learnerUid ? getCanonicalOrDerivedRatingEntry(session, learnerUid) : null;
        if (!learnerFeedback) return;

        const feedbackText = typeof learnerFeedback.feedback === 'string' ? learnerFeedback.feedback.trim() : '';
        const ratingValue = Number(learnerFeedback.rating || 0);
        if (ratingValue > 0) {
            totalRatings += 1;
            ratingTotal += ratingValue;
        }
        if (feedbackText) writtenLearnerFeedbackCount += 1;

        recentFeedback.push({
            sessionId: session.id,
            topic: session.topic || 'SkillSwap session',
            rating: ratingValue,
            feedback: feedbackText,
            ratedAt: learnerFeedback.ratedAt || null,
            learnerUid,
            learnerName: session.partnerName || null
        });
    });

    recentFeedback.sort((a, b) => toMillis(b.ratedAt) - toMillis(a.ratedAt));

    const teachSkills = Array.isArray(profile.skills?.toTeach) ? profile.skills.toTeach : [];
    const averageRating = totalRatings ? ratingTotal / totalRatings : Number(profile.stats?.averageRating || 0);
    const completedTeachingSessions = completedSessions.length;
    const disputeCount = sessions.filter(session => session.status === 'disputed' || session.settlementStatus === 'review_pending' || !!session.creditReviewCaseId).length;
    const noShowCount = sessions.filter(session => session.status === 'no-show' && session.noShowType === 'teacher').length;
    const vStatus = (profile.verification?.status || '').toLowerCase().trim();
    const aiVerified = vStatus === 'verified';
    const badgeTier = getBadgeTier(completedPaidSessions);
    const eligibleForHumanReview = aiVerified
        && teachSkills.length > 0
        && completedTeachingSessions >= 5;

    return {
        teacher: {
            uid,
            fullName: getDisplayName(profile),
            email: profile.email || '',
            photoURL: profile.photoURL || '',
            teachSkills: teachSkills.map(skill => typeof skill === 'string' ? skill : skill.name).filter(Boolean)
        },
        verification: profile.verification || {},
        humanVerification: profile.humanVerification || { status: 'not-requested' },
        teacherReputation: {
            completedTeachingSessions,
            completedDemoSessions,
            completedPaidSessions,
            writtenLearnerFeedbackCount,
            averageRating,
            totalRatings,
            noShowCount,
            disputeCount,
            badgeTier,
            eligibleForHumanReview,
            requirementProgress: {
                aiVerified,
                teachSkillsCount: teachSkills.length,
                sessionsCompleted: completedTeachingSessions,
                sessionsRequired: 5
            }
        },
        recentFeedback: recentFeedback.slice(0, 5)
    };
}

function getEligibilityErrorMessage(summary) {
    const missing = [];
    if (!summary.teacherReputation.requirementProgress.aiVerified) missing.push('Basic verification');
    if (summary.teacherReputation.completedTeachingSessions < 5) missing.push('5 completed teaching sessions');
    return missing.length
        ? `You are not eligible yet. You still need ${missing.join(', ')}.`
        : 'You are not eligible for human verification yet.';
}

async function syncTeacherReputation(uid) {
    const db = getAdminDb();
    const summary = await buildTeacherReviewSnapshot(uid);
    await db.collection('users').doc(uid).set({
        teacherReputation: summary.teacherReputation,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return summary.teacherReputation;
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
    const sessionRef = db.collection('sessions').doc();
    const creditsAgreed = normalizeAcceptedConnectionCredits(acceptedConnection, teacherProfile);
    const canonicalRequestId = acceptedConnection.requestId || acceptedConnection.id;
    const canonicalConnectionId = acceptedConnection.connectionId || canonicalRequestId;
    const paidSession = acceptedConnection.sessionType !== 'demo' && creditsAgreed > 0;
    const holdResult = paidSession
        ? await reserveCreditsForScheduledSession({
            db,
            learnerUid: acceptedConnection.studentUid,
            amount: creditsAgreed,
            actorUid: organizerUid
        })
        : null;

    let event = null;

    try {
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

        event = eventResponse.data;
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
            teacherName: getDisplayName(teacherProfile, 'Teacher'),
            studentName: getDisplayName(studentProfile, 'Learner'),
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
            sessionType: acceptedConnection.sessionType || 'credit',
            creditsAgreed,
            googleCalendarConnectionUid: organizerUid,
            learnerResponseDueAt: admin.firestore.Timestamp.fromDate(new Date(endDate.getTime() + LEARNER_CONFIRMATION_WINDOW_MS)),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            ...buildSessionSettlementFields({
                sessionType: acceptedConnection.sessionType || 'credit',
                creditsAgreed,
                durationMinutes: minutes
            })
        };

        const batch = db.batch();
        batch.set(sessionRef, sessionPayload);
        batch.set(db.collection('lessonConnections').doc(canonicalConnectionId), {
            requestId: canonicalRequestId,
            teacherUid: acceptedConnection.teacherUid,
            studentUid: acceptedConnection.studentUid,
            teacherName: getDisplayName(teacherProfile, 'Teacher'),
            studentName: getDisplayName(studentProfile, 'Learner'),
            skillRequested: acceptedConnection.skillRequested || 'General guidance',
            sessionType: acceptedConnection.sessionType || 'credit',
            creditsOffered: creditsAgreed,
            status: 'accepted',
            participants: [acceptedConnection.teacherUid, acceptedConnection.studentUid],
            acceptedAt: acceptedConnection.acceptedAt || admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        if (acceptedConnection.requestExists && canonicalRequestId) {
            batch.set(db.collection('lessonRequests').doc(canonicalRequestId), {
                creditsOffered: creditsAgreed,
                status: 'accepted',
                respondedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

        if (paidSession && holdResult) {
            batch.set(db.collection('transactions').doc(), {
                uid: acceptedConnection.studentUid,
                type: 'hold',
                amount: creditsAgreed,
                description: `Reserved ${creditsAgreed} credits for ${topic || acceptedConnection.skillRequested || 'your session'}`,
                category: 'session',
                relatedSessionId: sessionRef.id,
                relatedUserId: acceptedConnection.teacherUid,
                balanceAfter: holdResult.availableAfter,
                heldBalanceAfter: holdResult.heldAfter,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        batch.set(db.collection('notifications').doc(), {
            uid: acceptedConnection.teacherUid,
            type: 'session',
            title: 'Session Scheduled',
            message: `${organizerName} scheduled "${topic || acceptedConnection.skillRequested || 'your session'}" for ${startDate.toLocaleString()}.${paidSession ? ` ${creditsAgreed} credits are now held for settlement.` : ''}`,
            sessionId: sessionRef.id,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        batch.set(db.collection('notifications').doc(), {
            uid: acceptedConnection.studentUid,
            type: 'session',
            title: 'Session Scheduled',
            message: `${organizerName} scheduled "${topic || acceptedConnection.skillRequested || 'your session'}" for ${startDate.toLocaleString()}.${paidSession ? ` ${creditsAgreed} credits are now held for this booking.` : ''}`,
            sessionId: sessionRef.id,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await batch.commit();

        try {
            await saveGoogleConnection(organizerUid, {
                connected: true,
                email: connection.email || organizerEmail,
                displayName: connection.displayName || organizerName,
                lastScheduledAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (connectionErr) {
            console.error('[google-calendar connection save]', connectionErr.message);
        }

        return {
            sessionId: sessionRef.id,
            creditsAgreed,
            meetUrl,
            calendarUrl: event.htmlLink || null,
            calendarEventId: event.id,
            startAt: startDate.toISOString(),
            durationMinutes: minutes
        };
    } catch (err) {
        if (paidSession) {
            try {
                await rollbackScheduledCreditHold({
                    db,
                    learnerUid: acceptedConnection.studentUid,
                    amount: creditsAgreed
                });
            } catch (rollbackErr) {
                console.error('[schedule-google-meet rollback]', rollbackErr.message);
            }
        }
        if (event?.id) {
            try {
                await calendar.events.delete({
                    calendarId: 'primary',
                    eventId: event.id,
                    sendUpdates: 'all'
                });
            } catch (calendarCleanupErr) {
                console.error('[schedule-google-meet cleanup]', calendarCleanupErr.message);
            }
        }
        throw err;
    }
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

async function syncCompletedSessionEffects(sessionId) {
    const db = getAdminDb();
    const sessionRef = db.collection('sessions').doc(sessionId);
    let teacherUid = null;
    let learnerUid = null;
    await db.runTransaction(async (tx) => {
        const sessionSnap = await tx.get(sessionRef);
        if (!sessionSnap.exists) return;
        let session = { id: sessionSnap.id, ...sessionSnap.data() };
        teacherUid = session.teacherUid;
        learnerUid = session.studentUid;
        if (!isSettledCompletedSession(session)) return;
        const recoveredRatings = buildRecoveredRatingsPayload(session);
        if (Object.keys(recoveredRatings.patch).length) {
            tx.set(sessionRef, recoveredRatings.patch, { merge: true });
        }
        tx.set(sessionRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    await Promise.all([
        teacherUid ? syncUserDerivedStats(teacherUid) : Promise.resolve(),
        learnerUid ? syncUserDerivedStats(learnerUid) : Promise.resolve()
    ]);
    if (teacherUid) await syncTeacherReputation(teacherUid);
}

function buildRatingPatch(callerUid, rating, feedback) {
    return {
        ratings: {
            [callerUid]: {
                rating,
                feedback: feedback || '',
                ratedAt: admin.firestore.FieldValue.serverTimestamp()
            }
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
}

function assertCanRateSession(session, callerUid) {
    if (session.ratings && session.ratings[callerUid]) {
        const err = new Error('You already submitted feedback for this session.');
        err.statusCode = 409;
        throw err;
    }
}

function buildOptionalRatingPatch(callerUid, rating, feedback) {
    const safeRating = Number(rating || 0);
    if (safeRating < 1 || safeRating > 5) {
        return {};
    }
    return buildRatingPatch(callerUid, safeRating, feedback);
}

async function saveLateReviewPatch(db, sessionRef, session, callerUid, rating, feedback) {
    const existing = session?.ratings?.[callerUid] || null;
    if (existing) {
        const existingRating = Number(existing.rating || 0);
        const existingFeedback = typeof existing.feedback === 'string' ? existing.feedback.trim() : '';
        if (existingRating > 0 && existingFeedback) {
            const err = new Error('You already submitted feedback for this session.');
            err.statusCode = 409;
            throw err;
        }
        const safeFeedback = typeof feedback === 'string' ? feedback.trim() : '';
        if (!safeFeedback) {
            const err = new Error('Please add written feedback before submitting.');
            err.statusCode = 400;
            throw err;
        }
        const ratingToKeep = existingRating > 0 ? existingRating : Number(rating || 0);
        if (ratingToKeep < 1 || ratingToKeep > 5) {
            const err = new Error('Rating must be between 1 and 5.');
            err.statusCode = 400;
            throw err;
        }
        await sessionRef.set({
            ratings: {
                [callerUid]: {
                    rating: ratingToKeep,
                    feedback: safeFeedback,
                    ratedAt: existing.ratedAt || admin.firestore.FieldValue.serverTimestamp()
                }
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return;
    }

    const safeRating = Number(rating || 0);
    if (safeRating < 1 || safeRating > 5) {
        const err = new Error('Rating must be between 1 and 5.');
        err.statusCode = 400;
        throw err;
    }
    await sessionRef.set(buildRatingPatch(callerUid, safeRating, feedback), { merge: true });
}

function normalizeParticipantActionToOutcome(role, action) {
    if (!action || action === 'pending') return 'pending';
    if (['completed', 'delivered', 'auto_completed', 'auto_released'].includes(action)) return 'completed';
    if (action === 'issue_reported') return 'issue';
    if (action === 'teacher_no_show') return 'teacher_no_show';
    if (action === 'student_no_show') return 'student_no_show';
    if (action === 'reviewer_resolved') return 'resolved';
    if (action === 'teacher_cancelled' || action === 'student_cancelled' || action === 'late_cancel') return 'cancelled';
    return role === 'teacher' ? action : action;
}

function getParticipantResponse(session, role) {
    const fieldName = role === 'teacher' ? 'teacherResponse' : 'studentResponse';
    const direct = session?.[fieldName];
    if (direct && direct.outcome) return direct;
    const action = role === 'teacher' ? session?.teacherAction : session?.studentAction;
    const outcome = normalizeParticipantActionToOutcome(role, action);
    if (outcome === 'pending') return null;
    return {
        outcome,
        reasonCode: '',
        note: '',
        rating: null,
        feedback: '',
        submittedAt: null
    };
}

function hasParticipantResponse(session, role) {
    const response = getParticipantResponse(session, role);
    return !!(response && response.outcome && response.outcome !== 'pending');
}

function buildParticipantResponse(outcome, options = {}) {
    const safeRating = Number(options.rating || 0);
    return {
        outcome,
        reasonCode: options.reasonCode || '',
        note: options.note || '',
        rating: safeRating >= 1 && safeRating <= 5 ? safeRating : null,
        feedback: options.feedback || '',
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
        submittedByUid: options.submittedByUid || null,
        bySystem: !!options.bySystem
    };
}

function getResponseDueTimestamp(session) {
    const dueDate = getLearnerResponseDueDate(session) || new Date(Date.now() + LEARNER_CONFIRMATION_WINDOW_MS);
    return admin.firestore.Timestamp.fromDate(dueDate);
}

function getConflictReviewCaseType(teacherOutcome, studentOutcome) {
    if (teacherOutcome === 'issue' || studentOutcome === 'issue') return 'session_issue_conflict';
    if (teacherOutcome === 'student_no_show' && studentOutcome === 'completed') return 'teacher_claimed_student_no_show';
    if (studentOutcome === 'teacher_no_show' && teacherOutcome === 'completed') return 'learner_claimed_teacher_no_show';
    if (teacherOutcome === 'student_no_show' || studentOutcome === 'teacher_no_show') return 'no_show_conflict';
    return 'session_conflict';
}

function getRecommendedSettlement(teacherOutcome, studentOutcome) {
    if (teacherOutcome === 'issue' || studentOutcome === 'issue') return 'manual_review';
    if (teacherOutcome === 'student_no_show' && studentOutcome === 'completed') return 'refund_or_split';
    if (studentOutcome === 'teacher_no_show' && teacherOutcome === 'completed') return 'refund_or_payout';
    if (teacherOutcome === 'student_no_show' || studentOutcome === 'teacher_no_show') return 'manual_review';
    return 'manual_review';
}

async function submitTeacherSessionOutcome(sessionId, callerUid, rating, feedback, reportIssue, issueReason, allowMissingRating = false) {
    const { db, sessionRef, session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    if (session.teacherUid !== callerUid) {
        const err = new Error('Only the teacher can use the teacher completion flow.');
        err.statusCode = 403;
        throw err;
    }
    const callerProfile = await getUserProfileOrThrow(callerUid);
    const settledCompleted = session.status === 'completed' && session.settlementStatus === 'settled';
    if (settledCompleted) {
        await saveLateReviewPatch(db, sessionRef, session, callerUid, allowMissingRating ? 0 : rating, feedback);
        await syncCompletedSessionEffects(sessionId);
        await db.collection('notifications').add({
            uid: session.studentUid,
            type: 'session-review',
            title: 'Teacher Shared Feedback',
            message: `${getDisplayName(callerProfile, 'Your teacher')} added feedback for ${describeSessionTopic(session)}.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { ok: true, outcome: 'review_added' };
    }
    if (hasParticipantResponse(session, 'teacher')) {
        const err = new Error('You already submitted your post-session response.');
        err.statusCode = 409;
        throw err;
    }

    if (!reportIssue) {
        assertCanRateSession(session, callerUid);
    }

    const teacherOutcome = reportIssue ? 'issue' : 'completed';
    const teacherIssueRating = reportIssue ? Number(rating || 0) : Number(rating || 0);
    const teacherResponse = buildParticipantResponse(teacherOutcome, {
        submittedByUid: callerUid,
        reasonCode: reportIssue ? issueReason : '',
        note: reportIssue ? (feedback || '') : '',
        rating: teacherIssueRating,
        feedback: feedback || ''
    });
    const ratingPatch = reportIssue ? {} : buildOptionalRatingPatch(callerUid, rating, feedback);
    const studentResponse = getParticipantResponse(session, 'student');
    const responseDueAt = session.responseDueAt || getResponseDueTimestamp(session);
    const basePatch = {
        ...ratingPatch,
        teacherAction: teacherOutcome === 'completed' ? 'completed' : 'issue_reported',
        teacherResponse,
        responseDueAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!studentResponse) {
        await sessionRef.set({
            ...basePatch,
            settlementStatus: 'awaiting_counterparty',
            status: 'awaiting_counterparty'
        }, { merge: true });
        await db.collection('notifications').add({
            uid: session.studentUid,
            type: 'session-awaiting-response',
            title: reportIssue ? 'Teacher Reported an Issue' : 'Teacher Submitted a Session Update',
            message: reportIssue
                ? `${getDisplayName(callerProfile, 'Your teacher')} reported an issue for ${describeSessionTopic(session)}. Submit your own outcome before the reviewer sees it.`
                : `${getDisplayName(callerProfile, 'Your teacher')} marked ${describeSessionTopic(session)} as completed. Submit your outcome to finalize the session.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { ok: true, outcome: 'awaiting_counterparty' };
    }

    if (teacherOutcome === 'completed' && studentResponse.outcome === 'completed') {
        await sessionRef.set(basePatch, { merge: true });
        if (isPaidSession(session)) {
            const amount = getSessionCreditAmount(session);
            await settleHeldCredits(sessionId, {
                payoutToTeacher: amount,
                refundToLearner: 0,
                status: 'completed',
                settlementStatus: 'settled',
                creditStatus: 'released',
                teacherAction: 'completed',
                studentAction: 'completed',
                completedBy: callerUid,
                applyRatingsOnCompletion: true,
                learnerTransactionType: 'spend',
                learnerTransactionDescription: `Released ${amount} held credits for ${describeSessionTopic(session)}`,
                teacherTransactionDescription: `Earned ${amount} credits for teaching ${describeSessionTopic(session)}`,
                notifications: [
                    {
                        uid: session.teacherUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)}. Held credits were released to you.`
                    },
                    {
                        uid: session.studentUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)} and the held credits were released.`
                    }
                ]
            });
        } else {
            await settleHeldCredits(sessionId, {
                force: true,
                payoutToTeacher: 0,
                refundToLearner: 0,
                status: 'completed',
                settlementStatus: 'settled',
                creditStatus: 'not_applicable',
                teacherAction: 'completed',
                studentAction: 'completed',
                completedBy: callerUid,
                applyRatingsOnCompletion: true,
                notifications: [
                    {
                        uid: session.studentUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)}.`
                    }
                ]
            });
        }
        return { ok: true, outcome: 'completed' };
    }

    const reviewPatch = {
        ...basePatch,
        settlementStatus: 'review_pending',
        status: 'disputed',
        disputeReason: reportIssue
            ? (issueReason || 'Teacher reported an issue')
            : 'Teacher submitted a conflicting session outcome'
    };
    await sessionRef.set(reviewPatch, { merge: true });
    const caseId = await createCreditReviewCase({
        db,
        sessionRef,
        session: { ...session, ...reviewPatch },
        caseType: getConflictReviewCaseType(teacherOutcome, studentResponse.outcome),
        openedByUid: callerUid,
        openedByRole: 'teacher',
        issueReason: reviewPatch.disputeReason,
        recommendedSettlement: getRecommendedSettlement(teacherOutcome, studentResponse.outcome)
    });
    await sessionRef.set({ creditReviewCaseId: caseId }, { merge: true });
    await db.collection('notifications').add({
        uid: session.studentUid,
        type: 'session-review-pending',
        title: 'Session Needs Review',
        message: `${getDisplayName(callerProfile, 'Your teacher')} submitted a conflicting outcome for ${describeSessionTopic(session)}. Credits stay frozen until review.`,
        sessionId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await syncTeacherReputation(session.teacherUid);
    return { ok: true, outcome: 'review_pending', caseId };
}

async function submitLearnerSessionOutcome(sessionId, callerUid, rating, feedback, reportIssue, issueReason, allowMissingRating = false) {
    const { db, sessionRef, session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    if (session.studentUid !== callerUid) {
        const err = new Error('Only the learner can confirm completion and release payment.');
        err.statusCode = 403;
        throw err;
    }
    const callerProfile = await getUserProfileOrThrow(callerUid);
    const settledCompleted = session.status === 'completed' && session.settlementStatus === 'settled';
    if (settledCompleted) {
        await saveLateReviewPatch(db, sessionRef, session, callerUid, allowMissingRating ? 0 : rating, feedback);
        await syncCompletedSessionEffects(sessionId);
        await db.collection('notifications').add({
            uid: session.teacherUid,
            type: 'session-review',
            title: 'Learner Shared Feedback',
            message: `${getDisplayName(callerProfile, 'Your learner')} added feedback for ${describeSessionTopic(session)}.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { ok: true, outcome: 'review_added' };
    }
    if (hasParticipantResponse(session, 'student')) {
        const err = new Error('You already submitted your post-session response.');
        err.statusCode = 409;
        throw err;
    }

    if (!reportIssue) {
        assertCanRateSession(session, callerUid);
    }

    const learnerOutcome = reportIssue ? 'issue' : 'completed';
    const learnerIssueRating = reportIssue ? Number(rating || 0) : Number(rating || 0);
    const studentResponse = buildParticipantResponse(learnerOutcome, {
        submittedByUid: callerUid,
        reasonCode: reportIssue ? issueReason : '',
        note: reportIssue ? (feedback || '') : '',
        rating: learnerIssueRating,
        feedback: feedback || ''
    });
    const ratingPatch = reportIssue ? {} : buildOptionalRatingPatch(callerUid, rating, feedback);
    const teacherResponse = getParticipantResponse(session, 'teacher');
    const responseDueAt = session.responseDueAt || getResponseDueTimestamp(session);
    const basePatch = {
        ...ratingPatch,
        studentAction: learnerOutcome === 'completed' ? 'completed' : 'issue_reported',
        studentResponse,
        responseDueAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!teacherResponse) {
        await sessionRef.set({
            ...basePatch,
            settlementStatus: 'awaiting_counterparty',
            status: 'awaiting_counterparty'
        }, { merge: true });
        await db.collection('notifications').add({
            uid: session.teacherUid,
            type: 'session-awaiting-response',
            title: reportIssue ? 'Learner Reported an Issue' : 'Learner Submitted a Session Update',
            message: reportIssue
                ? `${getDisplayName(callerProfile, 'Your learner')} reported an issue for ${describeSessionTopic(session)}. Submit your own outcome before review starts.`
                : `${getDisplayName(callerProfile, 'Your learner')} marked ${describeSessionTopic(session)} as completed. Submit your outcome to finalize the session.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { ok: true, outcome: 'awaiting_counterparty' };
    }

    if (learnerOutcome === 'completed' && teacherResponse.outcome === 'completed') {
        await sessionRef.set({
            ...basePatch,
            completedBy: callerUid
        }, { merge: true });
        if (isPaidSession(session)) {
            const amount = getSessionCreditAmount(session);
            await settleHeldCredits(sessionId, {
                payoutToTeacher: amount,
                refundToLearner: 0,
                status: 'completed',
                settlementStatus: 'settled',
                creditStatus: 'released',
                studentAction: 'completed',
                teacherAction: 'completed',
                completedBy: callerUid,
                applyRatingsOnCompletion: true,
                learnerTransactionType: 'spend',
                learnerTransactionDescription: `Released ${amount} held credits for ${describeSessionTopic(session)}`,
                teacherTransactionDescription: `Earned ${amount} credits for teaching ${describeSessionTopic(session)}`,
                notifications: [
                    {
                        uid: session.teacherUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)}. Held credits were released to you.`
                    },
                    {
                        uid: session.studentUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)} and the held credits were released.`
                    }
                ]
            });
        } else {
            await settleHeldCredits(sessionId, {
                force: true,
                payoutToTeacher: 0,
                refundToLearner: 0,
                status: 'completed',
                settlementStatus: 'settled',
                creditStatus: 'not_applicable',
                studentAction: 'completed',
                teacherAction: 'completed',
                completedBy: callerUid,
                applyRatingsOnCompletion: true,
                notifications: [
                    {
                        uid: session.teacherUid,
                        type: 'session-completed',
                        title: 'Session Completed',
                        message: `Both sides confirmed ${describeSessionTopic(session)}.`
                    }
                ]
            });
        }
        return { ok: true, outcome: 'completed' };
    }

    const reviewPatch = {
        ...basePatch,
        settlementStatus: 'review_pending',
        status: 'disputed',
        disputeReason: reportIssue
            ? (issueReason || 'Learner reported an issue')
            : 'Learner submitted a conflicting session outcome'
    };
    await sessionRef.set(reviewPatch, { merge: true });
    const caseId = await createCreditReviewCase({
        db,
        sessionRef,
        session: { ...session, ...reviewPatch },
        caseType: getConflictReviewCaseType(teacherResponse.outcome, learnerOutcome),
        openedByUid: callerUid,
        openedByRole: 'student',
        issueReason: reviewPatch.disputeReason,
        recommendedSettlement: getRecommendedSettlement(teacherResponse.outcome, learnerOutcome)
    });
    await sessionRef.set({ creditReviewCaseId: caseId }, { merge: true });
    await db.collection('notifications').add({
        uid: session.teacherUid,
        type: 'session-review-pending',
        title: 'Session Needs Review',
        message: `${getDisplayName(callerProfile, 'Your learner')} submitted a conflicting outcome for ${describeSessionTopic(session)}. Credits stay frozen until review.`,
        sessionId,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await syncTeacherReputation(session.teacherUid);
    return { ok: true, outcome: 'review_pending', caseId };
}

async function completeSkillSwapSession(sessionId, callerUid, rating, feedback, reportIssue, issueReason, allowMissingRating = false) {
    const { session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    if (session.teacherUid === callerUid) {
        return submitTeacherSessionOutcome(sessionId, callerUid, rating, feedback, reportIssue, issueReason, allowMissingRating);
    }
    return submitLearnerSessionOutcome(sessionId, callerUid, rating, feedback, reportIssue, issueReason, allowMissingRating);
}

async function reportSkillSwapNoShow(sessionId, callerUid, whoNoShowed) {
    const { db, sessionRef, session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    const isTeacher = session.teacherUid === callerUid;
    const isLearner = session.studentUid === callerUid;
    const paidSession = isPaidSession(session);
    const heldCredits = getSessionCreditAmount(session);
    const callerProfile = await getUserProfileOrThrow(callerUid);
    if ((session.settlementStatus === 'settled' && ['completed', 'no-show', 'cancelled'].includes(session.status)) || session.settlementStatus === 'review_pending') {
        const err = new Error('This session already has a final post-session outcome.');
        err.statusCode = 409;
        throw err;
    }

    const callerRole = isTeacher ? 'teacher' : (isLearner ? 'student' : null);
    if (!callerRole) {
        const err = new Error('Only session participants can report a no-show.');
        err.statusCode = 403;
        throw err;
    }
    if (hasParticipantResponse(session, callerRole)) {
        const err = new Error('You already submitted your post-session response.');
        err.statusCode = 409;
        throw err;
    }

    const teacherResponse = getParticipantResponse(session, 'teacher');
    const studentResponse = getParticipantResponse(session, 'student');
    const responseDueAt = session.responseDueAt || getResponseDueTimestamp(session);

    if (isTeacher && whoNoShowed === 'teacher') {
        const teacherNoShowResponse = buildParticipantResponse('teacher_no_show', { submittedByUid: callerUid });
        await sessionRef.set({
            teacherAction: 'teacher_no_show',
            teacherResponse: teacherNoShowResponse,
            noShowType: 'teacher',
            responseDueAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await settleHeldCredits(sessionId, {
            force: !paidSession,
            payoutToTeacher: 0,
            refundToLearner: paidSession ? heldCredits : 0,
            status: 'no-show',
            settlementStatus: 'settled',
            creditStatus: paidSession ? 'refunded' : 'not_applicable',
            teacherAction: 'teacher_no_show',
            studentAction: studentResponse && studentResponse.outcome === 'teacher_no_show' ? 'teacher_no_show' : (session.studentAction === 'pending' ? 'pending' : session.studentAction),
            noShowType: 'teacher',
            bumpTeacherNoShow: true,
            applyRatingsOnCompletion: false,
            refundDescription: `Refund for teacher no-show on ${describeSessionTopic(session)}`,
            notifications: [
                {
                    uid: session.studentUid,
                    type: 'session-refund',
                    title: 'Credits Refunded',
                    message: paidSession
                        ? `Held credits for ${describeSessionTopic(session)} were refunded because the teacher marked a no-show.`
                        : `The no-show for ${describeSessionTopic(session)} was recorded.`
                }
            ]
        });
        return { ok: true, outcome: 'teacher_no_show_refunded' };
    }

    if (isLearner && whoNoShowed === 'student') {
        const penalty = paidSession ? Math.round(heldCredits * 0.5) : 0;
        const refund = paidSession ? Math.max(0, heldCredits - penalty) : 0;
        const learnerNoShowResponse = buildParticipantResponse('student_no_show', { submittedByUid: callerUid });
        await sessionRef.set({
            studentAction: 'student_no_show',
            studentResponse: learnerNoShowResponse,
            noShowType: 'student',
            responseDueAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await settleHeldCredits(sessionId, {
            force: !paidSession,
            payoutToTeacher: penalty,
            refundToLearner: refund,
            status: 'no-show',
            settlementStatus: 'settled',
            creditStatus: paidSession ? (penalty && refund ? 'split' : 'refunded') : 'not_applicable',
            studentAction: 'student_no_show',
            teacherAction: teacherResponse && teacherResponse.outcome === 'student_no_show' ? 'student_no_show' : (session.teacherAction === 'pending' ? 'pending' : session.teacherAction),
            noShowType: 'student',
            bumpLearnerNoShow: true,
            applyRatingsOnCompletion: false,
            learnerTransactionType: penalty > 0 ? 'penalty' : 'refund',
            learnerTransactionDescription: penalty > 0
                ? `No-show penalty applied for ${describeSessionTopic(session)}`
                : `No-show recorded for ${describeSessionTopic(session)}`,
            teacherTransactionDescription: penalty > 0
                ? `Received no-show compensation for ${describeSessionTopic(session)}`
                : `No-show recorded for ${describeSessionTopic(session)}`,
            refundDescription: refund > 0 ? `Partial refund for ${describeSessionTopic(session)}` : '',
            notifications: [
                {
                    uid: session.teacherUid,
                    type: 'session-no-show',
                    title: 'Learner No-Show Recorded',
                    message: penalty > 0
                        ? `${getDisplayName(callerProfile, 'Your learner')} recorded a no-show for ${describeSessionTopic(session)}. You received ${penalty} credits.`
                        : `${getDisplayName(callerProfile, 'Your learner')} recorded a no-show for ${describeSessionTopic(session)}.`
                }
            ]
        });
        return { ok: true, outcome: 'learner_no_show_split' };
    }

    if (isLearner && whoNoShowed === 'teacher') {
        const accusationResponse = buildParticipantResponse('teacher_no_show', { submittedByUid: callerUid });
        const accusationPatch = {
            studentAction: 'teacher_no_show',
            studentResponse: accusationResponse,
            noShowType: 'teacher',
            responseDueAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!teacherResponse) {
            await sessionRef.set({
                ...accusationPatch,
                settlementStatus: 'awaiting_counterparty',
                status: 'awaiting_counterparty'
            }, { merge: true });
            await db.collection('notifications').add({
                uid: session.teacherUid,
                type: 'session-awaiting-response',
                title: 'Learner Reported Teacher No-Show',
                message: `${getDisplayName(callerProfile, 'Your learner')} reported a teacher no-show for ${describeSessionTopic(session)}. Submit your own outcome before review starts.`,
                sessionId,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return { ok: true, outcome: 'awaiting_counterparty' };
        }

        const reviewPatch = {
            ...accusationPatch,
            settlementStatus: 'review_pending',
            status: 'disputed',
            disputeReason: 'Learner reported teacher no-show'
        };
        await sessionRef.set(reviewPatch, { merge: true });
        const caseId = await createCreditReviewCase({
            db,
            sessionRef,
            session: { ...session, ...reviewPatch },
            caseType: getConflictReviewCaseType(teacherResponse.outcome, 'teacher_no_show'),
            openedByUid: callerUid,
            openedByRole: 'student',
            issueReason: reviewPatch.disputeReason,
            recommendedSettlement: getRecommendedSettlement(teacherResponse.outcome, 'teacher_no_show')
        });
        await sessionRef.set({ creditReviewCaseId: caseId }, { merge: true });
        await db.collection('notifications').add({
            uid: session.teacherUid,
            type: 'session-review-pending',
            title: 'Teacher No-Show Needs Review',
            message: `${getDisplayName(callerProfile, 'Your learner')} reported a teacher no-show for ${describeSessionTopic(session)}. Credits stay frozen until review.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await syncTeacherReputation(session.teacherUid);
        return { ok: true, outcome: 'review_pending', caseId };
    }

    if (isTeacher && whoNoShowed === 'student') {
        const accusationResponse = buildParticipantResponse('student_no_show', { submittedByUid: callerUid });
        const accusationPatch = {
            teacherAction: 'student_no_show',
            teacherResponse: accusationResponse,
            noShowType: 'student',
            responseDueAt,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!studentResponse) {
            await sessionRef.set({
                ...accusationPatch,
                settlementStatus: 'awaiting_counterparty',
                status: 'awaiting_counterparty'
            }, { merge: true });
            await db.collection('notifications').add({
                uid: session.studentUid,
                type: 'session-awaiting-response',
                title: 'Teacher Reported Learner No-Show',
                message: `${getDisplayName(callerProfile, 'Your teacher')} reported a learner no-show for ${describeSessionTopic(session)}. Submit your own outcome before review starts.`,
                sessionId,
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return { ok: true, outcome: 'awaiting_counterparty' };
        }

        const reviewPatch = {
            ...accusationPatch,
            settlementStatus: 'review_pending',
            status: 'disputed',
            disputeReason: 'Teacher reported learner no-show'
        };
        await sessionRef.set(reviewPatch, { merge: true });
        const caseId = await createCreditReviewCase({
            db,
            sessionRef,
            session: { ...session, ...reviewPatch },
            caseType: getConflictReviewCaseType('student_no_show', studentResponse.outcome),
            openedByUid: callerUid,
            openedByRole: 'teacher',
            issueReason: reviewPatch.disputeReason,
            recommendedSettlement: getRecommendedSettlement('student_no_show', studentResponse.outcome)
        });
        await sessionRef.set({ creditReviewCaseId: caseId }, { merge: true });
        await db.collection('notifications').add({
            uid: session.studentUid,
            type: 'session-review-pending',
            title: 'Learner No-Show Needs Review',
            message: `${getDisplayName(callerProfile, 'Your teacher')} reported a learner no-show for ${describeSessionTopic(session)}. Credits stay frozen until review.`,
            sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await syncTeacherReputation(session.teacherUid);
        return { ok: true, outcome: 'review_pending', caseId };
    }

    const err = new Error('That no-show action is not allowed for this user.');
    err.statusCode = 400;
    throw err;
}

async function cancelSkillSwapSession(sessionId, callerUid) {
    const { session } = await getSessionForParticipantOrThrow(sessionId, callerUid);
    const startDate = session.startAt?.toDate ? session.startAt.toDate() : new Date(session.startAt);
    if (Number.isNaN(startDate.getTime())) {
        const err = new Error('Session start time is invalid.');
        err.statusCode = 400;
        throw err;
    }
    if (Date.now() >= startDate.getTime()) {
        const err = new Error('Use the post-session actions after the session start time.');
        err.statusCode = 400;
        throw err;
    }

    const callerIsTeacher = session.teacherUid === callerUid;
    const paidSession = isPaidSession(session);
    const heldCredits = getSessionCreditAmount(session);
    const msUntilStart = startDate.getTime() - Date.now();
    const fullRefund = callerIsTeacher || msUntilStart >= FULL_REFUND_CANCEL_WINDOW_MS;
    const payoutAmount = paidSession && !fullRefund ? Math.round(heldCredits * 0.5) : 0;
    const refundAmount = paidSession ? Math.max(0, heldCredits - payoutAmount) : 0;

    await updateCalendarBackedSession(sessionId, callerUid, { status: 'cancelled' });

    if (paidSession) {
        await settleHeldCredits(sessionId, {
            payoutToTeacher: payoutAmount,
            refundToLearner: refundAmount,
            status: 'cancelled',
            settlementStatus: 'settled',
            creditStatus: payoutAmount && refundAmount ? 'split' : 'refunded',
            teacherAction: callerIsTeacher ? 'teacher_cancelled' : (session.teacherAction || 'pending'),
            studentAction: callerIsTeacher ? (session.studentAction || 'pending') : (fullRefund ? 'student_cancelled' : 'late_cancel'),
            applyRatingsOnCompletion: false,
            learnerTransactionType: payoutAmount > 0 ? 'penalty' : 'refund',
            learnerTransactionDescription: payoutAmount > 0
                ? `Late cancellation penalty for ${describeSessionTopic(session)}`
                : `Refund for cancelled ${describeSessionTopic(session)}`,
            teacherTransactionDescription: payoutAmount > 0
                ? `Received late cancellation payout for ${describeSessionTopic(session)}`
                : `Cancelled ${describeSessionTopic(session)}`,
            refundDescription: `Refund for cancelled ${describeSessionTopic(session)}`,
            bumpTeacherNoShow: callerIsTeacher,
            notifications: [
                {
                    uid: session.teacherUid,
                    type: 'session-cancelled',
                    title: 'Session Cancelled',
                    message: callerIsTeacher
                        ? `You cancelled ${describeSessionTopic(session)}.${payoutAmount > 0 ? ' A late cancellation payout was applied.' : ''}`
                        : `The learner cancelled ${describeSessionTopic(session)}.${payoutAmount > 0 ? ` You received ${payoutAmount} credits.` : ''}`
                },
                {
                    uid: session.studentUid,
                    type: 'session-cancelled',
                    title: 'Session Cancelled',
                    message: callerIsTeacher
                        ? `The teacher cancelled ${describeSessionTopic(session)}.${refundAmount > 0 ? ` ${refundAmount} credits were refunded.` : ''}`
                        : `You cancelled ${describeSessionTopic(session)}.${refundAmount > 0 ? ` ${refundAmount} credits were refunded.` : ''}`
                }
            ]
        });
    } else {
        const db = getAdminDb();
        await db.collection('sessions').doc(sessionId).set({
            status: 'cancelled',
            settlementStatus: 'settled',
            teacherAction: callerIsTeacher ? 'teacher_cancelled' : (session.teacherAction || 'pending'),
            studentAction: callerIsTeacher ? (session.studentAction || 'pending') : 'student_cancelled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }
    return { ok: true, outcome: 'cancelled' };
}

async function reconcilePendingSettlements(callerUid) {
    const db = getAdminDb();
    const snap = await db.collection('sessions').where('participants', 'array-contains', callerUid).get();
    const now = Date.now();
    let settledCount = 0;
    for (const docSnap of snap.docs) {
        const session = { id: docSnap.id, ...docSnap.data() };
        const teacherResponse = getParticipantResponse(session, 'teacher');
        const studentResponse = getParticipantResponse(session, 'student');
        const teacherOutcome = teacherResponse?.outcome || normalizeParticipantActionToOutcome('teacher', session.teacherAction);
        const studentOutcome = studentResponse?.outcome || normalizeParticipantActionToOutcome('student', session.studentAction);
        const responseOpenDate = getSessionResponseOpenDate(session);
        const hasAnySubmittedResponse = !!teacherResponse || !!studentResponse
            || (teacherOutcome && teacherOutcome !== 'pending')
            || (studentOutcome && studentOutcome !== 'pending');
        const canOpenResponseWindow = responseOpenDate && responseOpenDate.getTime() <= now;
        if ((session.settlementStatus === 'scheduled' || !session.settlementStatus)
            && canOpenResponseWindow
            && !hasAnySubmittedResponse
            && !['completed', 'cancelled', 'no-show', 'disputed'].includes(session.status)) {
            await docSnap.ref.set({
                settlementStatus: 'awaiting_responses',
                status: 'awaiting_responses',
                responseDueAt: session.responseDueAt || getResponseDueTimestamp(session),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            settledCount += 1;
            continue;
        }
        const legacyAwaitingLearner = session.settlementStatus === 'awaiting_learner';
        const bilateralAwaiting = session.settlementStatus === 'awaiting_counterparty';
        if (!legacyAwaitingLearner && !bilateralAwaiting) {
            continue;
        }
        const dueDate = session.responseDueAt?.toDate
            ? session.responseDueAt.toDate()
            : (session.learnerResponseDueAt?.toDate ? session.learnerResponseDueAt.toDate() : getLearnerResponseDueDate(session));
        if (!dueDate || dueDate.getTime() > now) continue;
        const normalizedTeacherOutcome = teacherOutcome === 'delivered' ? 'completed' : teacherOutcome;
        const normalizedStudentOutcome = studentOutcome;

        if ((normalizedTeacherOutcome === 'completed' && (normalizedStudentOutcome === 'pending' || !normalizedStudentOutcome))
            || (normalizedStudentOutcome === 'completed' && (normalizedTeacherOutcome === 'pending' || !normalizedTeacherOutcome))) {
            const teacherAction = normalizedTeacherOutcome === 'completed' ? 'completed' : 'auto_completed';
            const studentAction = normalizedStudentOutcome === 'completed' ? 'completed' : 'auto_completed';
            if (isPaidSession(session)) {
                await settleHeldCredits(session.id, {
                    payoutToTeacher: getSessionCreditAmount(session),
                    refundToLearner: 0,
                    status: 'completed',
                    settlementStatus: 'settled',
                    creditStatus: 'released',
                    teacherAction,
                    studentAction,
                    applyRatingsOnCompletion: true,
                    learnerTransactionType: 'spend',
                    learnerTransactionDescription: `Auto-settled held credits for ${describeSessionTopic(session)}`,
                    teacherTransactionDescription: `Auto-settled credits for teaching ${describeSessionTopic(session)}`,
                    notifications: [
                        {
                            uid: session.teacherUid,
                            type: 'session-completed',
                            title: 'Session Auto-Completed',
                            message: `The response window expired for ${describeSessionTopic(session)}. The session was auto-completed.`
                        },
                        {
                            uid: session.studentUid,
                            type: 'session-completed',
                            title: 'Session Auto-Completed',
                            message: `The response window expired for ${describeSessionTopic(session)}. The session was auto-completed automatically.`
                        }
                    ]
                });
            } else {
                await settleHeldCredits(session.id, {
                    force: true,
                    payoutToTeacher: 0,
                    refundToLearner: 0,
                    status: 'completed',
                    settlementStatus: 'settled',
                    creditStatus: 'not_applicable',
                    teacherAction,
                    studentAction,
                    applyRatingsOnCompletion: true
                });
            }
            settledCount += 1;
            continue;
        }

        const needsReviewAfterTimeout =
            (normalizedTeacherOutcome === 'issue' && (normalizedStudentOutcome === 'pending' || !normalizedStudentOutcome))
            || (normalizedStudentOutcome === 'issue' && (normalizedTeacherOutcome === 'pending' || !normalizedTeacherOutcome))
            || (normalizedTeacherOutcome === 'student_no_show' && (normalizedStudentOutcome === 'pending' || !normalizedStudentOutcome))
            || (normalizedStudentOutcome === 'teacher_no_show' && (normalizedTeacherOutcome === 'pending' || !normalizedTeacherOutcome));

        if (!needsReviewAfterTimeout) {
            continue;
        }

        const timeoutPatch = {
            settlementStatus: 'review_pending',
            status: 'disputed',
            responseDueAt: session.responseDueAt || (session.learnerResponseDueAt || null),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            teacherAction: session.teacherAction || 'pending',
            studentAction: session.studentAction || 'pending',
            teacherResponse: session.teacherResponse || (normalizedTeacherOutcome === 'completed'
                ? buildParticipantResponse('completed', { submittedByUid: session.teacherUid, bySystem: true })
                : null),
            studentResponse: session.studentResponse || (normalizedStudentOutcome === 'completed'
                ? buildParticipantResponse('completed', { submittedByUid: session.studentUid, bySystem: true })
                : null),
            disputeReason: 'Response window expired before both sides agreed on the session outcome'
        };
        await docSnap.ref.set(timeoutPatch, { merge: true });
        const caseId = await createCreditReviewCase({
            db,
            sessionRef: docSnap.ref,
            session: { ...session, ...timeoutPatch },
            caseType: getConflictReviewCaseType(normalizedTeacherOutcome, normalizedStudentOutcome),
            openedByUid: 'system',
            openedByRole: 'system',
            issueReason: timeoutPatch.disputeReason,
            openedAfterTimeout: true,
            recommendedSettlement: getRecommendedSettlement(normalizedTeacherOutcome, normalizedStudentOutcome)
        });
        await docSnap.ref.set({ creditReviewCaseId: caseId }, { merge: true });
        settledCount += 1;
    }
    return { ok: true, settledCount };
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

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');
}

function stripHtmlToText(html) {
    return normalizeWhitespace(
        decodeHtmlEntities(
            String(html || '')
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
        )
    );
}

function extractTagText(html, tagName) {
    const match = String(html || '').match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? normalizeWhitespace(decodeHtmlEntities(match[1])) : '';
}

function extractMetaContent(html, key) {
    const patterns = [
        new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+property=["']${key}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${key}["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${key}["']`, 'i')
    ];
    for (const pattern of patterns) {
        const match = String(html || '').match(pattern);
        if (match?.[1]) return normalizeWhitespace(decodeHtmlEntities(match[1]));
    }
    return '';
}

function normalizePersonName(value) {
    return normalizeWhitespace(String(value || '').toLowerCase().replace(/[^a-z\s]/g, ' '));
}

function namesLikelyMatch(profileName, recipientName) {
    const left = normalizePersonName(profileName);
    const right = normalizePersonName(recipientName);
    if (!left || !right || ['not shown', 'not visible', 'unknown'].includes(right)) return false;
    const leftTokens = left.split(' ').filter(Boolean);
    const rightTokens = right.split(' ').filter(Boolean);
    if (!leftTokens.length || !rightTokens.length) return false;
    if (left === right) return true;
    if (leftTokens.length === 1) return rightTokens.includes(leftTokens[0]);
    const leftFirst = leftTokens[0];
    const leftLast = leftTokens[leftTokens.length - 1];
    return rightTokens.includes(leftFirst) && rightTokens.includes(leftLast);
}

function parseClaimedSkills(skills, skillLevels) {
    const fromLevels = Object.keys(skillLevels || {}).map(s => normalizeWhitespace(s)).filter(Boolean);
    if (fromLevels.length) return fromLevels;
    return String(skills || '')
        .split(/[,\n]/)
        .map(s => normalizeWhitespace(s))
        .filter(Boolean);
}

function inferSkillMatch(haystack, claimedSkills) {
    const source = String(haystack || '').toLowerCase();
    if (!claimedSkills.length) return 'partial';
    const exactMatch = claimedSkills.some(skill => source.includes(skill.toLowerCase()));
    if (exactMatch) return 'direct';
    const tokenMatch = claimedSkills.some(skill =>
        skill.toLowerCase().split(/\s+/).some(token => token.length > 2 && source.includes(token))
    );
    return tokenMatch ? 'partial' : 'none';
}

function toSkillVerdicts(skillMatch, claimedSkills) {
    if (skillMatch === 'direct') {
        return { verifiedSkills: claimedSkills, partialSkills: [], unverifiedSkills: [] };
    }
    if (skillMatch === 'partial') {
        return { verifiedSkills: [], partialSkills: claimedSkills, unverifiedSkills: [] };
    }
    return { verifiedSkills: [], partialSkills: [], unverifiedSkills: claimedSkills };
}

function detectCertificatePlatform(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const pathname = parsed.pathname || '/';
        const match = CERT_LINK_PLATFORMS.find(platform =>
            platform.hosts.some(host => hostname === host || hostname.endsWith(`.${host}`))
        );
        const strongVerifyPath = !!match?.verifyPaths?.some(pattern => pattern.test(pathname));
        return {
            rawUrl,
            normalizedUrl: parsed.toString(),
            hostname,
            pathname,
            platformName: match?.name || hostname || 'Unknown platform',
            issuer: match?.issuer || hostname || 'Unknown issuer',
            platformTrusted: !!match,
            strongVerifyPath
        };
    } catch (_err) {
        return {
            rawUrl,
            normalizedUrl: rawUrl,
            hostname: '',
            pathname: '',
            platformName: 'Unknown platform',
            issuer: 'Unknown issuer',
            platformTrusted: false,
            strongVerifyPath: false
        };
    }
}

function extractCredentialId(text) {
    const match = String(text || '').match(/\b(?:credential|certificate|certification|badge)\s*(?:id|code|number|no\.?)\s*[:#-]?\s*([A-Z0-9-]{6,})/i);
    return match?.[1] ? normalizeWhitespace(match[1]) : 'not shown';
}

function extractCompletionDate(text) {
    const match = String(text || '').match(/\b(?:issued|completed|earned|awarded|date)\s*(?:on)?\s*[:#-]?\s*([A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,9}\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    return match?.[1] ? normalizeWhitespace(match[1]) : 'not shown';
}

function looksLikeLoginWall(title, text, finalUrl) {
    const haystack = `${title} ${String(text || '').slice(0, 1200)} ${finalUrl || ''}`.toLowerCase();
    return /(sign in|log in|login|continue with google|create account|forgot password)/i.test(haystack)
        && !/(certificate|credential|badge|certification|accomplishment)/i.test(haystack);
}

async function fetchCertificatePage(rawUrl) {
    try {
        const response = await axios.get(rawUrl, {
            timeout: 12000,
            maxRedirects: 5,
            responseType: 'text',
            headers: {
                'User-Agent': 'Mozilla/5.0 SkillSwapBot/1.0 (+https://skillswap.local)',
                'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'
            }
        });
        const html = String(response.data || '');
        const title = extractTagText(html, 'title');
        const metaDescription = extractMetaContent(html, 'description') || extractMetaContent(html, 'og:description');
        const text = stripHtmlToText(html);
        const finalUrl = response?.request?.res?.responseUrl || rawUrl;
        const loginWall = looksLikeLoginWall(title, text, finalUrl);
        return {
            ok: true,
            html,
            title,
            metaDescription,
            text,
            finalUrl,
            pageAccessible: !loginWall && text.length > 40,
            loginWall
        };
    } catch (error) {
        return {
            ok: false,
            errorMessage: error.response?.status
                ? `HTTP ${error.response.status}`
                : (error.code || error.message || 'fetch_failed'),
            pageAccessible: false
        };
    }
}

function buildCertLinkFallbackResult(rawUrl, platform, claimedSkills, usage) {
    const lowerUrl = String(rawUrl || '').toLowerCase();
    const pageAuthenticSignals = [];
    const pageSuspiciousSignals = [];
    let confidenceScore = 0;

    if (platform.platformTrusted) {
        pageAuthenticSignals.push(`Trusted platform domain: ${platform.platformName}`);
        confidenceScore += 35;
    } else {
        pageSuspiciousSignals.push('Domain is not in the trusted certificate platform list.');
    }
    if (platform.strongVerifyPath) {
        pageAuthenticSignals.push('URL path matches a public certificate/verification page pattern.');
        confidenceScore += 20;
    } else {
        pageSuspiciousSignals.push('URL path does not clearly look like a public certificate page.');
    }
    if (/(certificate|certification|credential|badge|verify|accomplishment)/i.test(lowerUrl)) {
        pageAuthenticSignals.push('Certificate keywords found in the URL.');
        confidenceScore += 10;
    }

    const skillMatch = inferSkillMatch(lowerUrl, claimedSkills);
    if (skillMatch === 'direct') confidenceScore += 10;
    else if (skillMatch === 'partial') confidenceScore += 5;
    else pageSuspiciousSignals.push('The URL does not mention the claimed skill directly.');

    confidenceScore = Math.min(80, confidenceScore);
    const verdicts = toSkillVerdicts(skillMatch, claimedSkills);

    return {
        isVerified: confidenceScore >= 50,
        confidenceScore,
        platformName: platform.platformName,
        platformTrusted: platform.platformTrusted,
        pageAccessible: false,
        issuer: platform.issuer,
        issuerCredible: platform.platformTrusted || KNOWN_ISSUERS.includes(platform.issuer),
        certSubject: 'not shown',
        recipientName: 'not shown',
        nameMismatch: false,
        credentialId: 'not shown',
        completionDate: 'not shown',
        skillMatch,
        pageAuthenticSignals,
        pageSuspiciousSignals,
        limitation: 'The platform blocked direct page access, so this result is based on trusted URL pattern analysis only.',
        reasoning: platform.platformTrusted
            ? `The link points to ${platform.platformName}, which is a trusted certificate platform. The page could not be fetched publicly, so the score uses URL-pattern trust instead of full page analysis. Open/public certificate pages score better than blocked or login-only links.`
            : 'The link could not be fetched publicly and the domain is not a known certificate issuer. This result is based on URL pattern analysis only, so trust is limited. Use a public certificate page on a recognized platform for a stronger score.',
        usage,
        ...verdicts
    };
}

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
        else if (type === 'certlink' || type === 'certificate' || type === 'certificate_link') {
            const rawCertLink = req.body.certLinkUrl;
            if (!rawCertLink || rawCertLink.length > MAX_URL) {
                return res.status(400).json({ error: 'Invalid certificate URL.' });
            }

            let parsedUrl;
            try {
                parsedUrl = new URL(rawCertLink);
            } catch (_err) {
                return res.status(400).json({ error: 'Please provide a valid public certificate URL.' });
            }
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ error: 'Certificate URL must start with http:// or https://.' });
            }

            const platform = detectCertificatePlatform(parsedUrl.toString());
            const claimedSkills = parseClaimedSkills(skills, skillLevels);
            const page = await fetchCertificatePage(parsedUrl.toString());

            if (!page.ok || !page.pageAccessible) {
                const fallbackResult = buildCertLinkFallbackResult(parsedUrl.toString(), platform, claimedSkills, usage);
                if (page.errorMessage) {
                    fallbackResult.pageSuspiciousSignals = [
                        ...fallbackResult.pageSuspiciousSignals,
                        `Direct page fetch failed: ${page.errorMessage}`
                    ];
                } else if (page.loginWall) {
                    fallbackResult.pageSuspiciousSignals = [
                        ...fallbackResult.pageSuspiciousSignals,
                        'The link appears to require login instead of showing a public certificate page.'
                    ];
                }
                return res.json(fallbackResult);
            }

            const pageSummary = normalizeWhitespace([
                page.title,
                page.metaDescription,
                page.text
            ].filter(Boolean).join(' ')).slice(0, 12000);

            const lvlLines = Object.entries(skillLevels).map(([s, l]) => `- ${s}: claimed as ${l}`).join('\n') || skills;
            const certPrompt = `Evaluate this public certificate or badge webpage as skill proof.

Profile owner: "${fullName || 'not provided'}"
Platform: ${platform.platformName}
URL: ${page.finalUrl}
Claimed skills:
${lvlLines}
User description: "${expertise}"

Page title: "${page.title || 'not shown'}"
Meta description: "${page.metaDescription || 'not shown'}"
Page text excerpt:
"""${pageSummary}"""

Rules:
- Max score is 80 for this method.
- If the displayed recipient clearly belongs to someone else, set nameMismatch true, isVerified false, confidenceScore 0.
- If the recipient is not shown, do not force a mismatch.
- Prefer trustworthy certificate signals: recognized issuer, certificate/badge wording, issue date, credential ID, public verification wording.
- Penalize generic marketing pages, login walls, and unverifiable pages.

Respond ONLY in valid JSON:
{
  "isVerified": boolean,
  "confidenceScore": number (0-80),
  "issuer": "issuer name",
  "issuerCredible": boolean,
  "certSubject": "certificate subject or 'not shown'",
  "recipientName": "recipient name or 'not shown'",
  "nameMismatch": boolean,
  "credentialId": "credential id or 'not shown'",
  "completionDate": "completion/issue date or 'not shown'",
  "skillMatch": "direct / partial / none",
  "verifiedSkills": ["clearly supported skills"],
  "partialSkills": ["partially supported skills"],
  "unverifiedSkills": ["unsupported skills"],
  "pageAuthenticSignals": ["signal 1", "signal 2"],
  "pageSuspiciousSignals": ["warning 1"],
  "reasoning": "3 short sentences.",
  "limitation": "Short note about this verification method."
}`;

            const certAnalysis = await callGemini(model, certPrompt, null);
            const recipientName = normalizeWhitespace(certAnalysis.recipientName || 'not shown');
            const explicitNameMismatch = !!certAnalysis.nameMismatch;
            const inferredNameMismatch = recipientName && recipientName !== 'not shown' && fullName
                ? !namesLikelyMatch(fullName, recipientName)
                : false;
            const nameMismatch = explicitNameMismatch || inferredNameMismatch;
            const skillMatch = ['direct', 'partial', 'none'].includes(certAnalysis.skillMatch)
                ? certAnalysis.skillMatch
                : inferSkillMatch(pageSummary, claimedSkills);

            const inferredSignals = [];
            const suspiciousSignals = [];
            if (platform.platformTrusted) inferredSignals.push(`Trusted platform domain: ${platform.platformName}`);
            if (platform.strongVerifyPath) inferredSignals.push('Verification-style public URL detected.');
            if (extractCredentialId(pageSummary) !== 'not shown') inferredSignals.push('Credential identifier pattern detected on the page.');
            if (extractCompletionDate(pageSummary) !== 'not shown') inferredSignals.push('Completion/issue date detected on the page.');
            if (!platform.platformTrusted) suspiciousSignals.push('Domain is not a recognized certificate platform.');
            if (skillMatch === 'none') suspiciousSignals.push('The page content does not clearly support the claimed skill.');

            let confidenceScore = Number(certAnalysis.confidenceScore) || 0;
            confidenceScore = Math.max(0, Math.min(80, Math.round(confidenceScore)));
            if (!platform.platformTrusted) confidenceScore = Math.min(confidenceScore, 55);
            if (nameMismatch) confidenceScore = 0;
            if (skillMatch === 'none') confidenceScore = Math.min(confidenceScore, 25);

            const aiAuthenticSignals = Array.isArray(certAnalysis.pageAuthenticSignals) ? certAnalysis.pageAuthenticSignals : [];
            const aiSuspiciousSignals = Array.isArray(certAnalysis.pageSuspiciousSignals) ? certAnalysis.pageSuspiciousSignals : [];
            const pageAuthenticSignals = [...new Set([
                ...inferredSignals,
                ...(aiAuthenticSignals.map(s => normalizeWhitespace(s)).filter(Boolean))
            ])].slice(0, 6);
            const pageSuspiciousSignals = [...new Set([
                ...suspiciousSignals,
                ...(aiSuspiciousSignals.map(s => normalizeWhitespace(s)).filter(Boolean))
            ])].slice(0, 6);
            const fallbackVerdicts = toSkillVerdicts(skillMatch, claimedSkills);

            return res.json({
                isVerified: !nameMismatch && confidenceScore >= 50,
                confidenceScore,
                platformName: platform.platformName,
                platformTrusted: platform.platformTrusted,
                pageAccessible: true,
                issuer: normalizeWhitespace(certAnalysis.issuer || platform.issuer),
                issuerCredible: certAnalysis.issuerCredible !== false && (platform.platformTrusted || KNOWN_ISSUERS.includes(normalizeWhitespace(certAnalysis.issuer || platform.issuer))),
                certSubject: normalizeWhitespace(certAnalysis.certSubject || 'not shown'),
                recipientName,
                nameMismatch,
                credentialId: normalizeWhitespace(certAnalysis.credentialId || extractCredentialId(pageSummary)),
                completionDate: normalizeWhitespace(certAnalysis.completionDate || extractCompletionDate(pageSummary)),
                skillMatch,
                pageAuthenticSignals,
                pageSuspiciousSignals,
                reasoning: normalizeWhitespace(certAnalysis.reasoning || 'The certificate page was analyzed using public page text and platform trust signals.'),
                limitation: normalizeWhitespace(certAnalysis.limitation || 'This method verifies only public certificate page details, not the original issuer database directly.'),
                usage,
                verifiedSkills: Array.isArray(certAnalysis.verifiedSkills) ? certAnalysis.verifiedSkills.map(s => normalizeWhitespace(s)).filter(Boolean) : fallbackVerdicts.verifiedSkills,
                partialSkills: Array.isArray(certAnalysis.partialSkills) ? certAnalysis.partialSkills.map(s => normalizeWhitespace(s)).filter(Boolean) : fallbackVerdicts.partialSkills,
                unverifiedSkills: Array.isArray(certAnalysis.unverifiedSkills) ? certAnalysis.unverifiedSkills.map(s => normalizeWhitespace(s)).filter(Boolean) : fallbackVerdicts.unverifiedSkills
            });
        }

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

app.post('/api/roadmaps/generate', requireAuth, async (req, res) => {
    try {
        const skillResult = sanitize(req.body?.skill, 80, 'skill');
        const skill = skillResult.value;
        const levelKey = normalizeRoadmapLevel(req.body?.level);
        if (skillResult.error || !skill) {
            return res.status(400).json({ error: skillResult.error || 'Skill is required.' });
        }
        if (!levelKey) {
            return res.status(400).json({ error: 'Level must be Beginner, Intermediate, or Advanced.' });
        }
        let rawRoadmap = null;
        let source = 'fallback';
        try {
            rawRoadmap = await generateRoadmapWithGroq(skill, levelKey);
            if (rawRoadmap) source = 'ai';
        } catch (aiErr) {
            console.warn('[roadmaps generate] falling back to curated roadmap:', aiErr.message);
        }
        const roadmap = sanitizeRoadmapPayload(skill, levelKey, rawRoadmap, source);
        const skillKey = getRoadmapSkillKey(skill);
        await getAdminDb().collection('users').doc(req.user.uid).set({
            roadmaps: {
                [skillKey]: {
                    ...roadmap,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ skillKey, roadmap });
    } catch (err) {
        console.error('[roadmaps generate]', err.message);
        res.status(500).json({ error: err.message || 'Could not generate roadmap.' });
    }
});

app.patch('/api/roadmaps/:skillKey', requireAuth, async (req, res) => {
    try {
        const requestedKey = getRoadmapSkillKey(req.params.skillKey || '');
        const roadmapInput = req.body?.roadmap || req.body || {};
        const skill = sanitize(roadmapInput.skill || requestedKey, 80, 'skill').value || requestedKey;
        const rawLevel = roadmapInput.level || roadmapInput.levelLabel;
        const levelKey = normalizeRoadmapLevel(rawLevel) || 'beginner';
        const source = roadmapInput.source || 'manual';
        const roadmap = sanitizeRoadmapPayload(skill, levelKey, roadmapInput, source);
        await getAdminDb().collection('users').doc(req.user.uid).set({
            roadmaps: {
                [requestedKey]: {
                    ...roadmap,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ skillKey: requestedKey, roadmap });
    } catch (err) {
        console.error('[roadmaps patch]', err.message);
        res.status(500).json({ error: err.message || 'Could not save roadmap progress.' });
    }
});

app.delete('/api/roadmaps/:skillKey', requireAuth, async (req, res) => {
    try {
        const skillKey = getRoadmapSkillKey(req.params.skillKey || '');
        await getAdminDb().collection('users').doc(req.user.uid).update({
            [`roadmaps.${skillKey}`]: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ ok: true, skillKey });
    } catch (err) {
        console.error('[roadmaps delete]', err.message);
        if (err.code === 5 || /No document to update/i.test(err.message || '')) {
            return res.json({ ok: true, skillKey: getRoadmapSkillKey(req.params.skillKey || '') });
        }
        res.status(500).json({ error: err.message || 'Could not delete roadmap.' });
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
        const { requestId, connectionId, topic, durationMinutes, startAt, partnerName, appUrl } = req.body || {};
        if (!requestId) return res.status(400).json({ error: 'Missing accepted request id.' });
        if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'Topic is required.' });
        if (!startAt) return res.status(400).json({ error: 'Start date is required.' });

        const acceptedConnection = await getAcceptedConnectionOrThrow({ requestId, connectionId, callerUid: req.user.uid });
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

app.post('/api/sessions/reconcile', requireAuth, async (req, res) => {
    try {
        const result = await reconcilePendingSettlements(req.user.uid);
        res.json(result);
    } catch (err) {
        console.error('[reconcile-session-settlements]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not reconcile pending settlements.' });
    }
});

app.post('/api/sessions/:id/cancel', requireAuth, async (req, res) => {
    try {
        const result = await cancelSkillSwapSession(req.params.id, req.user.uid);
        res.json(result);
    } catch (err) {
        console.error('[cancel-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not cancel this session.' });
    }
});

app.post('/api/sessions/:id/teacher-complete', requireAuth, async (req, res) => {
    try {
        const reportIssue = !!req.body?.reportIssue;
        const rating = Number(req.body?.rating || 0);
        const allowMissingRating = !!req.body?.allowMissingRating;
        if (!reportIssue && !allowMissingRating && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
        const issueReason = typeof req.body?.issueReason === 'string' ? req.body.issueReason : '';
        const result = await submitTeacherSessionOutcome(req.params.id, req.user.uid, rating, feedback, reportIssue, issueReason, allowMissingRating);
        res.json(result);
    } catch (err) {
        console.error('[teacher-complete-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not save the teacher session outcome.' });
    }
});

app.post('/api/sessions/:id/learner-complete', requireAuth, async (req, res) => {
    try {
        const reportIssue = !!req.body?.reportIssue;
        const rating = Number(req.body?.rating || 0);
        const allowMissingRating = !!req.body?.allowMissingRating;
        if (!reportIssue && !allowMissingRating && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
        const issueReason = typeof req.body?.issueReason === 'string' ? req.body.issueReason : '';
        const result = await submitLearnerSessionOutcome(req.params.id, req.user.uid, rating, feedback, reportIssue, issueReason, allowMissingRating);
        res.json(result);
    } catch (err) {
        console.error('[learner-complete-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not confirm this session.' });
    }
});

app.post('/api/sessions/:id/complete', requireAuth, async (req, res) => {
    try {
        const reportIssue = !!req.body?.reportIssue;
        const rating = Number(req.body?.rating || 0);
        const allowMissingRating = !!req.body?.allowMissingRating;
        if (!reportIssue && !allowMissingRating && (rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
        const issueReason = typeof req.body?.issueReason === 'string' ? req.body.issueReason : '';
        const result = await completeSkillSwapSession(req.params.id, req.user.uid, rating, feedback, reportIssue, issueReason, allowMissingRating);
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

app.post('/api/human-verification/request', requireAuth, async (req, res) => {
    try {
        const requester = await getUserProfileOrThrow(req.user.uid);
        if (requester.appRole === 'reviewer') {
            return res.status(400).json({ error: 'Reviewer accounts cannot request teacher verification.' });
        }

        const summary = await buildTeacherReviewSnapshot(req.user.uid);
        if (summary.humanVerification?.status === 'verified') {
            return res.status(409).json({ error: 'Your profile is already human verified.' });
        }
        if (!summary.teacherReputation.eligibleForHumanReview) {
            return res.status(400).json({ error: getEligibilityErrorMessage(summary) });
        }

        const db = getAdminDb();
        const existingRequestsSnap = await db.collection('humanVerificationRequests').where('uid', '==', req.user.uid).get();
        const existingPending = [];
        existingRequestsSnap.forEach(docSnap => {
            const data = docSnap.data() || {};
            if (data.status === 'pending') existingPending.push(docSnap.id);
        });
        if (existingPending.length) {
            return res.status(409).json({ error: 'You already have a human verification request pending review.' });
        }

        const requestRef = db.collection('humanVerificationRequests').doc();
        const now = admin.firestore.FieldValue.serverTimestamp();
        await Promise.all([
            requestRef.set({
                uid: req.user.uid,
                status: 'pending',
                requestedAt: now,
                updatedAt: now,
                teacher: summary.teacher,
                verificationSnapshot: {
                    status: summary.verification.status || 'unverified',
                    score: Number(summary.verification.score || 0)
                },
                averageRating: summary.teacherReputation.averageRating,
                writtenFeedbackCount: summary.teacherReputation.writtenLearnerFeedbackCount,
                completedTeachingSessions: summary.teacherReputation.completedTeachingSessions,
                completedDemoSessions: summary.teacherReputation.completedDemoSessions,
                completedPaidSessions: summary.teacherReputation.completedPaidSessions,
                badgeTier: summary.teacherReputation.badgeTier,
                eligibilitySnapshot: summary.teacherReputation.requirementProgress,
                recentFeedback: summary.recentFeedback
            }),
            db.collection('users').doc(req.user.uid).set({
                humanVerification: {
                    status: 'pending',
                    requestId: requestRef.id,
                    requestedAt: now
                },
                teacherReputation: summary.teacherReputation,
                updatedAt: now
            }, { merge: true })
        ]);

        res.json({ ok: true, requestId: requestRef.id, teacherReputation: summary.teacherReputation });
    } catch (err) {
        console.error('[human-verification-request]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not request human verification.' });
    }
});

app.get('/api/reviewer/human-verification-requests', requireAuth, requireReviewer, async (req, res) => {
    try {
        const db = getAdminDb();
        const statusFilter = typeof req.query?.status === 'string' ? req.query.status : 'pending';
        const queueSnap = await db.collection('humanVerificationRequests').get();
        const queueItems = [];

        queueSnap.forEach(docSnap => {
            const data = docSnap.data() || {};
            if (statusFilter !== 'all' && data.status !== statusFilter) return;
            queueItems.push({ id: docSnap.id, ...data });
        });

        queueItems.sort((a, b) => toMillis(b.requestedAt) - toMillis(a.requestedAt));

        const items = await Promise.all(queueItems.map(async item => {
            const summary = await buildTeacherReviewSnapshot(item.uid);
            return {
                id: item.id,
                status: item.status || 'pending',
                requestedAt: item.requestedAt || null,
                reviewedAt: item.reviewedAt || null,
                reviewedBy: item.reviewedBy || null,
                reviewedByName: item.reviewedByName || '',
                reviewNotes: item.reviewNotes || '',
                teacher: summary.teacher,
                verification: summary.verification,
                humanVerification: summary.humanVerification,
                teacherReputation: summary.teacherReputation,
                recentFeedback: summary.recentFeedback,
                eligibilitySnapshot: item.eligibilitySnapshot || summary.teacherReputation.requirementProgress
            };
        }));

        res.json({ ok: true, items });
    } catch (err) {
        console.error('[reviewer-list]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load pending review requests.' });
    }
});

async function resolveHumanVerificationDecision(requestId, reviewerProfile, nextStatus, reviewNotes) {
    const db = getAdminDb();
    const requestRef = db.collection('humanVerificationRequests').doc(requestId);
    const requestSnap = await requestRef.get();
    if (!requestSnap.exists) {
        const err = new Error('Review request not found.');
        err.statusCode = 404;
        throw err;
    }

    const requestData = requestSnap.data() || {};
    const summary = await buildTeacherReviewSnapshot(requestData.uid);
    const reviewedAt = admin.firestore.FieldValue.serverTimestamp();
    const reviewerName = getDisplayName(reviewerProfile, 'Reviewer');
    const safeNotes = typeof reviewNotes === 'string' ? reviewNotes.trim().slice(0, 500) : '';

    await Promise.all([
        requestRef.set({
            status: nextStatus,
            reviewedAt,
            reviewedBy: reviewerProfile.uid,
            reviewedByName: reviewerName,
            reviewNotes: safeNotes,
            updatedAt: reviewedAt,
            teacher: summary.teacher,
            verificationSnapshot: {
                status: summary.verification.status || 'unverified',
                score: Number(summary.verification.score || 0)
            },
            averageRating: summary.teacherReputation.averageRating,
            writtenFeedbackCount: summary.teacherReputation.writtenLearnerFeedbackCount,
            completedTeachingSessions: summary.teacherReputation.completedTeachingSessions,
            completedDemoSessions: summary.teacherReputation.completedDemoSessions,
            completedPaidSessions: summary.teacherReputation.completedPaidSessions,
            badgeTier: summary.teacherReputation.badgeTier,
            eligibilitySnapshot: summary.teacherReputation.requirementProgress,
            recentFeedback: summary.recentFeedback
        }, { merge: true }),
        db.collection('users').doc(requestData.uid).set({
            humanVerification: {
                status: nextStatus,
                requestId,
                requestedAt: requestData.requestedAt || null,
                reviewedAt,
                reviewedBy: reviewerProfile.uid,
                reviewedByName: reviewerName,
                reviewNotes: safeNotes
            },
            teacherReputation: summary.teacherReputation,
            updatedAt: reviewedAt
        }, { merge: true }),
        db.collection('notifications').add({
            uid: requestData.uid,
            type: 'human-verification',
            title: nextStatus === 'verified' ? 'Human Verification Approved' : 'Human Verification Rejected',
            message: nextStatus === 'verified'
                ? 'Your profile is now human verified on SkillSwap.'
                : (safeNotes ? `Your human verification request was rejected: ${safeNotes}` : 'Your human verification request was rejected. Improve your teaching profile and apply again later.'),
            read: false,
            createdAt: reviewedAt
        })
    ]);

    return { ok: true, status: nextStatus, teacherReputation: summary.teacherReputation };
}

async function listCreditReviewCases(statusFilter = 'pending') {
    const db = getAdminDb();
    const snap = await db.collection('creditReviewCases').get();
    const items = [];
    snap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        if (statusFilter !== 'all' && (data.status || 'pending') !== statusFilter) return;
        items.push({ id: docSnap.id, ...data });
    });
    items.sort((a, b) => Math.max(toMillis(b.updatedAt), toMillis(b.openedAt)) - Math.max(toMillis(a.updatedAt), toMillis(a.openedAt)));
    return items;
}

async function resolveCreditReviewCase(caseId, reviewerProfile, payload) {
    const db = getAdminDb();
    const caseRef = db.collection('creditReviewCases').doc(caseId);
    const caseSnap = await caseRef.get();
    if (!caseSnap.exists) {
        const err = new Error('Credit review case not found.');
        err.statusCode = 404;
        throw err;
    }
    const caseData = caseSnap.data() || {};
    if ((caseData.status || 'pending') !== 'pending') {
        const err = new Error('This credit review case is already resolved.');
        err.statusCode = 409;
        throw err;
    }

    const action = typeof payload?.action === 'string' ? payload.action : '';
    const safeNotes = typeof payload?.reviewNotes === 'string' ? payload.reviewNotes.trim().slice(0, 500) : '';
    const teacherAmount = Math.max(0, Number(payload?.teacherAmount || 0));
    const creditsHeld = Math.max(0, Number(caseData.creditsHeld || 0));
    const reviewerName = getDisplayName(reviewerProfile, 'Reviewer');

    let result;
    if (action === 'payout_full') {
        result = await settleHeldCredits(caseData.sessionId, {
            payoutToTeacher: creditsHeld,
            refundToLearner: 0,
            status: 'completed',
            settlementStatus: 'settled',
            creditStatus: 'released',
            teacherAction: 'reviewer_resolved',
            studentAction: 'reviewer_resolved',
            caseId: caseId,
            applyRatingsOnCompletion: true
        });
    } else if (action === 'refund_full' || action === 'waive_penalty') {
        result = await settleHeldCredits(caseData.sessionId, {
            payoutToTeacher: 0,
            refundToLearner: creditsHeld,
            status: action === 'waive_penalty' ? 'cancelled' : 'disputed',
            settlementStatus: 'settled',
            creditStatus: 'refunded',
            teacherAction: 'reviewer_resolved',
            studentAction: 'reviewer_resolved',
            caseId: caseId,
            applyRatingsOnCompletion: false,
            refundDescription: `Reviewer refund for ${caseData.topic || 'session'}`
        });
    } else if (action === 'split') {
        if (teacherAmount <= 0 || teacherAmount >= creditsHeld) {
            const err = new Error('Split settlements need a teacher amount between 1 and held credits minus 1.');
            err.statusCode = 400;
            throw err;
        }
        result = await settleHeldCredits(caseData.sessionId, {
            payoutToTeacher: teacherAmount,
            refundToLearner: creditsHeld - teacherAmount,
            status: 'disputed',
            settlementStatus: 'settled',
            creditStatus: 'split',
            teacherAction: 'reviewer_resolved',
            studentAction: 'reviewer_resolved',
            caseId: caseId,
            applyRatingsOnCompletion: false,
            learnerTransactionType: 'manual_adjustment',
            learnerTransactionDescription: `Reviewer split settlement for ${caseData.topic || 'session'}`,
            teacherTransactionDescription: `Reviewer split settlement for ${caseData.topic || 'session'}`,
            refundDescription: `Reviewer refund for ${caseData.topic || 'session'}`
        });
    } else if (action === 'close_no_change') {
        if (creditsHeld > 0) {
            const err = new Error('Close with no change is only allowed when no held credits remain.');
            err.statusCode = 400;
            throw err;
        }
        const sessionRef = db.collection('sessions').doc(caseData.sessionId);
        await sessionRef.set({
            settlementStatus: 'settled',
            status: 'disputed',
            creditReviewCaseId: caseId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            teacherAction: 'reviewer_resolved',
            studentAction: 'reviewer_resolved'
        }, { merge: true });
        result = { ok: true, outcome: 'closed_no_change' };
    } else {
        const err = new Error('Unsupported reviewer credit action.');
        err.statusCode = 400;
        throw err;
    }

    const casePatch = {
        status: 'resolved',
        resolution: action,
        reviewNotes: safeNotes,
        resolvedBy: reviewerProfile.uid,
        resolvedByName: reviewerName,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (action === 'split') casePatch.teacherAmount = teacherAmount;

    await Promise.all([
        caseRef.set(casePatch, { merge: true }),
        db.collection('notifications').add({
            uid: caseData.teacherUid,
            type: 'credit-review',
            title: 'Credit Review Resolved',
            message: safeNotes || `A reviewer resolved the credit issue for ${caseData.topic || 'your session'}.`,
            relatedSessionId: caseData.sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }),
        db.collection('notifications').add({
            uid: caseData.studentUid,
            type: 'credit-review',
            title: 'Credit Review Resolved',
            message: safeNotes || `A reviewer resolved the credit issue for ${caseData.topic || 'your session'}.`,
            relatedSessionId: caseData.sessionId,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        })
    ]);

    return { ok: true, ...result, action };
}

async function grantManualCredits(targetUid, reviewerProfile, amount, reason, reviewNotes) {
    const safeAmount = Math.max(0, Math.floor(Number(amount || 0)));
    if (!safeAmount) {
        const err = new Error('Top-up amount must be greater than zero.');
        err.statusCode = 400;
        throw err;
    }
    const safeReason = typeof reason === 'string' ? reason.trim().slice(0, 160) : '';
    if (!safeReason) {
        const err = new Error('A reason is required for manual credit top-ups.');
        err.statusCode = 400;
        throw err;
    }
    const safeNotes = typeof reviewNotes === 'string' ? reviewNotes.trim().slice(0, 500) : '';
    const db = getAdminDb();
    const userRef = db.collection('users').doc(targetUid);
    const result = await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
            const err = new Error('Target user not found.');
            err.statusCode = 404;
            throw err;
        }
        const userData = userSnap.data() || {};
        const credits = getCreditSnapshot(userData);
        const nextAvailable = credits.available + safeAmount;
        tx.set(userRef, {
            creditBalance: nextAvailable,
            heldCreditBalance: credits.held,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        createQueuedTransaction(tx, db, {
            uid: targetUid,
            type: 'manual_grant',
            amount: safeAmount,
            description: `${safeReason} (reviewer top-up)`,
            category: 'manual',
            relatedUserId: reviewerProfile.uid,
            balanceAfter: nextAvailable,
            heldBalanceAfter: credits.held
        });
        createQueuedNotification(tx, db, {
            uid: targetUid,
            type: 'credits',
            title: 'Credits Added',
            message: `${safeAmount} credits were added to your account by a reviewer. Reason: ${safeReason}.`
        });
        return { targetName: getDisplayName(userData, userData.email || targetUid), balanceAfter: nextAvailable };
    });

    await db.collection('creditReviewCases').add({
        sessionId: null,
        teacherUid: null,
        studentUid: targetUid,
        teacherName: '',
        studentName: result.targetName,
        topic: 'Manual credit top-up',
        caseType: 'manual_top_up',
        status: 'resolved',
        creditsHeld: 0,
        openedByUid: reviewerProfile.uid,
        openedByRole: 'reviewer',
        reviewNotes: safeNotes || safeReason,
        resolution: 'manual_top_up',
        resolvedBy: reviewerProfile.uid,
        resolvedByName: getDisplayName(reviewerProfile, 'Reviewer'),
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
        openedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { ok: true, amount: safeAmount, reason: safeReason, ...result };
}

app.post('/api/reviewer/human-verification/:id/approve', requireAuth, requireReviewer, async (req, res) => {
    try {
        const result = await resolveHumanVerificationDecision(req.params.id, req.reviewerProfile, 'verified', req.body?.reviewNotes || '');
        res.json(result);
    } catch (err) {
        console.error('[reviewer-approve]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not approve this review request.' });
    }
});

app.post('/api/reviewer/human-verification/:id/reject', requireAuth, requireReviewer, async (req, res) => {
    try {
        const result = await resolveHumanVerificationDecision(req.params.id, req.reviewerProfile, 'rejected', req.body?.reviewNotes || '');
        res.json(result);
    } catch (err) {
        console.error('[reviewer-reject]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not reject this review request.' });
    }
});

app.get('/api/reviewer/credit-review-cases', requireAuth, requireReviewer, async (req, res) => {
    try {
        const statusFilter = typeof req.query?.status === 'string' ? req.query.status : 'pending';
        const items = await listCreditReviewCases(statusFilter);
        res.json({ ok: true, items });
    } catch (err) {
        console.error('[reviewer-credit-list]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load credit review cases.' });
    }
});

app.get('/api/reviewer/credit-cases', requireAuth, requireReviewer, async (req, res) => {
    try {
        const statusFilter = typeof req.query?.status === 'string' ? req.query.status : 'pending';
        const items = await listCreditReviewCases(statusFilter);
        res.json({ ok: true, items });
    } catch (err) {
        console.error('[reviewer-credit-list-alias]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load credit review cases.' });
    }
});

app.post('/api/reviewer/credit-review-cases/:id/resolve', requireAuth, requireReviewer, async (req, res) => {
    try {
        const result = await resolveCreditReviewCase(req.params.id, req.reviewerProfile, req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[reviewer-credit-resolve]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not resolve this credit review case.' });
    }
});

app.post('/api/reviewer/credit-cases/:id/resolve', requireAuth, requireReviewer, async (req, res) => {
    try {
        const result = await resolveCreditReviewCase(req.params.id, req.reviewerProfile, req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[reviewer-credit-resolve-alias]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not resolve this credit review case.' });
    }
});

app.post('/api/reviewer/credits/top-up', requireAuth, requireReviewer, async (req, res) => {
    try {
        const result = await grantManualCredits(
            req.body?.targetUid,
            req.reviewerProfile,
            req.body?.amount,
            req.body?.reason,
            req.body?.reviewNotes || ''
        );
        res.json(result);
    } catch (err) {
        console.error('[reviewer-credit-top-up]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not top up that account.' });
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

// --- AI NOTES ROUTES (GROQ) ---
app.post('/api/generate-notes', async (req, res) => {
    try {
        const fetch = (await import('node-fetch')).default;
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
        
        const groqKey = process.env.GROQ_API_KEY;
        if (!groqKey) return res.status(500).json({ error: 'Groq API Key not configured on server' });

        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'system', content: 'You are an expert AI tutor.' }, { role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2500
            })
        });
        const data = await resp.json();
        if(data.error) return res.status(500).json({error: data.error.message});
        
        res.json({ result: data.choices[0].message.content });
    } catch (err) {
        console.error('[generate-notes]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/verify-notes', async (req, res) => {
    try {
        const fetch = (await import('node-fetch')).default;
        const { topic, notesContent } = req.body;
        if (!topic || !notesContent) return res.status(400).json({ error: 'Topic and notes content required' });

        const groqKey = process.env.GROQ_API_KEY;
        if (!groqKey) return res.status(500).json({ error: 'Groq API Key not configured on server' });

        const promptText = `You are an expert educator and fact-checker. Analyze these study notes about "${topic}" and provide a detailed verification report.

STUDY NOTES:
${notesContent}

Please analyze for:
1. ACCURACY: Are the facts correct? Point out any errors or misconceptions.
2. COMPLETENESS: What important concepts are missing?
3. CLARITY: Is the explanation clear and well-structured?
4. DEPTH: Is the content appropriate for the level (beginner/intermediate)?

CRITICAL INSTRUCTION ON SCORING: 
Do NOT automatically give 85% or any fixed number. Calculate the score fairly and dynamically between 0 and 100 based strictly on your evaluation of accuracy, completeness, clarity, and depth combined. An excellent, thorough note might get 95-100, while a mediocre note gets 60-75. Be strict and varied.

Return ONLY a JSON object with this exact structure:
{
  "score": number (0-100),
  "accuracy": { "score": number, "issues": ["..."], "strengths": ["..."] },
  "completeness": { "score": number, "missing": ["..."], "covered": ["..."] },
  "clarity": { "score": number, "feedback": "..." },
  "depth": { "score": number, "assessment": "..." },
  "summary": "Overall summary",
  "suggestions": ["..."],
  "verified_facts": ["..."],
  "needs_correction": ["..."]
}`;

        const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
            body: JSON.stringify({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are an expert educator and fact-checker. Analyze study materials and return detailed verification reports in valid JSON only. You must provide realistically spread scores (not hardcoded to 85, evaluate thoroughly).' },
                    { role: 'user', content: promptText }
                ],
                temperature: 0.6,
                max_tokens: 2000
            })
        });
        
        const data = await resp.json();
        if(data.error) return res.status(500).json({error: data.error.message});
        
        let text = data.choices[0].message.content.replace(/```json/gi, '').replace(/```/g, '').trim();
        let verification = JSON.parse(text);
        
        res.json(verification);
    } catch(err) {
        console.error('[verify-notes]', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`[SkillSwap backend] Server is running on port ${PORT}`);
    if(!process.env.GROQ_API_KEY) {
        console.warn(`[WARNING] GROQ_API_KEY is not defined in the environment. AI features will not work.`);
    }
});

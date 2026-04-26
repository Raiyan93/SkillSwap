/**
 * SkillSwap Verification Server — server.js
 *
 * KEY FIXES THIS VERSION:
 * 1. Certificate name check — AI cross-checks recipient name on cert
 *    against profile owner's firstName + lastName sent from frontend.
 *    "Google cert issued to John Smith" submitted by "Raiyan Chougle" = FAIL.
 * 2. Verification requests are not rate limited by this server.
 * 3. All previous fixes retained.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const skillPricing = require(path.join(__dirname, 'skill-pricing.js'));

const app = express();

// ─────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
    'http://localhost', 'http://127.0.0.1',
    'http://localhost:3000', 'http://localhost:5500',
    'http://127.0.0.1:5500', 'http://localhost:5501',
    'http://127.0.0.1:5501', 'http://localhost:5502',
    'http://localhost:8080',
    // Production frontend — set FRONTEND_URL on Render (e.g. https://skillswap-d2626.web.app)
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.replace(/\/+$/, '')] : []),
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
// ─────────────────────────────────────────────────────────────
// INPUT VALIDATION
// ─────────────────────────────────────────────────────────────
const MAX_SKILLS = 200;
const MAX_EXPERTISE = 500;
const MAX_URL = 300;

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
const TIMEOUT_MS = 35000;

const PRIMARY_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_FALLBACK_MODELS = String(process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index && value !== PRIMARY_GEMINI_MODEL);

const MODEL_CONFIG = {
    model: PRIMARY_GEMINI_MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0, topP: 1, topK: 1 }
};

const LEVEL_CONTEXT = {
    beginner: 'BEGINNER — low bar. Basic syntax, 1-2 small projects sufficient.',
    intermediate: 'INTERMEDIATE — medium bar. Real working projects required.',
    expert: 'EXPERT — HIGH bar. Production quality, multiple substantial projects, depth required.'
};

const CERTIFICATE_METHOD_MAX_SCORE = 80;

const CERTIFICATE_LEVEL_PATTERNS = {
    beginner: [
        /\bbeginner\b/i,
        /\bfundamentals?\b/i,
        /\bfoundations?\b/i,
        /\bintroduction\b/i,
        /\bintro\b/i,
        /\bessentials?\b/i,
        /\bbasics?\b/i,
        /\bfor beginners?\b/i
    ],
    intermediate: [
        /\bintermediate\b/i,
        /\bpractical\b/i,
        /\bapplied\b/i,
        /\bassociate\b/i,
        /\bhands[\s-]?on\b/i
    ],
    advanced: [
        /\bexpert\b/i,
        /\badvanced\b/i,
        /\bprofessional certificate\b/i,
        /\bspeciali[sz]ation\b/i,
        /\bmaster(?:s)?\b/i,
        /\bpostgraduate\b/i,
        /\bsenior\b/i,
        /\bcapstone\b/i
    ]
};

const CERTIFICATE_GENERIC_TEXT_PATTERNS = [
    /\bwhat you will learn\b/i,
    /\bskills? you will gain\b/i,
    /^skills?$/i,
    /^courses?$/i,
    /^courses?\s+speciali[sz]ations?$/i,
    /^professional certificates?$/i,
    /\bcareer resources\b/i,
    /^coursera$/i,
    /^community$/i,
    /^more$/i,
    /\bbrowse\b/i,
    /\bcatalog\b/i,
    /\blog in\b/i,
    /\bsign in\b/i,
    /\bcreate account\b/i
];

const CERT_SKILL_SYNONYMS = {
    html: ['html', 'html5'],
    css: ['css', 'css3', 'cascading style sheets'],
    javascript: ['javascript', 'js', 'ecmascript'],
    typescript: ['typescript'],
    python: ['python'],
    java: ['java'],
    'c++': ['c++', 'cpp'],
    'c#': ['c#', 'c sharp', 'csharp'],
    sql: ['sql', 'structured query language'],
    react: ['react', 'reactjs', 'react.js'],
    'node.js': ['node.js', 'nodejs'],
    nodejs: ['node.js', 'nodejs'],
    webdev: ['webdev', 'web development'],
    'web development': ['web development', 'webdev']
};

const GITHUB_SKILL_SYNONYMS = {
    html: ['html', 'html5'],
    css: ['css', 'css3', 'scss', 'sass', 'tailwind', 'bootstrap'],
    javascript: ['javascript', 'js', 'ecmascript', 'node.js', 'nodejs', 'react', 'vue', 'angular', 'next.js', 'nextjs'],
    typescript: ['typescript', 'ts', 'tsx'],
    python: ['python', 'django', 'flask', 'fastapi', 'jupyter', 'pandas'],
    java: ['java', 'spring', 'spring boot', 'android'],
    'c++': ['c++', 'cpp'],
    'c#': ['c#', 'c sharp', 'csharp', '.net', 'asp.net'],
    sql: ['sql', 'postgres', 'postgresql', 'mysql', 'sqlite'],
    react: ['react', 'reactjs', 'react.js', 'jsx', 'tsx'],
    'node.js': ['node.js', 'nodejs', 'express', 'nest', 'nest.js'],
    nodejs: ['node.js', 'nodejs', 'express', 'nest', 'nest.js'],
    webdev: ['webdev', 'web development', 'frontend', 'front end', 'backend', 'back end', 'full stack', 'fullstack', 'html', 'css', 'javascript', 'react', 'node.js', 'nodejs'],
    'web development': ['web development', 'webdev', 'frontend', 'front end', 'backend', 'back end', 'full stack', 'fullstack', 'html', 'css', 'javascript', 'react', 'node.js', 'nodejs']
};

const KNOWN_ISSUERS = [
    'Coursera', 'edX', 'Udemy', 'Google', 'Microsoft', 'AWS', 'Meta', 'IBM',
    'Stanford', 'MIT', 'Harvard', 'IIT', 'FreeCodeCamp', 'LinkedIn Learning',
    'Shaw Academy', 'Alison', 'Khan Academy', 'Codecademy', 'Pluralsight',
    'DataCamp', 'HackerRank', 'MongoDB University', 'Salesforce', 'Oracle',
    'Adobe', 'Autodesk', 'Cisco', 'CompTIA', 'NVIDIA', 'Infosys', 'TCS', 'NPTEL',
    'Simplilearn', 'Great Learning', 'upGrad', 'Scaler', 'GeeksforGeeks'
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
    const profile = { uid: snap.id, ...snap.data() };
    return clearExpiredProbationIfNeeded(uid, profile);
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

async function requireAdmin(req, res, next) {
    try {
        const profile = await getUserProfileOrThrow(req.user.uid);
        if (profile.appRole !== 'admin') {
            return res.status(403).json({ error: 'Admin access required.' });
        }
        req.adminProfile = profile;
        next();
    } catch (err) {
        console.error('[admin-auth]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not verify admin access.' });
    }
}

const MODERATION_CATEGORIES = new Set([
    'poor_teacher_behavior',
    'poor_learner_behavior',
    'harassment',
    'spam_or_scam',
    'no_show_abuse',
    'other'
]);

const DEFAULT_PROBATION_RESTRICTIONS = {
    canTeach: true,
    canReceiveRequests: true,
    canSendRequests: true,
    canSchedule: true,
    canSessionAct: true,
    canRequestVerification: true
};
const DEFAULT_PROBATION_DURATION_DAYS = 7;

function sanitizePlainText(value, maxLen = 500) {
    return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

function sanitizeModerationCategory(value) {
    const normalized = sanitizePlainText(value, 60).toLowerCase().replace(/\s+/g, '_');
    return MODERATION_CATEGORIES.has(normalized) ? normalized : 'other';
}

function getModerationCategoryLabel(category) {
    const normalized = sanitizeModerationCategory(category);
    if (normalized === 'poor_teacher_behavior') return 'Poor teacher behavior';
    if (normalized === 'poor_learner_behavior') return 'Poor learner behavior';
    if (normalized === 'harassment') return 'Harassment';
    if (normalized === 'spam_or_scam') return 'Spam or scam';
    if (normalized === 'no_show_abuse') return 'No-show abuse';
    return 'Other';
}

function sanitizeProbationRestrictions(payload) {
    const incoming = payload || {};
    return {
        canTeach: incoming.canTeach !== false,
        canReceiveRequests: incoming.canReceiveRequests !== false,
        canSendRequests: incoming.canSendRequests !== false,
        canSchedule: incoming.canSchedule !== false,
        canSessionAct: incoming.canSessionAct !== false,
        canRequestVerification: incoming.canRequestVerification !== false
    };
}

function buildModerationReasonText(category, reason) {
    const base = getModerationCategoryLabel(category);
    const safeReason = sanitizePlainText(reason, 240);
    return safeReason ? `${base}: ${safeReason}` : base;
}

async function createNotificationDirect(payload) {
    await getAdminDb().collection('notifications').add({
        uid: payload.uid,
        type: payload.type || 'admin',
        title: payload.title || 'Account update',
        message: payload.message || '',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        metadata: payload.metadata || {}
    });
}

async function appendAdminAuditLog(targetUid, payload) {
    const db = getAdminDb();
    const ref = db.collection('users').doc(targetUid);
    const snap = await ref.get();
    if (!snap.exists) {
        const err = new Error('User profile not found.');
        err.statusCode = 404;
        throw err;
    }
    const data = snap.data() || {};
    const current = Array.isArray(data.adminAuditLogs) ? data.adminAuditLogs.slice(-49) : [];
    current.push({
        id: crypto.randomUUID(),
        action: payload.action || 'admin_action',
        category: sanitizeModerationCategory(payload.category),
        reason: sanitizePlainText(payload.reason, 240),
        notes: sanitizePlainText(payload.notes, 500),
        previousStatus: payload.previousStatus || data.accountStatus || 'active',
        nextStatus: payload.nextStatus || data.accountStatus || 'active',
        actorUid: payload.actorUid || '',
        actorName: payload.actorName || '',
        targetUid,
        targetName: payload.targetName || getDisplayName(data, data.email || targetUid),
        createdAt: new Date().toISOString(),
        metadata: payload.metadata || {}
    });
    await ref.set({
        adminAuditLogs: current,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return current[current.length - 1];
}

async function appendAccountWarning(targetUid, warning) {
    const db = getAdminDb();
    const ref = db.collection('users').doc(targetUid);
    const snap = await ref.get();
    if (!snap.exists) {
        const err = new Error('User profile not found.');
        err.statusCode = 404;
        throw err;
    }
    const data = snap.data() || {};
    const warnings = Array.isArray(data.accountWarnings) ? data.accountWarnings.slice(-19) : [];
    warnings.push({
        id: crypto.randomUUID(),
        category: sanitizeModerationCategory(warning.category),
        reason: sanitizePlainText(warning.reason, 240),
        notes: sanitizePlainText(warning.notes, 500),
        createdAt: new Date().toISOString(),
        actorUid: warning.actorUid || '',
        actorName: warning.actorName || ''
    });
    await ref.set({
        accountWarnings: warnings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return warnings[warnings.length - 1];
}

async function setUserModerationState(targetUid, patch) {
    const db = getAdminDb();
    const ref = db.collection('users').doc(targetUid);
    await ref.set({
        ...patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

function isProbationExpired(probation) {
    if (!(probation && probation.active && probation.endsAt)) return false;
    return toMillis(probation.endsAt) > 0 && toMillis(probation.endsAt) <= Date.now();
}

function buildClearedProbation(probation, actorUid, actorName) {
    return {
        active: false,
        reason: '',
        restrictions: { ...DEFAULT_PROBATION_RESTRICTIONS },
        startedAt: probation?.startedAt || null,
        endsAt: probation?.endsAt || null,
        clearedAt: new Date().toISOString(),
        actorUid: actorUid || '',
        actorName: actorName || ''
    };
}

async function clearExpiredProbationIfNeeded(uid, profile) {
    if (!profile || !isProbationExpired(profile.probation)) return profile;
    const clearedProbation = buildClearedProbation(profile.probation, 'system', 'System');
    await setUserModerationState(uid, { probation: clearedProbation });
    await appendAdminAuditLog(uid, {
        action: 'probation_auto_cleared',
        category: sanitizeModerationCategory(profile.suspension?.category),
        reason: 'Probation automatically expired.',
        notes: 'Probation access restrictions were removed automatically after the expiry window elapsed.',
        previousStatus: profile.accountStatus || 'active',
        nextStatus: profile.accountStatus || 'active',
        actorUid: 'system',
        actorName: 'System',
        targetName: getDisplayName(profile, profile.email || uid),
        metadata: { previousProbation: profile.probation || null, probation: clearedProbation }
    }).catch(() => null);
    await createNotificationDirect({
        uid,
        type: 'probation-cleared',
        title: 'Probation Ended',
        message: 'Your probation period has ended automatically and full SkillSwap access is restored.'
    }).catch(() => null);
    return { ...profile, probation: clearedProbation };
}

function getModerationRestrictionSummary(probation) {
    const restrictions = probation?.restrictions || DEFAULT_PROBATION_RESTRICTIONS;
    return {
        canTeach: restrictions.canTeach !== false,
        canReceiveRequests: restrictions.canReceiveRequests !== false,
        canSendRequests: restrictions.canSendRequests !== false,
        canSchedule: restrictions.canSchedule !== false,
        canSessionAct: restrictions.canSessionAct !== false,
        canRequestVerification: restrictions.canRequestVerification !== false
    };
}

function getFeatureRestrictionActionLabel(feature) {
    if (feature === 'canReceiveRequests') return 'receive lesson requests right now';
    if (feature === 'canSendRequests') return 'send lesson requests right now';
    if (feature === 'canSchedule') return 'be scheduled right now';
    if (feature === 'canSessionAct') return 'complete session actions right now';
    return 'use this SkillSwap feature right now';
}

function getModerationReasonText(profile) {
    return profile?.suspension?.reason
        || profile?.suspension?.notes
        || profile?.suspension?.categoryLabel
        || profile?.termination?.reason
        || profile?.termination?.notes
        || profile?.termination?.categoryLabel
        || profile?.probation?.reason
        || '';
}

async function assertUserFeatureAccess(uid, feature, actorLabel = 'This account') {
    const profile = await getUserProfileOrThrow(uid);
    const accountStatus = String(profile.accountStatus || 'active').toLowerCase();
    const reason = getModerationReasonText(profile);
    if (accountStatus === 'terminated') {
        const err = new Error(`${actorLabel} has been terminated and cannot use SkillSwap right now.${reason ? ` Reason: ${reason}.` : ''}`);
        err.statusCode = 403;
        throw err;
    }
    if (accountStatus === 'suspended') {
        const err = new Error(`${actorLabel} is suspended and cannot use SkillSwap right now.${reason ? ` Reason: ${reason}.` : ''}`);
        err.statusCode = 403;
        throw err;
    }
    if (profile.probation?.active) {
        const restrictions = getModerationRestrictionSummary(profile.probation);
        if (feature && restrictions[feature] === false) {
            const err = new Error(`${actorLabel} is currently restricted and cannot ${getFeatureRestrictionActionLabel(feature)}.${reason ? ` Reason: ${reason}.` : ''}`);
            err.statusCode = 403;
            throw err;
        }
    }
    return profile;
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
    const derivedCredits = Number(getSkillCreditFromProfile(teacherProfile, connection?.skillRequested) || 0);
    if (derivedCredits > 0 && derivedCredits <= 100) return Math.round(derivedCredits);
    const rawCredits = Number(connection?.creditsOffered || 0);
    if (rawCredits > 0 && rawCredits <= 100) return Math.round(rawCredits);
    return skillPricing.getCredits(connection?.skillRequested || '', 'intermediate');
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

function parseGeminiJsonResponse(text) {
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (error) {
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(cleaned.slice(start, end + 1));
        }
        throw error;
    }
}

function isGeminiQuotaError(error) {
    const message = String(error?.message || '').toLowerCase();
    return error?.status === 429
        || error?.response?.status === 429
        || message.includes('too many requests')
        || message.includes('quota')
        || message.includes('resource exhausted');
}

function buildGeminiQuotaMessage(error) {
    const configuredModels = [PRIMARY_GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter(Boolean).join(', ');
    return `Gemini API quota exhausted on Google's side for the configured verification models (${configuredModels || 'none configured'}). There is no SkillSwap-side verification limiter active. Check the Google AI Studio project tied to this key, billing, or wait for the provider quota window to reset.`;
}

function getGeminiFallbackClients() {
    return GEMINI_FALLBACK_MODELS.map(modelName => ({
        name: modelName,
        client: genAI.getGenerativeModel({ ...MODEL_CONFIG, model: modelName })
    }));
}

async function executeGeminiCall(model, prompt, imageParts, label) {
    const response = await withTimeout(
        imageParts?.length ? model.generateContent([prompt, ...imageParts]) : model.generateContent(prompt),
        TIMEOUT_MS,
        label
    );
    return parseGeminiJsonResponse(response.response.text());
}

// ── GEMINI VERIFICATION RATE LIMITER (per-user) ──────────────────────────────
// Max 5 AI verifications per UID per hour. Each user gets an independent window.
// Resets automatically after 1 hour elapses per user, or on server restart.
const GEMINI_RATE_MAX = 5;
const GEMINI_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Map<uid, { count: number, windowStartMs: number|null }>
const _geminiRateBuckets = new Map();

function _getOrCreateBucket(uid) {
    if (!_geminiRateBuckets.has(uid)) {
        _geminiRateBuckets.set(uid, { count: 0, windowStartMs: null });
    }
    return _geminiRateBuckets.get(uid);
}

const geminiVerificationRateLimit = {
    check(uid) {
        const bucket = _getOrCreateBucket(uid);
        const now = Date.now();
        // Auto-reset if the 1-hour window has fully elapsed for this user
        if (bucket.windowStartMs !== null && (now - bucket.windowStartMs) >= GEMINI_RATE_WINDOW_MS) {
            bucket.count = 0;
            bucket.windowStartMs = null;
        }
        if (bucket.count >= GEMINI_RATE_MAX) {
            const elapsed = bucket.windowStartMs ? now - bucket.windowStartMs : 0;
            const remainingMs = Math.max(0, GEMINI_RATE_WINDOW_MS - elapsed);
            const remainingMin = Math.ceil(remainingMs / 60000);
            const err = new Error('GEMINI_VERIFICATION_RATE_LIMITED');
            err.isGeminiVerificationRateLimit = true;
            err.remainingMinutes = remainingMin;
            throw err;
        }
    },
    increment(uid) {
        const bucket = _getOrCreateBucket(uid);
        if (bucket.windowStartMs === null) bucket.windowStartMs = Date.now();
        bucket.count++;
    },
    status(uid) {
        const bucket = _getOrCreateBucket(uid);
        const now = Date.now();
        if (bucket.windowStartMs !== null && (now - bucket.windowStartMs) >= GEMINI_RATE_WINDOW_MS) {
            return { count: 0, remaining: GEMINI_RATE_MAX, resetIn: 0 };
        }
        const elapsed = bucket.windowStartMs ? now - bucket.windowStartMs : 0;
        const resetIn = bucket.windowStartMs ? Math.max(0, Math.ceil((GEMINI_RATE_WINDOW_MS - elapsed) / 60000)) : 0;
        return {
            count: bucket.count,
            remaining: Math.max(0, GEMINI_RATE_MAX - bucket.count),
            resetIn
        };
    }
};

async function callGemini(model, prompt, imageParts, uid) {
    // Enforce per-user verification rate limit (5/hour per UID)
    geminiVerificationRateLimit.check(uid);

    const candidates = [
        { name: PRIMARY_GEMINI_MODEL, client: model },
        ...getGeminiFallbackClients()
    ];
    let lastQuotaError = null;

    for (const candidate of candidates) {
        try {
            const result = await executeGeminiCall(candidate.client, prompt, imageParts, `Gemini ${candidate.name}`);
            geminiVerificationRateLimit.increment(uid); // count only on success
            return result;
        } catch (e) {
            if (e instanceof SyntaxError) {
                const strict = prompt + '\n\nCRITICAL: Valid JSON only. No markdown. Start { end }.';
                try {
                    const strictResult = await executeGeminiCall(candidate.client, strict, imageParts, `Gemini strict ${candidate.name}`);
                    geminiVerificationRateLimit.increment(uid); // count strict retry too
                    return strictResult;
                } catch (strictError) {
                    if (isGeminiQuotaError(strictError)) {
                        lastQuotaError = strictError;
                        continue;
                    }
                    throw strictError;
                }
            }
            if (isGeminiQuotaError(e)) {
                lastQuotaError = e;
                continue;
            }
            throw e;
        }
    }

    if (lastQuotaError) {
        lastQuotaError.message = buildGeminiQuotaMessage(lastQuotaError);
        throw lastQuotaError;
    }
    throw new Error('Gemini request failed.');
}

// ─────────────────────────────────────────────────────────────
// GITHUB SCORE
// ─────────────────────────────────────────────────────────────
function calcGitHubScore(profile, repos, langNames, skillLevels, ai) {
    const bd = {};
    const claimedEntries = Object.entries(skillLevels || {});
    const originalRepos = repos.filter(r => !r.isFork && r.size > 0);
    const activeOriginal = originalRepos.filter(r => r.size > 10);
    const recentOriginal = activeOriginal.filter(r => (Date.now() - new Date(r.updatedAt)) / (1000 * 60 * 60 * 24 * 30) <= 12);
    const skillEvaluations = claimedEntries.map(([skill, level]) =>
        evaluateGitHubSkillEvidence(skill, level, repos, langNames)
    );

    const avgSkillEvidence = skillEvaluations.length
        ? Math.round(skillEvaluations.reduce((sum, item) => sum + item.score, 0) / skillEvaluations.length)
        : 0;

    const ageMonths = (Date.now() - new Date(profile.created_at)) / (1000 * 60 * 60 * 24 * 30);
    const accountAge = Math.min(8, Math.floor(ageMonths / 6));
    const projectActivity = Math.min(10, (Math.min(activeOriginal.length, 4) * 2) + Math.min(recentOriginal.length, 2));
    const qualityRating = Math.max(1, Math.min(10, Number(ai?.qualityRating) || 5));
    const aiQuality = Math.min(12, Math.round((qualityRating / 10) * 12));

    const score = Math.max(
        0,
        Math.min(100, Math.round((avgSkillEvidence * 0.86) + (accountAge * 0.5) + (projectActivity * 0.6) + (aiQuality * 0.7)))
    );

    bd.claimedSkillEvidence = `${avgSkillEvidence}/100 avg across claimed skills`;
    bd.claimedSkillOutcomes = skillEvaluations.length
        ? skillEvaluations.map(item => `${item.skill} ${item.score}/100 (${item.status}, ${item.level})`).join(' | ')
        : 'No claimed skills';
    bd.accountAge = `${accountAge}/8 (${Math.floor(ageMonths)}mo)`;
    bd.projectActivity = `${projectActivity}/10 (${activeOriginal.length} active original, ${recentOriginal.length} recent original)`;
    bd.aiQuality = `${aiQuality}/12 (rating: ${qualityRating}/10)`;
    bd.levelCalibration = 'Included inside each claimed skill score';

    return { score, breakdown: bd, skillEvaluations };
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
        stars: r.stargazers_count, forks: r.forks_count, topics: r.topics || [],
        updatedAt: r.updated_at, createdAt: r.created_at,
        size: r.size, isFork: r.fork,
    }));
};

const getLangs = async (u, repos) => {
    const targets = repos.filter(r => !r.isFork && r.size > 10).slice(0, 6);
    const lc = {};
    await Promise.all(targets.map(r =>
        ghGet(`/repos/${u}/${r.name}/languages`).then(res => {
            for (const [l, b] of Object.entries(res.data)) lc[l] = (lc[l] || 0) + b;
        }).catch(() => { })
    ));
    return Object.entries(lc).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([l]) => l);
};

const detectClones = async (u, repos) => {
    const suspects = [];
    for (const r of repos.filter(r => !r.isFork && r.size > 50).sort((a, b) => b.size - a.size).slice(0, 4)) {
        try {
            const res = await ghGet(`/repos/${u}/${r.name}/contributors`);
            const user = res.data.find(c => c.login.toLowerCase() === u.toLowerCase());
            const n = user ? user.contributions : 0;
            if (n === 0) suspects.push({ name: r.name, reason: '0 commits by owner — likely cloned' });
            else if (n < 3 && r.stars > 30) suspects.push({ name: r.name, reason: `Only ${n} commit(s), ${r.stars} stars` });
        } catch (_) { }
    }
    return suspects;
};

// ─────────────────────────────────────────────────────────────
// IMAGE HELPERS
// ─────────────────────────────────────────────────────────────
const fetchB64 = async url => {
    try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000 });
        const mime = r.headers['content-type'] || 'image/jpeg';
        if (mime.includes('pdf') || url.toLowerCase().endsWith('.pdf')) return null;
        return { inlineData: { data: Buffer.from(r.data).toString('base64'), mimeType: mime } };
    } catch (_) { return null; }
};

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const clean = normalizeWhitespace(value);
        const key = clean.toLowerCase();
        if (!clean || seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
    }
    return out;
}

function normalizeSkillKey(value) {
    return normalizeWhitespace(String(value || '').toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' '));
}

function getSkillTerms(skill, mode = 'github') {
    const key = normalizeSkillKey(skill);
    const map = mode === 'cert' ? CERT_SKILL_SYNONYMS : GITHUB_SKILL_SYNONYMS;
    return uniqueStrings([key, ...(map[key] || [])].map(normalizeSkillKey));
}

function textContainsSkillTerm(text, term) {
    const source = normalizeSkillKey(text);
    const target = normalizeSkillKey(term);
    if (!source || !target) return false;
    const pattern = new RegExp(`(^|[^a-z0-9+#])${escapeRegex(target)}($|[^a-z0-9+#])`, 'i');
    return pattern.test(source);
}

function textContainsAnySkillTerm(text, terms) {
    return (terms || []).some(term => textContainsSkillTerm(text, term));
}

function extractHeadingTexts(html) {
    return Array.from(String(html || '').matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
        .map(match => stripHtmlToText(match[1]))
        .filter(Boolean)
        .slice(0, 12);
}

function parseDateValue(value) {
    const normalized = normalizeWhitespace(String(value || '').replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1'));
    if (!normalized || normalized === 'not shown') return null;
    const ts = Date.parse(normalized);
    if (Number.isNaN(ts)) return null;
    return new Date(ts);
}

function formatDateIso(value) {
    const date = value instanceof Date ? value : parseDateValue(value);
    return date ? date.toISOString().slice(0, 10) : null;
}

function isFutureCalendarDate(value) {
    const date = value instanceof Date ? value : parseDateValue(value);
    if (!date) return false;
    const compare = new Date(date.getTime());
    compare.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return compare.getTime() > today.getTime();
}

function joinList(values) {
    const items = uniqueStrings(values);
    if (!items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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

function isRecipientNameMissing(value) {
    const normalized = normalizeWhitespace(String(value || '')).toLowerCase();
    return !normalized || ['not shown', 'not visible', 'unknown', 'recipient not shown', 'name not visible'].includes(normalized);
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

function evaluateCertificateNameCheck(profileName, recipientName) {
    const normalizedProfileName = normalizeWhitespace(profileName);
    const normalizedRecipientName = normalizeWhitespace(recipientName);

    if (!normalizedProfileName) {
        return {
            passed: false,
            nameMismatch: false,
            missingProfileName: true,
            missingRecipientName: false,
            recipientName: normalizedRecipientName || 'not shown',
            reason: 'Your profile first and last name are required for certificate ownership verification.'
        };
    }

    if (isRecipientNameMissing(normalizedRecipientName)) {
        return {
            passed: false,
            nameMismatch: false,
            missingProfileName: false,
            missingRecipientName: true,
            recipientName: 'not shown',
            reason: 'The certificate page does not show a recipient name, so ownership cannot be verified.'
        };
    }

    if (!namesLikelyMatch(normalizedProfileName, normalizedRecipientName)) {
        return {
            passed: false,
            nameMismatch: true,
            missingProfileName: false,
            missingRecipientName: false,
            recipientName: normalizedRecipientName,
            reason: `The certificate recipient ${normalizedRecipientName} does not match the profile owner.`
        };
    }

    return {
        passed: true,
        nameMismatch: false,
        missingProfileName: false,
        missingRecipientName: false,
        recipientName: normalizedRecipientName,
        reason: 'Certificate recipient matches the profile owner.'
    };
}

function parseClaimedSkills(skills, skillLevels) {
    const fromLevels = Object.keys(skillLevels || {}).map(s => normalizeWhitespace(s)).filter(Boolean);
    if (fromLevels.length) return fromLevels;
    return String(skills || '')
        .split(/[,\n]/)
        .map(s => normalizeWhitespace(s))
        .filter(Boolean);
}

function inferSkillMatchFromVerdicts(verdicts) {
    if (verdicts?.verifiedSkills?.length) return 'direct';
    if (verdicts?.partialSkills?.length) return 'partial';
    return 'none';
}

function evaluateClaimedCertificateSkills(claimedSkills, sources, options = {}) {
    const primaryTexts = uniqueStrings(sources?.primaryTexts || []);
    const secondaryTexts = uniqueStrings(sources?.secondaryTexts || []);
    const urlTermsOnly = !!options.urlTermsOnly;

    const verifiedSkills = [];
    const partialSkills = [];
    const unverifiedSkills = [];
    const matchedSignals = [];

    for (const skill of claimedSkills || []) {
        const terms = getSkillTerms(skill, 'cert');
        const primaryMatch = primaryTexts.some(text => textContainsAnySkillTerm(text, terms));
        const secondaryMatch = secondaryTexts.some(text => textContainsAnySkillTerm(text, terms));
        if (primaryMatch && !urlTermsOnly) {
            verifiedSkills.push(skill);
            matchedSignals.push(`${skill}: exact title or heading match`);
        } else if (primaryMatch || secondaryMatch) {
            partialSkills.push(skill);
            matchedSignals.push(`${skill}: exact term found outside the main title`);
        } else {
            unverifiedSkills.push(skill);
        }
    }

    return {
        verifiedSkills,
        partialSkills,
        unverifiedSkills,
        matchedSignals,
        skillMatch: inferSkillMatchFromVerdicts({ verifiedSkills, partialSkills, unverifiedSkills })
    };
}

function buildCertificateReasoning({
    platformName,
    pageAccessible,
    recipientName,
    nameMismatch,
    nameCheckPassed = true,
    nameCheckReason = '',
    skipRecipientLine = false,
    completionDate,
    completionDateFuture,
    verifiedSkills,
    partialSkills,
    unverifiedSkills
}) {
    const authenticityLine = pageAccessible
        ? `The public certificate page loaded from ${platformName} and the authenticity score used visible issuer, URL, and page details.`
        : `The certificate page could not be fully loaded, so this score relies on trusted URL and platform signals instead of the full page contents.`;
    const identityLine = !nameCheckPassed && nameCheckReason
        ? nameCheckReason
        : nameMismatch
            ? 'The recipient name on the certificate does not match the profile owner, so the certificate cannot be accepted as yours.'
            : recipientName && recipientName !== 'not shown'
                ? `The certificate recipient is shown as ${recipientName}.`
                : 'The certificate recipient name was not clearly visible on the public page.';
    let dateLine = 'No reliable completion date could be validated from the public certificate data.';
    if (completionDate && completionDate !== 'not shown') {
        dateLine = completionDateFuture
            ? `The displayed completion date ${completionDate} is later than today, so that date is treated as a red flag.`
            : `The displayed completion date ${completionDate} is consistent with a completed certificate.`;
    }
    const skillLine = verifiedSkills.length
        ? `Exact claimed-skill matches were found for ${joinList(verifiedSkills)}.`
        : partialSkills.length
            ? `Only limited exact claimed-skill matches were found for ${joinList(partialSkills)}.`
            : 'This certificate does not directly name any of the claimed skills.';
    const gapLine = unverifiedSkills.length
        ? `${joinList(unverifiedSkills)} still needs separate evidence.`
        : 'Only the claimed skills were evaluated in this summary.';

    const lines = [authenticityLine];
    if (!skipRecipientLine) lines.push(identityLine);
    if (nameCheckPassed && !nameMismatch) lines.push(dateLine);
    lines.push(skillLine);
    if (gapLine && nameCheckPassed && !nameMismatch) lines.push(gapLine);
    return lines.filter(Boolean).join(' ');
}

function filterCertificateAiSuspiciousSignals(signals, options = {}) {
    const completionDateFuture = !!options.completionDateFuture;
    return (signals || [])
        .map(signal => normalizeWhitespace(signal))
        .filter(Boolean)
        .filter(signal => {
            if (!completionDateFuture && /(completion date|copyright year|is in the future|future)/i.test(signal)) {
                return false;
            }
            return true;
        });
}

function detectCertificateLevelStrength(text) {
    const source = normalizeWhitespace(text);
    if (!source) return 'general';

    const hasHit = group => (CERTIFICATE_LEVEL_PATTERNS[group] || []).some(pattern => pattern.test(source));
    if (hasHit('beginner')) return 'beginner';
    if (hasHit('intermediate')) return 'intermediate';
    if (hasHit('advanced')) return 'advanced';
    return 'general';
}

function isCertificateSpecificText(text, options = {}) {
    const source = normalizeWhitespace(text);
    if (!source) return false;
    if (options.allowGeneric) return true;
    return !CERTIFICATE_GENERIC_TEXT_PATTERNS.some(pattern => pattern.test(source));
}

function resolveCertificateLevelStrength(evidence = {}) {
    const primaryTexts = uniqueStrings([
        evidence.certificateSubject,
        evidence.title
    ].filter(Boolean));
    const headingTexts = uniqueStrings((evidence.headingTexts || []).filter(text => isCertificateSpecificText(text)));
    const secondaryTexts = uniqueStrings([
        evidence.metaDescription
    ].filter(text => isCertificateSpecificText(text, { allowGeneric: true })));
    const fallbackTexts = uniqueStrings([evidence.fallbackText].filter(Boolean));

    const orderedGroups = [
        { texts: primaryTexts, source: 'primary' },
        { texts: headingTexts, source: 'heading' },
        { texts: secondaryTexts, source: 'meta' },
        { texts: fallbackTexts, source: 'fallback' }
    ];

    for (const group of orderedGroups) {
        const joined = group.texts.join(' ');
        const strength = detectCertificateLevelStrength(joined);
        if (strength !== 'general') {
            return { strength, source: group.source, headingTexts };
        }
    }

    return { strength: 'general', source: 'none', headingTexts };
}

function getLevelEvidenceWeight(level, strength, matchType, allowExpertPartial = false) {
    const levelKey = String(level || '').toLowerCase();
    if (matchType === 'none') return 0;

    const table = {
        beginner: {
            direct: { beginner: 31, general: 27, intermediate: 20, advanced: 15 },
            partial: { beginner: 14, general: 10, intermediate: 7, advanced: 4 }
        },
        intermediate: {
            direct: { beginner: 13, general: 19, intermediate: 25, advanced: 22 },
            partial: { beginner: 4, general: 8, intermediate: 12, advanced: 8 }
        },
        expert: {
            direct: { beginner: 0, general: 7, intermediate: 15, advanced: 28 },
            partial: { beginner: 0, general: allowExpertPartial ? 2 : 0, intermediate: allowExpertPartial ? 5 : 1, advanced: allowExpertPartial ? 10 : 5 }
        }
    };

    const levelTable = table[levelKey] || table.intermediate;
    return levelTable[matchType]?.[strength] ?? 0;
}

function computeCertLinkSkillScore(skillLevels, certSkillVerdicts, certificateEvidence) {
    const { strength } = resolveCertificateLevelStrength(certificateEvidence);
    const scores = [];
    for (const [skill, level] of Object.entries(skillLevels || {})) {
        const matchType = certSkillVerdicts.verifiedSkills.includes(skill)
            ? 'direct'
            : certSkillVerdicts.partialSkills.includes(skill)
                ? 'partial'
                : 'none';
        scores.push(getLevelEvidenceWeight(level, strength, matchType, false));
    }
    if (!scores.length) return 0;
    return Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

function applyImageCertificateLevelCalibration(result, skillLevels) {
    const levelEvidence = resolveCertificateLevelStrength({
        certificateSubject: result.certificateSubject || '',
        title: result.certificateSubject || ''
    });
    const strength = levelEvidence.strength;
    const entries = Object.entries(skillLevels || {});
    if (!entries.length) return result;

    let bestMatchType = result.skillMatch === 'direct' ? 'direct' : result.skillMatch === 'partial' ? 'partial' : 'none';
    let maxWeight = 0;
    for (const [, level] of entries) {
        maxWeight = Math.max(maxWeight, getLevelEvidenceWeight(level, strength, bestMatchType, true));
    }

    let offset = 0;
    if (bestMatchType === 'direct') {
        if (maxWeight >= 22) offset += 8;
        else if (maxWeight >= 16) offset += 2;
        else if (maxWeight >= 10) offset -= 6;
        else offset -= 14;
    } else if (bestMatchType === 'partial') {
        if (maxWeight >= 10) offset += 0;
        else if (maxWeight >= 6) offset -= 8;
        else offset -= 15;
    }

    if (result.levelMatch === false) offset -= 8;
    if (result.levelMatch === true && maxWeight >= 20) offset += 4;

    result.confidenceScore = Math.max(0, Math.min(CERTIFICATE_METHOD_MAX_SCORE, Math.round((Number(result.confidenceScore) || 0) + offset)));
    result.levelCalibration = `Level-aware certificate weighting applied (${strength} evidence).`;
    result.isVerified = result.confidenceScore >= 50 && !result.nameMismatch && !result.tamperDetected && !result.aiGeneratedSuspicion && result.skillMatch !== 'none';
    return result;
}

function sanitizeCertificateLimitationText(value, options = {}) {
    const text = normalizeWhitespace(value);
    if (!text) return '';
    if (!options.completionDateFuture && /(future completion|future date|date is in the future|future authenticity)/i.test(text)) {
        return 'This evaluation is based on the provided public certificate page and direct claimed-skill matching.';
    }
    return text;
}

function evaluateGitHubSkillEvidence(skillName, level, repos, langNames) {
    const terms = getSkillTerms(skillName, 'github');
    const levelKey = String(level || '').toLowerCase();
    const originalRepos = repos.filter(repo => !repo.isFork && repo.size > 0);
    const relevantRepos = originalRepos.map(repo => {
        const nameHit = textContainsAnySkillTerm(repo.name, terms);
        const descHit = textContainsAnySkillTerm(repo.desc, terms);
        const topicHit = textContainsAnySkillTerm((repo.topics || []).join(' '), terms);
        const langHit = textContainsAnySkillTerm(repo.language, terms);
        if (!nameHit && !descHit && !topicHit && !langHit) return null;

        const recent = (Date.now() - new Date(repo.updatedAt)) / (1000 * 60 * 60 * 24 * 30) <= 18;
        const substantial = Number(repo.size || 0) > 40;
        return {
            name: repo.name,
            nameHit,
            descHit,
            topicHit,
            langHit,
            recent,
            substantial,
            stars: Number(repo.stars || 0)
        };
    }).filter(Boolean);

    const relevantCount = relevantRepos.length;
    const strongCount = relevantRepos.filter(repo => repo.langHit || repo.nameHit || repo.topicHit).length;
    const namedCount = relevantRepos.filter(repo => repo.nameHit).length;
    const descriptiveCount = relevantRepos.filter(repo => repo.descHit || repo.topicHit).length;
    const activeCount = relevantRepos.filter(repo => repo.recent || repo.substantial).length;
    const overallLangHit = (langNames || []).some(language => textContainsAnySkillTerm(language, terms));

    let baseScore = 0;
    baseScore += Math.min(30, relevantCount * 12);
    baseScore += Math.min(20, strongCount * 8);
    baseScore += namedCount ? Math.min(15, 8 + ((namedCount - 1) * 3)) : 0;
    baseScore += descriptiveCount ? Math.min(15, 5 + ((descriptiveCount - 1) * 5)) : 0;
    baseScore += overallLangHit ? 10 : 0;
    baseScore += Math.min(10, activeCount * 4);

    let levelOffset = 0;
    if (levelKey === 'beginner') {
        levelOffset += 10;
        if (relevantCount > 0) levelOffset += 4;
    } else if (levelKey === 'expert') {
        levelOffset -= 14;
        if (strongCount < 2) levelOffset -= 10;
        if (activeCount < 2) levelOffset -= 8;
        if (namedCount < 1) levelOffset -= 6;
    } else {
        if (strongCount < 1) levelOffset -= 6;
        if (activeCount < 1) levelOffset -= 4;
    }

    const score = Math.max(0, Math.min(100, Math.round(baseScore + levelOffset)));

    const thresholds = {
        beginner: { verified: 32, partial: 20 },
        intermediate: { verified: 48, partial: 32 },
        expert: { verified: 62, partial: 44 }
    }[levelKey] || { verified: 48, partial: 32 };

    const status = score >= thresholds.verified
        ? 'verified'
        : score >= thresholds.partial
            ? 'partial'
            : 'unverified';

    const supportingRepos = relevantRepos
        .sort((left, right) => {
            const leftStrength = Number(left.langHit) + Number(left.nameHit) + Number(left.topicHit) + Number(left.descHit);
            const rightStrength = Number(right.langHit) + Number(right.nameHit) + Number(right.topicHit) + Number(right.descHit);
            return rightStrength - leftStrength || right.stars - left.stars;
        })
        .slice(0, 3)
        .map(repo => repo.name);

    return { skill: skillName, level, score, status, supportingRepos, baseScore, levelOffset };
}

function buildGitHubReasoning(skillEvaluations) {
    const verifiedSkills = skillEvaluations.filter(item => item.status === 'verified').map(item => item.skill);
    const partialSkills = skillEvaluations.filter(item => item.status === 'partial').map(item => item.skill);
    const unverifiedSkills = skillEvaluations.filter(item => item.status === 'unverified').map(item => item.skill);
    const repoEvidence = skillEvaluations
        .filter(item => item.supportingRepos.length)
        .map(item => `${item.skill}: ${item.supportingRepos.join(', ')}`)
        .slice(0, 3);

    const line1 = verifiedSkills.length
        ? `Strong GitHub evidence supports ${joinList(verifiedSkills)} at the claimed level.`
        : partialSkills.length
            ? `The public repos show some evidence for ${joinList(partialSkills)}, but the claimed level still needs stronger proof.`
            : 'The public repos do not yet provide strong enough evidence for the claimed skills.';
    const line2 = repoEvidence.length
        ? `Supporting original repositories among the claimed skills: ${repoEvidence.join('; ')}.`
        : 'Only the claimed skills were scored; unrelated repository technologies were ignored.';
    const line3 = unverifiedSkills.length
        ? `${joinList(unverifiedSkills)} still needs clearer original-project evidence.`
        : 'Only the claimed skills were included in this GitHub summary.';

    return [line1, line2, line3].join(' ');
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

function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanCertificateSubjectCandidate(value, platformName = '') {
    let text = normalizeWhitespace(value);
    if (!text) return '';
    if (platformName) {
        text = text.replace(new RegExp(`\\s*[|:-]\\s*${escapeRegex(platformName)}\\s*$`, 'i'), '');
    }
    text = text
        .replace(/\s*[|:-]\s*(coursera|credly|linkedin learning|freecodecamp|nptel|edx|udemy|hackerrank|datacamp|google|aws|microsoft learn|mongodb university)\s*$/i, '')
        .replace(/^(view|verify|public)\s+(certificate|credential|badge)\s*[:\-]?\s*/i, '')
        .replace(/^(certificate|credential|badge)\s+(verification|page)\s*[:\-]?\s*/i, '')
        .trim();
    if (!text) return '';
    if (/^(sign in|log in|home|catalog|browse|search|share)$/i.test(text)) return '';
    if (/(online courses & credentials|join for free|top educators|browse catalog|sign up|create account)/i.test(text)) return '';
    return text;
}

function extractRecipientNameFromCertificatePage(page) {
    const html = String(page?.html || '');
    const text = normalizeWhitespace(page?.text || '');
    const patterns = [
        /"recipientName"\s*:\s*"([^"]{3,120})"/i,
        /"fullName"\s*:\s*"([^"]{3,120})"/i,
        /(?:recipient|issued to|awarded to|presented to|learner|student)\s*[:\-]?\s*["“]?([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})["”]?/i,
        /this is to certify that\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/i
    ];

    for (const source of [html, text]) {
        for (const pattern of patterns) {
            const match = String(source || '').match(pattern);
            const candidate = normalizeWhitespace(match?.[1] || '').replace(/\\"/g, '"');
            if (!candidate) continue;
            if (candidate.length > 80) continue;
            if (!/[a-z]/i.test(candidate)) continue;
            if (/(certificate|credential|course|specialization|professional|introduction|coursera|credly|linkedin|google)/i.test(candidate) && candidate.split(' ').length < 2) {
                continue;
            }
            return candidate;
        }
    }
    return 'not shown';
}

function extractCertificateSubjectFromPage(page, platform) {
    const headingTexts = extractHeadingTexts(page?.html || '');
    const candidates = uniqueStrings([
        cleanCertificateSubjectCandidate(page?.title, platform?.platformName),
        ...headingTexts.map(text => cleanCertificateSubjectCandidate(text, platform?.platformName)),
        cleanCertificateSubjectCandidate(page?.metaDescription, platform?.platformName)
    ].filter(Boolean));

    for (const candidate of candidates) {
        if (candidate.length < 4) continue;
        if (/^(sign in|log in|home|catalog|browse|search|share)$/i.test(candidate)) continue;
        return candidate;
    }

    return 'not shown';
}

// ─────────────────────────────────────────────────────────────
// MAIN ROUTE
// ─────────────────────────────────────────────────────────────
app.post('/api/verify', async (req, res) => {
    const { type, skillLevels = {}, portfolioUrls } = req.body;

    // UID is used for per-user rate limiting — falls back to a safe placeholder
    // so unauthenticated/anonymous requests share one bucket rather than bypassing limits.
    const callerUid = (typeof req.body.uid === 'string' && req.body.uid.trim())
        ? req.body.uid.trim()
        : 'anonymous';

    const svSkills = sanitize(req.body.skills, MAX_SKILLS, 'skills');
    const svExpertise = sanitize(req.body.expertise, MAX_EXPERTISE, 'expertise');
    if (svSkills.error) return res.status(400).json({ error: svSkills.error });
    if (!svSkills.value) return res.status(400).json({ error: 'No skills provided.' });
    if (typeof skillLevels !== 'object' || Array.isArray(skillLevels))
        return res.status(400).json({ error: 'skillLevels must be an object.' });
    if (Object.keys(skillLevels).length > 15)
        return res.status(400).json({ error: 'Too many skills (max 15).' });

    const skills = svSkills.value;
    const expertise = svExpertise.value;

    // Profile owner name — used for certificate name matching
    const firstName = (req.body.profileFirstName || '').trim().toLowerCase();
    const lastName = (req.body.profileLastName || '').trim().toLowerCase();
    const fullName = `${firstName} ${lastName}`.trim();

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

            const bio = profile.bio || '';
            const ownershipVerified = bio.toLowerCase().includes(OWNERSHIP_CODE.toLowerCase());

            const [langNames, clones] = await Promise.all([
                getLangs(username, repos),
                detectClones(username, repos)
            ]);

            const orig = repos.filter(r => !r.isFork && r.size > 0);
            const fresh = orig.filter(r => (Date.now() - new Date(r.createdAt)) / (1000 * 60 * 60 * 24) < 7);
            const lvlLines = Object.entries(skillLevels).map(([s, l]) => `  - ${s}: ${LEVEL_CONTEXT[l] || LEVEL_CONTEXT.intermediate}`).join('\n') || `  ${skills}`;

            const aiPrompt = `Rate this developer's original code quality 1-10. Do NOT produce a confidence score.

Developer: ${profile.login} | Created: ${profile.created_at} | Followers: ${profile.followers}
Skills claimed:
${lvlLines}
Languages in original repos: ${langNames.join(', ') || 'none'}
Original repos: ${orig.length} | Forks: ${repos.filter(r => r.isFork).length}
${fresh.length ? `⚠️ Fresh repos (<7 days): ${fresh.map(r => r.name).join(', ')}` : ''}
${clones.length ? `⚠️ Clone suspects:\n${clones.map(s => `- ${s.name}: ${s.reason}`).join('\n')}` : ''}

Top original repos:
${JSON.stringify(orig.slice(0, 15).map(r => ({ name: r.name, desc: r.desc, language: r.language, stars: r.stars, topics: r.topics, size: r.size })), null, 2)}

User description: "${expertise}"

Respond ONLY in valid JSON (no markdown):
{
  "qualityRating": number (1-10),
  "reasoning": "3 short sentences about original-code quality only.",
  "developerSummary": "5-7 sentences. Mention only the claimed skills and specific supporting repositories. Do not mention unrelated stack items."
}`;

            const ai = await callGemini(model, aiPrompt, null, callerUid);
            const { score, breakdown, skillEvaluations } = calcGitHubScore(profile, repos, langNames, skillLevels, ai);
            const verifiedSkills = skillEvaluations.filter(item => item.status === 'verified').map(item => item.skill);
            const partialSkills = skillEvaluations.filter(item => item.status === 'partial').map(item => item.skill);
            const unverifiedSkills = skillEvaluations.filter(item => item.status === 'unverified').map(item => item.skill);

            let finalScore = score, clonePenalty = 0;
            if (clones.length >= 3) { clonePenalty = 25; finalScore = Math.max(0, score - 25); }
            else if (clones.length >= 1) { clonePenalty = 10; finalScore = Math.max(0, score - 10); }

            const result = {
                isVerified: finalScore >= 60 && verifiedSkills.length > 0,
                confidenceScore: finalScore,
                verifiedSkills,
                unverifiedSkills,
                partialSkills,
                scoreBreakdown: breakdown,
                cloneWarning: clones.length > 0,
                cloneDetails: clones,
                clonePenalty,
                originalRepoCount: orig.length,
                forkedRepoCount: repos.filter(r => r.isFork).length,
                languagesFound: langNames,
                analysisSource: 'gemini',
                reasoning: normalizeWhitespace(ai.developerSummary || buildGitHubReasoning(skillEvaluations)),
                ownershipVerified,
            };

            if (!ownershipVerified) {
                result.isVerified = false;
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
                    imageResults.push({
                        index: i + 1, isVerified: false, confidenceScore: 0, tamperDetected: false,
                        error: 'PDF cannot be analyzed. Export as PNG or JPG and re-upload.'
                    });
                    continue;
                }
                const part = await fetchB64(url);
                if (!part) {
                    imageResults.push({
                        index: i + 1, isVerified: false, confidenceScore: 0,
                        error: 'Could not load image. If PDF, export as PNG/JPG first.'
                    });
                    continue;
                }

                const lvlLines = Object.entries(skillLevels).map(([s, l]) => `- ${s}: claimed as ${l}`).join('\n') || skills;

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

Image ${i + 1} of ${portfolioUrls.length} — analyze this one only.

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

SKILL & LEVEL VERIFICATION — READ CAREFULLY:
The user claims the following skills and levels:
${lvlLines}

Step 1 — Classify the certificate's actual level from its visible title and course name:
  - "Introduction to...", "Intro to...", "Fundamentals of...", "Basics of...", "Getting Started with..." → certifiedLevel: "beginner"
  - "Intermediate...", "Applied...", "Practitioner..." → certifiedLevel: "intermediate"
  - "Advanced...", "Professional...", "Expert...", "Mastery..." → certifiedLevel: "expert"
  - No level indicator in the title → certifiedLevel: "general"

Step 2 — Compare certifiedLevel against the user's claimed level and set levelMatch:
  - User claims "expert" + certifiedLevel is "beginner" → levelMatch: false (SEVERE mismatch)
  - User claims "expert" + certifiedLevel is "intermediate" → levelMatch: false (moderate mismatch)
  - User claims "expert" + certifiedLevel is "expert" or "general" → levelMatch: true
  - User claims "intermediate" + certifiedLevel is "beginner" → levelMatch: false
  - User claims "intermediate" + certifiedLevel is "intermediate", "expert", or "general" → levelMatch: true
  - User claims "beginner" + certifiedLevel is anything → levelMatch: true

Step 3 — Set confidenceScore based on ALL factors above:
  - Intro-level cert for an expert claim: score 15–30 (the cert proves beginner knowledge only)
  - Intro-level cert for an intermediate claim: score 25–45
  - Matching level, direct skill match, credible issuer: score 55–${CERTIFICATE_METHOD_MAX_SCORE}
  - Partial skill match: reduce by 15–20
  - levelMatch: false: reduce further by 10–20
  - This certificate method is capped at ${CERTIFICATE_METHOD_MAX_SCORE}/100.

Respond ONLY in valid JSON (no markdown, no backticks):
{
  "recipientName": "name found on certificate or 'not visible'",
  "nameMismatch": boolean,
  "nameMismatchReason": "brief reason or 'Names match'",
  "isVerified": boolean,
  "confidenceScore": number (0-${CERTIFICATE_METHOD_MAX_SCORE}, must be 0 if nameMismatch true),
  "tamperDetected": boolean,
  "tamperConfidence": "high / medium / low / none",
  "tamperDetails": "what looks edited OR 'No tampering detected'",
  "aiGeneratedSuspicion": boolean,
  "aiGeneratedReason": "why or 'Looks like a real document'",
  "issuer": "issuing body name",
  "issuerCredible": boolean,
  "certificateSubject": "exact course/certificate title visible on the image",
  "certifiedLevel": "beginner / intermediate / expert / general",
  "skillMatch": "direct / partial / none",
  "levelMatch": boolean,
  "reasoning": "4 sentences: name check, tamper assessment, skill match, level comparison"
}`;

                const j = await callGemini(model, prompt, [part], callerUid);

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

                // Hard level-mismatch caps: a lower-level cert cannot prove a higher-level claim
                const claimedLevels = Object.values(skillLevels || {}).map(l => String(l).toLowerCase());
                const certLevel = String(j.certifiedLevel || '').toLowerCase();
                const userClaimsExpert = claimedLevels.some(l => l === 'expert');
                const userClaimsIntermediate = claimedLevels.some(l => l === 'intermediate');
                if (certLevel === 'beginner') {
                    if (userClaimsExpert) {
                        j.confidenceScore = Math.min(j.confidenceScore, 30);
                        j.levelMatch = false;
                        j.levelMismatchWarning = 'Beginner/introductory certificate cannot support an expert-level claim.';
                    } else if (userClaimsIntermediate) {
                        j.confidenceScore = Math.min(j.confidenceScore, 45);
                        j.levelMatch = false;
                        j.levelMismatchWarning = 'Introductory certificate partially supports an intermediate claim.';
                    }
                } else if (certLevel === 'intermediate' && userClaimsExpert) {
                    j.confidenceScore = Math.min(j.confidenceScore, 50);
                    j.levelMatch = false;
                    j.levelMismatchWarning = 'Intermediate certificate cannot fully support an expert-level claim.';
                }

                applyImageCertificateLevelCalibration(j, skillLevels);
                j.confidenceScore = Math.max(0, Math.min(CERTIFICATE_METHOD_MAX_SCORE, Math.round(Number(j.confidenceScore) || 0)));
                j.isVerified = j.confidenceScore >= 50 && !j.nameMismatch && !j.tamperDetected && !j.aiGeneratedSuspicion && j.skillMatch !== 'none';

                imageResults.push({ index: i + 1, url, ...j });
            }

            const forged = imageResults.filter(r => r.tamperDetected && r.tamperConfidence === 'high');
            const namesFailed = imageResults.filter(r => r.nameMismatch);
            const verified = imageResults.filter(r => r.isVerified);
            const valid = imageResults.filter(r => !r.error);
            const avgScore = valid.length ? Math.round(valid.reduce((a, b) => a + (b.confidenceScore || 0), 0) / valid.length) : 0;

            if (imageResults.every(r => r.error?.includes('PDF'))) {
                return res.json({
                    isVerified: false, confidenceScore: 0, imageResults, pdfError: true,
                    summary: 'All files are PDFs. Export as PNG or JPG and re-upload.'
                });
            }

            let summary;
            if (namesFailed.length) summary = `Name mismatch on ${namesFailed.length} cert(s). Certificate must be issued to "${fullName || 'you'}".`;
            else if (forged.length) summary = `FORGERY on ${forged.length} image(s). Rejected.`;
            else if (verified.length) summary = `${verified.length}/${imageResults.length} cert(s) verified.`;
            else summary = 'No certificates verified. Check skill match and image quality.';

            return res.json({
                isVerified: namesFailed.length === 0 && forged.length === 0 && verified.length > 0,
                confidenceScore: (namesFailed.length || forged.length) ? 0 : avgScore,
                imageCount: imageResults.length,
                imageResults,
                forgedCount: forged.length,
                nameMismatchCount: namesFailed.length,
                verifiedCount: verified.length,
                summary,
            });
        }

        // ── CERTIFICATE LINK ─────────────────────────────────
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
                if (page.loginWall) {
                    return res.status(400).json({ error: 'Certificate page must be publicly accessible without login for Gemini verification.' });
                }
                const suffix = page.errorMessage ? ` (${page.errorMessage})` : '';
                return res.status(400).json({ error: `Could not load the public certificate page for Gemini verification${suffix}.` });
            }

            const pageSummary = normalizeWhitespace([
                page.title,
                page.metaDescription,
                page.text
            ].filter(Boolean).join(' ')).slice(0, 12000);
            const extractedHeadingTexts = extractHeadingTexts(page.html);
            const lvlLines = Object.entries(skillLevels).map(([s, l]) => `- ${s}: claimed as ${l}`).join('\n') || skills;
            const certPrompt = `Evaluate this public certificate or badge webpage for authenticity and ownership only.

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
- Max score is ${CERTIFICATE_METHOD_MAX_SCORE} for this method.
- Judge authenticity, issuer credibility, recipient name, certificate subject, credential id, and completion date.
- If the displayed recipient clearly belongs to someone else, set nameMismatch true.
- Do not decide skill support; that is handled separately.

Respond ONLY in valid JSON:
{
  "issuer": "issuer name",
  "issuerCredible": boolean,
  "certSubject": "certificate subject or 'not shown'",
  "recipientName": "recipient name or 'not shown'",
  "nameMismatch": boolean,
  "credentialId": "credential id or 'not shown'",
  "completionDate": "completion/issue date or 'not shown'",
  "pageAuthenticSignals": ["signal 1", "signal 2"],
  "pageSuspiciousSignals": ["warning 1"],
  "limitation": "Short note about this verification method."
}`;

            const certAnalysis = await callGemini(model, certPrompt, null, callerUid);
            const rawRecipientName = normalizeWhitespace(certAnalysis.recipientName || 'not shown');
            const initialNameCheck = evaluateCertificateNameCheck(fullName, rawRecipientName);
            const explicitNameMismatch = !!certAnalysis.nameMismatch;
            const nameCheck = explicitNameMismatch && initialNameCheck.passed
                ? {
                    ...initialNameCheck,
                    passed: false,
                    nameMismatch: true,
                    reason: `The certificate recipient ${initialNameCheck.recipientName} does not match the profile owner.`
                }
                : initialNameCheck;
            const recipientName = nameCheck.recipientName;
            const nameMismatch = nameCheck.nameMismatch;
            const certSubject = normalizeWhitespace(certAnalysis.certSubject || page.title || 'not shown');
            const credentialId = normalizeWhitespace(certAnalysis.credentialId || extractCredentialId(pageSummary));
            const completionDate = normalizeWhitespace(certAnalysis.completionDate || extractCompletionDate(pageSummary));
            const parsedCompletionDate = parseDateValue(completionDate);
            const completionDateFuture = parsedCompletionDate ? isFutureCalendarDate(parsedCompletionDate) : false;
            const levelEvidence = resolveCertificateLevelStrength({
                title: page.title,
                certificateSubject: certSubject,
                headingTexts: extractedHeadingTexts,
                metaDescription: page.metaDescription
            });
            const headingTexts = levelEvidence.headingTexts;
            const certSkillVerdicts = evaluateClaimedCertificateSkills(claimedSkills, {
                primaryTexts: [page.title, certSubject, ...headingTexts],
                secondaryTexts: [page.metaDescription, pageSummary]
            });
            const skillMatch = certSkillVerdicts.skillMatch;

            const inferredSignals = [];
            const suspiciousSignals = [];
            if (platform.platformTrusted) inferredSignals.push(`Trusted platform domain: ${platform.platformName}`);
            if (platform.strongVerifyPath) inferredSignals.push('Verification-style public URL detected.');
            if (credentialId !== 'not shown') inferredSignals.push('Credential identifier pattern detected on the page.');
            if (parsedCompletionDate && !completionDateFuture) inferredSignals.push('Completion date parsed successfully.');
            if (!platform.platformTrusted) suspiciousSignals.push('Domain is not a recognized certificate platform.');
            if (!nameCheck.passed) suspiciousSignals.push(nameCheck.reason);
            if (completionDateFuture) suspiciousSignals.push(`Completion date appears to be in the future (${completionDate}).`);
            if (skillMatch === 'none') suspiciousSignals.push('The certificate title and headings do not directly name the claimed skills.');

            const issuer = normalizeWhitespace(certAnalysis.issuer || platform.issuer);
            const issuerCredible = certAnalysis.issuerCredible !== false && (platform.platformTrusted || KNOWN_ISSUERS.includes(issuer));
            let authenticityScore = 0;
            if (platform.platformTrusted) authenticityScore += 15;
            if (platform.strongVerifyPath) authenticityScore += 8;
            if (page.pageAccessible) authenticityScore += 8;
            if (issuerCredible) authenticityScore += 4;
            if (credentialId !== 'not shown') authenticityScore += 4;
            if (recipientName !== 'not shown' && nameCheck.passed) authenticityScore += 3;
            if (parsedCompletionDate && !completionDateFuture) authenticityScore += 3;
            authenticityScore = Math.min(45, authenticityScore);

            const levelAwareSkillScore = computeCertLinkSkillScore(skillLevels, certSkillVerdicts, {
                title: page.title,
                certificateSubject: certSubject,
                headingTexts,
                metaDescription: page.metaDescription,
                fallbackText: `${page.title || ''} ${certSubject || ''}`
            });
            let confidenceScore = authenticityScore + levelAwareSkillScore;
            confidenceScore = Math.max(0, Math.min(CERTIFICATE_METHOD_MAX_SCORE, Math.round(confidenceScore)));
            if (!nameCheck.passed) confidenceScore = 0;
            if (completionDateFuture) confidenceScore = Math.min(confidenceScore, 35);

            const aiAuthenticSignals = Array.isArray(certAnalysis.pageAuthenticSignals) ? certAnalysis.pageAuthenticSignals : [];
            const aiSuspiciousSignals = filterCertificateAiSuspiciousSignals(
                Array.isArray(certAnalysis.pageSuspiciousSignals) ? certAnalysis.pageSuspiciousSignals : [],
                { completionDateFuture }
            );
            const pageAuthenticSignals = [...new Set([
                ...inferredSignals,
                ...(aiAuthenticSignals.map(s => normalizeWhitespace(s)).filter(Boolean)),
                ...(certSkillVerdicts.matchedSignals || [])
            ])].slice(0, 6);
            const pageSuspiciousSignals = [...new Set([
                ...suspiciousSignals,
                ...(aiSuspiciousSignals.map(s => normalizeWhitespace(s)).filter(Boolean))
            ])].slice(0, 6);

            return res.json({
                isVerified: nameCheck.passed && !completionDateFuture && certSkillVerdicts.verifiedSkills.length > 0 && confidenceScore >= 50,
                confidenceScore,
                platformName: platform.platformName,
                platformTrusted: platform.platformTrusted,
                pageAccessible: true,
                analysisSource: 'gemini',
                issuer,
                issuerCredible,
                certSubject,
                recipientName,
                nameMismatch,
                missingProfileName: nameCheck.missingProfileName,
                missingRecipientName: nameCheck.missingRecipientName,
                nameCheckReason: nameCheck.reason,
                credentialId,
                completionDate,
                completionDateIso: formatDateIso(parsedCompletionDate),
                completionDateFuture,
                skillMatch,
                pageAuthenticSignals,
                pageSuspiciousSignals,
                reasoning: buildCertificateReasoning({
                    platformName: platform.platformName,
                    pageAccessible: true,
                    recipientName,
                    nameMismatch,
                    nameCheckPassed: nameCheck.passed,
                    nameCheckReason: nameCheck.reason,
                    completionDate,
                    completionDateFuture,
                    verifiedSkills: certSkillVerdicts.verifiedSkills,
                    partialSkills: certSkillVerdicts.partialSkills,
                    unverifiedSkills: certSkillVerdicts.unverifiedSkills
                }),
                limitation: sanitizeCertificateLimitationText(
                    certAnalysis.limitation || 'This method verifies only public certificate page details, not the issuer database directly.',
                    { completionDateFuture }
                ),
                verifiedSkills: certSkillVerdicts.verifiedSkills,
                partialSkills: certSkillVerdicts.partialSkills,
                unverifiedSkills: certSkillVerdicts.unverifiedSkills
            });
        }

        else {
            return res.status(400).json({ error: `Unknown type: "${type}"` });
        }

    } catch (err) {
        console.error('[verify]', err.message);
        if (err.isGeminiVerificationRateLimit) {
            const min = err.remainingMinutes || 60;
            return res.status(429).json({
                error: `AI verification limit reached (5 per hour). Please try again in ${min} minute${min === 1 ? '' : 's'}`,
                rateLimited: true,
                remainingMinutes: min
            });
        }
        if (err.message?.includes('SAFETY')) return res.status(400).json({ error: 'Content flagged by safety filters.' });
        if (err instanceof SyntaxError) return res.status(500).json({ error: 'AI returned malformed response. Try again.' });
        if (err.response?.status === 401) return res.status(500).json({ error: 'GitHub token invalid.' });
        if (err.response?.status === 403) return res.status(503).json({ error: 'GitHub API rate limit. Wait ~1 hour.' });
        if (isGeminiQuotaError(err)) return res.status(429).json({ error: buildGeminiQuotaMessage(err) });
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
        await assertUserFeatureAccess(req.user.uid, 'canSchedule');
        const { requestId, connectionId, topic, durationMinutes, startAt, partnerName, appUrl } = req.body || {};
        if (!requestId) return res.status(400).json({ error: 'Missing accepted request id.' });
        if (!topic || typeof topic !== 'string') return res.status(400).json({ error: 'Topic is required.' });
        if (!startAt) return res.status(400).json({ error: 'Start date is required.' });

        const acceptedConnection = await getAcceptedConnectionOrThrow({ requestId, connectionId, callerUid: req.user.uid });
        const partnerUid = acceptedConnection.teacherUid === req.user.uid
            ? acceptedConnection.studentUid
            : acceptedConnection.teacherUid;
        await assertUserFeatureAccess(partnerUid, 'canSchedule', 'The selected partner');
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
        await assertUserFeatureAccess(req.user.uid, 'canSessionAct');
        const result = await cancelSkillSwapSession(req.params.id, req.user.uid);
        res.json(result);
    } catch (err) {
        console.error('[cancel-session]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not cancel this session.' });
    }
});

app.post('/api/sessions/:id/teacher-complete', requireAuth, async (req, res) => {
    try {
        await assertUserFeatureAccess(req.user.uid, 'canSessionAct');
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
        await assertUserFeatureAccess(req.user.uid, 'canSessionAct');
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
        await assertUserFeatureAccess(req.user.uid, 'canSessionAct');
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
        await assertUserFeatureAccess(req.user.uid, 'canSessionAct');
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
        await assertUserFeatureAccess(req.user.uid, 'canRequestVerification');
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

function normalizeAdminSkillList(items) {
    if (!Array.isArray(items)) return [];
    return items
        .map((item) => {
            if (!item) return '';
            if (typeof item === 'string') return item.trim();
            if (typeof item === 'object') {
                return String(item.name || item.skill || item.title || '').trim();
            }
            return String(item).trim();
        })
        .filter(Boolean);
}

function getRelatedUserIds(item) {
    const ids = new Set();
    if (item?.teacherUid) ids.add(item.teacherUid);
    if (item?.studentUid) ids.add(item.studentUid);
    if (Array.isArray(item?.participants)) {
        item.participants.forEach((uid) => {
            if (uid) ids.add(uid);
        });
    }
    return Array.from(ids);
}

function trackRelationshipSummary(summaryMap, firstUid, secondUid) {
    if (!firstUid || !secondUid || firstUid === secondUid) return;
    if (!summaryMap.has(firstUid)) summaryMap.set(firstUid, { sessionCount: 0, partners: new Set() });
    summaryMap.get(firstUid).partners.add(secondUid);
}

function loadAdminUserSummary(docSnap, derivedCounts = {}) {
    const data = docSnap.data() || {};
    const stats = data.stats || {};
    return {
        uid: docSnap.id,
        fullName: data.fullName || [data.firstName, data.lastName].filter(Boolean).join(' ') || '',
        firstName: data.firstName || '',
        email: data.email || '',
        appRole: data.appRole || 'user',
        accountStatus: data.accountStatus || 'active',
        probation: data.probation || null,
        verification: data.verification || {},
        humanVerification: data.humanVerification || {},
        verificationStatus: data.verification?.status || 'unverified',
        humanVerificationStatus: data.humanVerification?.status || 'not-requested',
        authDisabled: !!data.authDisabled,
        teachSkills: normalizeAdminSkillList(data.skills?.toTeach),
        learnSkills: normalizeAdminSkillList(data.skills?.toLearn),
        teacherReputation: data.teacherReputation || {},
        stats,
        creditBalance: Number(data.creditBalance || 0),
        heldCreditBalance: Number(data.heldCreditBalance || 0),
        relationshipCount: Number(derivedCounts.relationshipCount || 0),
        sessionCount: Number(derivedCounts.sessionCount || stats.sessionsCompleted || stats.sessionsTaught || 0),
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
    };
}

async function listAdminUsers() {
    const db = getAdminDb();
    const [usersSnap, sessionsSnap, requestsSnap, connectionsSnap, conversationsSnap] = await Promise.all([
        db.collection('users').get(),
        db.collection('sessions').get(),
        db.collection('lessonRequests').get(),
        db.collection('lessonConnections').get(),
        db.collection('conversations').get()
    ]);
    const summaryMap = new Map();
    const ensureSummary = (uid) => {
        if (!uid) return null;
        if (!summaryMap.has(uid)) summaryMap.set(uid, { sessionCount: 0, partners: new Set() });
        return summaryMap.get(uid);
    };
    sessionsSnap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        [data.teacherUid, data.studentUid].forEach((uid) => {
            const entry = ensureSummary(uid);
            if (entry) entry.sessionCount += 1;
        });
        trackRelationshipSummary(summaryMap, data.teacherUid, data.studentUid);
        trackRelationshipSummary(summaryMap, data.studentUid, data.teacherUid);
    });
    [requestsSnap, connectionsSnap].forEach((snap) => {
        snap.forEach((docSnap) => {
            const data = docSnap.data() || {};
            trackRelationshipSummary(summaryMap, data.teacherUid, data.studentUid);
            trackRelationshipSummary(summaryMap, data.studentUid, data.teacherUid);
        });
    });
    conversationsSnap.forEach((docSnap) => {
        const ids = getRelatedUserIds(docSnap.data() || {});
        ids.forEach((uid) => ensureSummary(uid));
        ids.forEach((uid) => {
            ids.forEach((otherUid) => trackRelationshipSummary(summaryMap, uid, otherUid));
        });
    });
    const users = [];
    usersSnap.forEach((docSnap) => {
        const counts = summaryMap.get(docSnap.id) || { sessionCount: 0, partners: new Set() };
        users.push(loadAdminUserSummary(docSnap, {
            sessionCount: counts.sessionCount,
            relationshipCount: counts.partners.size
        }));
    });
    return users;
}

async function buildAdminOverview() {
    const db = getAdminDb();
    const [usersSnap, sessionsSnap, creditCasesSnap, appealsSnap] = await Promise.all([
        db.collection('users').get(),
        db.collection('sessions').get(),
        db.collection('creditReviewCases').get(),
        db.collection('accountRecoveryAppeals').get()
    ]);
    let totalUsers = 0;
    let activeTeachers = 0;
    let heldCredits = 0;
    usersSnap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        totalUsers += 1;
        heldCredits += Number(data.heldCreditBalance || 0);
        if ((data.accountStatus || 'active') === 'active' && Array.isArray(data.skills?.toTeach) && data.skills.toTeach.length) {
            activeTeachers += 1;
        }
    });
    let pendingReviews = 0;
    creditCasesSnap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        if ((data.status || 'pending') === 'pending') pendingReviews += 1;
    });
    let recoveryAppeals = 0;
    appealsSnap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        if ((data.status || 'pending') === 'pending') recoveryAppeals += 1;
    });
    return {
        totalUsers,
        activeTeachers,
        totalSessions: sessionsSnap.size,
        heldCredits,
        pendingReviews,
        creditCases: creditCasesSnap.size,
        recoveryAppeals
    };
}

async function buildUserRelationshipGroups(uid, detail = {}) {
    const profileCache = new Map();
    const groups = new Map();
    function resolvePartnerUid(item) {
        if (!item) return '';
        if (item.teacherUid === uid && item.studentUid) return item.studentUid;
        if (item.studentUid === uid && item.teacherUid) return item.teacherUid;
        if (Array.isArray(item.participants)) {
            const other = item.participants.find((participantUid) => participantUid && participantUid !== uid);
            if (other) return other;
        }
        if (item.partnerUid && item.partnerUid !== uid) return item.partnerUid;
        if (item.relatedUserId && item.relatedUserId !== uid) return item.relatedUserId;
        return '';
    }
    function resolvePartnerFallback(partnerUid, item) {
        const isTeacher = item && item.teacherUid === partnerUid;
        const isStudent = item && item.studentUid === partnerUid;
        const email = isTeacher ? (item.teacherEmail || '') : (isStudent ? (item.studentEmail || '') : (item.partnerEmail || ''));
        const fullName = (isTeacher ? item.teacherName : (isStudent ? item.studentName : ''))
            || item.partnerName
            || item.displayName
            || email
            || partnerUid;
        return {
            uid: partnerUid,
            fullName: fullName || partnerUid,
            email: email || '',
            accountStatus: item.partnerAccountStatus || 'unknown'
        };
    }
    function resolveActorRole(item) {
        if (!item) return '';
        if (item.teacherUid === uid) return 'teacher';
        if (item.studentUid === uid) return 'learner';
        return item.role || '';
    }
    async function getPartnerProfile(partnerUid) {
        if (!partnerUid) return null;
        if (profileCache.has(partnerUid)) return profileCache.get(partnerUid);
        let partner = null;
        try {
            partner = await getUserProfileOrThrow(partnerUid);
        } catch (_err) {
            partner = null;
        }
        profileCache.set(partnerUid, partner);
        return partner;
    }
    async function ensureGroup(partnerUid, sourceItem = null) {
        if (!partnerUid) return null;
        if (!groups.has(partnerUid)) {
            const partner = await getPartnerProfile(partnerUid);
            groups.set(partnerUid, {
                partnerUid,
                partner: partner ? {
                    uid: partner.uid,
                    fullName: getDisplayName(partner, partner.email || partner.uid),
                    email: partner.email || '',
                    accountStatus: partner.accountStatus || 'active'
                } : resolvePartnerFallback(partnerUid, sourceItem || {}),
                roles: new Set(),
                taughtSessions: 0,
                learnedSessions: 0,
                requestCount: 0,
                connectionCount: 0,
                conversationCount: 0,
                sessions: [],
                requests: [],
                connections: [],
                latestInteractionAt: null
            });
        } else if (sourceItem) {
            const existing = groups.get(partnerUid);
            const fallback = resolvePartnerFallback(partnerUid, sourceItem);
            if (existing && (!existing.partner.fullName || existing.partner.fullName === partnerUid) && fallback.fullName && fallback.fullName !== partnerUid) {
                existing.partner.fullName = fallback.fullName;
            }
            if (existing && !existing.partner.email && fallback.email) {
                existing.partner.email = fallback.email;
            }
        }
        return groups.get(partnerUid);
    }
    function updateLatest(group, value) {
        if (!value) return;
        if (!group.latestInteractionAt || toMillis(value) > toMillis(group.latestInteractionAt)) {
            group.latestInteractionAt = value;
        }
    }
    for (const item of detail.sessions || []) {
        const partnerUid = resolvePartnerUid(item);
        const group = await ensureGroup(partnerUid, item);
        if (!group) continue;
        const role = resolveActorRole(item);
        if (role) group.roles.add(role);
        if (role === 'teacher') group.taughtSessions += 1;
        else if (role === 'learner') group.learnedSessions += 1;
        group.sessions.push({
            id: item.id,
            topic: item.topic || item.skillRequested || '',
            skillRequested: item.skillRequested || '',
            role,
            status: item.status || item.settlementStatus || 'scheduled',
            startAt: item.startAt || null,
            updatedAt: item.updatedAt || null
        });
        updateLatest(group, item.updatedAt || item.startAt);
    }
    for (const item of detail.lessonRequests || []) {
        const partnerUid = resolvePartnerUid(item);
        const group = await ensureGroup(partnerUid, item);
        if (!group) continue;
        group.requestCount += 1;
        group.requests.push({
            id: item.id,
            skillRequested: item.skillRequested || '',
            topic: item.topic || '',
            role: resolveActorRole(item),
            sessionType: item.sessionType || '',
            status: item.status || 'pending',
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null
        });
        updateLatest(group, item.updatedAt || item.createdAt);
    }
    for (const item of detail.lessonConnections || []) {
        const partnerUid = resolvePartnerUid(item);
        const group = await ensureGroup(partnerUid, item);
        if (!group) continue;
        group.connectionCount += 1;
        group.connections.push({
            id: item.id,
            skillRequested: item.skillRequested || '',
            topic: item.topic || '',
            role: resolveActorRole(item),
            sessionType: item.sessionType || '',
            status: item.status || 'accepted',
            createdAt: item.createdAt || null,
            updatedAt: item.updatedAt || null
        });
        updateLatest(group, item.updatedAt || item.createdAt);
    }
    for (const item of detail.conversations || []) {
        const partnerUid = resolvePartnerUid(item);
        const group = await ensureGroup(partnerUid, item);
        if (!group) continue;
        group.conversationCount += 1;
        updateLatest(group, item.lastMessageAt || item.updatedAt || item.createdAt);
    }
    return Array.from(groups.values())
        .map((group) => ({
            ...group,
            roles: Array.from(group.roles),
            sessions: group.sessions.sort((a, b) => toMillis(b.updatedAt || b.startAt) - toMillis(a.updatedAt || a.startAt)),
            requests: group.requests.sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt)),
            connections: group.connections.sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt))
        }))
        .sort((a, b) => toMillis(b.latestInteractionAt) - toMillis(a.latestInteractionAt));
}

async function buildAdminUserDetail(uid) {
    const db = getAdminDb();
    const user = await getUserProfileOrThrow(uid);
    const [
        stats,
        sessionsTeacherSnap,
        sessionsLearnerSnap,
        lessonRequestsTeacherSnap,
        lessonRequestsStudentSnap,
        lessonConnectionsTeacherSnap,
        lessonConnectionsStudentSnap,
        transactionsSnap,
        notificationsSnap,
        conversationsSnap,
        savedMaterialsSnap,
        humanVerificationRequestsSnap,
        googleCalendarSnap,
        creditReviewCasesOpenedSnap,
        creditReviewCasesTeacherSnap,
        creditReviewCasesStudentSnap,
        appealsSnap
    ] = await Promise.all([
        buildUserStatsSnapshot(uid, user),
        db.collection('sessions').where('teacherUid', '==', uid).get(),
        db.collection('sessions').where('studentUid', '==', uid).get(),
        db.collection('lessonRequests').where('teacherUid', '==', uid).get(),
        db.collection('lessonRequests').where('studentUid', '==', uid).get(),
        db.collection('lessonConnections').where('teacherUid', '==', uid).get(),
        db.collection('lessonConnections').where('studentUid', '==', uid).get(),
        db.collection('transactions').where('uid', '==', uid).get(),
        db.collection('notifications').where('uid', '==', uid).get(),
        db.collection('conversations').where('participants', 'array-contains', uid).get(),
        db.collection('savedMaterials').where('uid', '==', uid).get(),
        db.collection('humanVerificationRequests').where('uid', '==', uid).get(),
        db.collection('googleCalendarConnections').doc(uid).get(),
        db.collection('creditReviewCases').where('openedByUid', '==', uid).get(),
        db.collection('creditReviewCases').where('teacherUid', '==', uid).get(),
        db.collection('creditReviewCases').where('studentUid', '==', uid).get(),
        db.collection('accountRecoveryAppeals').where('uid', '==', uid).get()
    ]);
    const sessionsMap = new Map();
    [sessionsTeacherSnap, sessionsLearnerSnap].forEach((snap) => {
        snap.forEach((docSnap) => {
            sessionsMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        });
    });
    const lessonRequestMap = new Map();
    [lessonRequestsTeacherSnap, lessonRequestsStudentSnap].forEach((snap) => {
        snap.forEach((docSnap) => lessonRequestMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
    });
    const lessonConnectionMap = new Map();
    [lessonConnectionsTeacherSnap, lessonConnectionsStudentSnap].forEach((snap) => {
        snap.forEach((docSnap) => lessonConnectionMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
    });
    const creditCaseMap = new Map();
    [creditReviewCasesOpenedSnap, creditReviewCasesTeacherSnap, creditReviewCasesStudentSnap].forEach((snap) => {
        snap.forEach((docSnap) => creditCaseMap.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
    });
    const transactions = [];
    transactionsSnap.forEach((docSnap) => transactions.push({ id: docSnap.id, ...docSnap.data() }));
    const notifications = [];
    notificationsSnap.forEach((docSnap) => notifications.push({ id: docSnap.id, ...docSnap.data() }));
    const conversations = [];
    conversationsSnap.forEach((docSnap) => conversations.push({ id: docSnap.id, ...docSnap.data() }));
    const savedMaterials = [];
    savedMaterialsSnap.forEach((docSnap) => savedMaterials.push({ id: docSnap.id, ...docSnap.data() }));
    const humanVerificationRequests = [];
    humanVerificationRequestsSnap.forEach((docSnap) => humanVerificationRequests.push({ id: docSnap.id, ...docSnap.data() }));
    const accountRecoveryAppeals = [];
    appealsSnap.forEach((docSnap) => accountRecoveryAppeals.push({ id: docSnap.id, ...docSnap.data() }));
    const sessions = Array.from(sessionsMap.values()).sort((a, b) => toMillis(b.updatedAt || b.startAt) - toMillis(a.updatedAt || a.startAt));
    const lessonRequests = Array.from(lessonRequestMap.values()).sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));
    const lessonConnections = Array.from(lessonConnectionMap.values()).sort((a, b) => toMillis(b.updatedAt || b.createdAt) - toMillis(a.updatedAt || a.createdAt));
    const creditReviewCases = Array.from(creditCaseMap.values()).sort((a, b) => toMillis(b.updatedAt || b.openedAt) - toMillis(a.updatedAt || a.openedAt));
    const relationshipGroups = await buildUserRelationshipGroups(uid, {
        sessions,
        lessonRequests,
        lessonConnections,
        conversations
    });
    const latestActivityAt = [
        ...sessions.map((item) => item.updatedAt || item.startAt),
        ...notifications.map((item) => item.createdAt || item.updatedAt),
        ...transactions.map((item) => item.createdAt || item.updatedAt)
    ].sort((a, b) => toMillis(b) - toMillis(a))[0] || null;
    const summary = {
        relationshipCount: relationshipGroups.length,
        sessionCount: sessions.length,
        taughtSessions: Number(stats.sessionsTaught || user.sessionsTaught || 0),
        conversationCount: conversations.length,
        notificationCount: notifications.length,
        latestActivityAt,
        pendingCreditCases: creditReviewCases.filter((item) => (item.status || 'pending') === 'pending').length
    };
    return {
        user: {
            uid,
            ...user,
            accountStatus: user.accountStatus || 'active',
            probation: user.probation || { active: false, restrictions: { ...DEFAULT_PROBATION_RESTRICTIONS } },
            accountWarnings: Array.isArray(user.accountWarnings) ? user.accountWarnings : [],
            adminAuditLogs: Array.isArray(user.adminAuditLogs) ? user.adminAuditLogs : [],
            authDisabled: !!user.authDisabled,
            teachSkills: normalizeAdminSkillList(user.skills?.toTeach),
            learnSkills: normalizeAdminSkillList(user.skills?.toLearn),
            stats: { ...stats, ...(user.stats || {}) },
            sessionsCompleted: Number(stats.sessionsCompleted || user.sessionsCompleted || 0),
            sessionsTaught: Number(stats.sessionsTaught || user.sessionsTaught || 0)
        },
        summary,
        sessions,
        lessonRequests,
        lessonConnections,
        relationshipGroups,
        transactions: transactions.sort((a, b) => toMillis(b.createdAt || b.updatedAt) - toMillis(a.createdAt || a.updatedAt)),
        notifications: notifications.sort((a, b) => toMillis(b.createdAt || b.updatedAt) - toMillis(a.createdAt || a.updatedAt)),
        conversations: conversations.sort((a, b) => toMillis(b.lastMessageAt || b.updatedAt) - toMillis(a.lastMessageAt || a.updatedAt)),
        savedMaterials: savedMaterials.sort((a, b) => toMillis(b.createdAt || b.updatedAt) - toMillis(a.createdAt || a.updatedAt)),
        creditReviewCases,
        humanVerificationRequests: humanVerificationRequests.sort((a, b) => toMillis(b.requestedAt || b.updatedAt) - toMillis(a.requestedAt || a.updatedAt)),
        accountRecoveryAppeals: accountRecoveryAppeals.sort((a, b) => toMillis(b.updatedAt || b.submittedAt) - toMillis(a.updatedAt || a.submittedAt)),
        adminAuditLogs: Array.isArray(user.adminAuditLogs) ? user.adminAuditLogs.slice().sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)) : [],
        googleCalendarConnection: googleCalendarSnap.exists ? { id: googleCalendarSnap.id, ...googleCalendarSnap.data() } : null
    };
}

async function performAdminUserAction(targetUid, adminProfile, action, options = {}) {
    const db = getAdminDb();
    const user = await getUserProfileOrThrow(targetUid);
    const reason = sanitizePlainText(options.reason, 240);
    const notes = sanitizePlainText(options.notes, 500);
    const category = sanitizeModerationCategory(options.category);
    const actorName = getDisplayName(adminProfile, 'Admin');
    const targetName = getDisplayName(user, user.email || targetUid);
    if (action === 'warn') {
        const warning = await appendAccountWarning(targetUid, {
            category,
            reason,
            notes,
            actorUid: adminProfile.uid,
            actorName
        });
        await appendAdminAuditLog(targetUid, {
            action: 'warning_issued',
            category,
            reason,
            notes,
            previousStatus: user.accountStatus || 'active',
            nextStatus: user.accountStatus || 'active',
            actorUid: adminProfile.uid,
            actorName,
            targetName
        });
        await createNotificationDirect({
            uid: targetUid,
            type: 'account-warning',
            title: 'Account Warning',
            message: `Admin warning: ${buildModerationReasonText(category, reason)}.${notes ? ` ${notes}` : ''}`
        });
        return { ok: true, warning };
    }

    const currentStatus = user.accountStatus || 'active';
    if (action === 'suspend') {
        if (!reason) {
            const err = new Error('Reason is required when suspending a user.');
            err.statusCode = 400;
            throw err;
        }
        const suspension = {
            category,
            categoryLabel: getModerationCategoryLabel(category),
            reason,
            notes,
            actorUid: adminProfile.uid,
            actorName,
            createdAt: new Date().toISOString(),
            appealable: true
        };
        await setUserModerationState(targetUid, {
            accountStatus: 'suspended',
            suspension,
            probation: user.probation?.active ? user.probation : {
                active: false,
                reason: '',
                restrictions: { ...DEFAULT_PROBATION_RESTRICTIONS },
                startedAt: null,
                clearedAt: null,
                actorUid: '',
                actorName: ''
            },
            authDisabled: false
        });
        await admin.auth().updateUser(targetUid, { disabled: false }).catch(() => { });
        await appendAdminAuditLog(targetUid, {
            action: 'user_suspended',
            category,
            reason,
            notes,
            previousStatus: currentStatus,
            nextStatus: 'suspended',
            actorUid: adminProfile.uid,
            actorName,
            targetName
        });
        await createNotificationDirect({
            uid: targetUid,
            type: 'account-suspension',
            title: 'Account Suspended',
            message: `Your account has been suspended. Reason: ${buildModerationReasonText(category, reason)}.${notes ? ` ${notes}` : ''}`
        });
        return { ok: true, accountStatus: 'suspended', suspension };
    }

    if (action === 'reactivate') {
        await setUserModerationState(targetUid, {
            accountStatus: 'active',
            authDisabled: false
        });
        await admin.auth().updateUser(targetUid, { disabled: false }).catch(() => { });
        await appendAdminAuditLog(targetUid, {
            action: 'user_reactivated',
            category,
            reason,
            notes,
            previousStatus: currentStatus,
            nextStatus: 'active',
            actorUid: adminProfile.uid,
            actorName,
            targetName
        });
        await createNotificationDirect({
            uid: targetUid,
            type: 'account-reactivated',
            title: 'Account Reactivated',
            message: notes || 'Your SkillSwap account is active again.'
        });
        return { ok: true, accountStatus: 'active' };
    }

    if (action === 'terminate') {
        if (!reason) {
            const err = new Error('Reason is required when terminating a user.');
            err.statusCode = 400;
            throw err;
        }
        await setUserModerationState(targetUid, {
            accountStatus: 'terminated',
            authDisabled: true,
            termination: {
                category,
                categoryLabel: getModerationCategoryLabel(category),
                reason,
                notes,
                actorUid: adminProfile.uid,
                actorName,
                createdAt: new Date().toISOString()
            }
        });
        await admin.auth().updateUser(targetUid, { disabled: true }).catch(() => { });
        await appendAdminAuditLog(targetUid, {
            action: 'user_terminated',
            category,
            reason,
            notes,
            previousStatus: currentStatus,
            nextStatus: 'terminated',
            actorUid: adminProfile.uid,
            actorName,
            targetName
        });
        return { ok: true, accountStatus: 'terminated' };
    }

    const err = new Error('Unsupported admin action.');
    err.statusCode = 400;
    throw err;
}

app.get('/api/admin/overview', requireAuth, requireAdmin, async (_req, res) => {
    try {
        const overview = await buildAdminOverview();
        res.json({ ok: true, overview });
    } catch (err) {
        console.error('[admin-overview]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load the admin overview.' });
    }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
    try {
        const users = await listAdminUsers();
        res.json({ ok: true, users });
    } catch (err) {
        console.error('[admin-users]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load users.' });
    }
});

app.get('/api/admin/users/:uid', requireAuth, requireAdmin, async (req, res) => {
    try {
        const detail = await buildAdminUserDetail(req.params.uid);
        res.json({ ok: true, detail });
    } catch (err) {
        console.error('[admin-user-detail]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load that user.' });
    }
});

app.post('/api/admin/users/:uid/warn', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await performAdminUserAction(req.params.uid, req.adminProfile, 'warn', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-warn]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not warn that user.' });
    }
});

app.post('/api/admin/users/:uid/suspend', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await performAdminUserAction(req.params.uid, req.adminProfile, 'suspend', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-suspend]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not suspend that user.' });
    }
});

app.post('/api/admin/users/:uid/reactivate', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await performAdminUserAction(req.params.uid, req.adminProfile, 'reactivate', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-reactivate]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not reactivate that user.' });
    }
});

app.post('/api/admin/users/:uid/terminate', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await performAdminUserAction(req.params.uid, req.adminProfile, 'terminate', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-terminate]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not terminate that user.' });
    }
});

app.post('/api/account-recovery-appeals', requireAuth, async (req, res) => {
    try {
        const profile = await getUserProfileOrThrow(req.user.uid);
        if ((profile.accountStatus || 'active') !== 'suspended') {
            return res.status(400).json({ error: 'Only suspended accounts can submit a recovery appeal.' });
        }
        const incidentExplanation = sanitizePlainText(req.body?.incidentExplanation, 1200);
        const apologyText = sanitizePlainText(req.body?.apologyText, 1200);
        const correctiveActions = sanitizePlainText(req.body?.correctiveActions, 1200);
        const supportingNote = sanitizePlainText(req.body?.supportingNote, 1200);
        const evidenceUrl = sanitizePlainText(req.body?.evidenceUrl, 500);
        if (!incidentExplanation || !apologyText || !correctiveActions) {
            return res.status(400).json({ error: 'Explain what happened, acknowledge it, and describe what you will improve.' });
        }
        const db = getAdminDb();
        const existing = await db.collection('accountRecoveryAppeals')
            .where('uid', '==', req.user.uid)
            .where('status', '==', 'pending')
            .get();
        if (!existing.empty) {
            return res.status(409).json({ error: 'You already have a recovery appeal pending review.' });
        }
        const ref = db.collection('accountRecoveryAppeals').doc();
        const now = admin.firestore.FieldValue.serverTimestamp();
        await ref.set({
            uid: req.user.uid,
            status: 'pending',
            submittedAt: now,
            updatedAt: now,
            suspensionReasonSnapshot: buildModerationReasonText(profile.suspension?.category, profile.suspension?.reason || ''),
            incidentExplanation,
            apologyText,
            correctiveActions,
            supportingNote,
            evidenceUrl,
            messageSummary: [incidentExplanation, apologyText, correctiveActions].filter(Boolean).join(' | ')
        });
        await appendAdminAuditLog(req.user.uid, {
            action: 'recovery_appeal_submitted',
            category: sanitizeModerationCategory(profile.suspension?.category),
            reason: profile.suspension?.reason || '',
            notes: 'User submitted a recovery appeal.',
            previousStatus: profile.accountStatus || 'suspended',
            nextStatus: profile.accountStatus || 'suspended',
            actorUid: req.user.uid,
            actorName: getDisplayName(profile, profile.email || req.user.uid),
            targetName: getDisplayName(profile, profile.email || req.user.uid)
        });
        res.json({ ok: true, appealId: ref.id });
    } catch (err) {
        console.error('[account-recovery-appeal-submit]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not submit that recovery appeal.' });
    }
});

app.get('/api/admin/account-recovery-appeals', requireAuth, requireAdmin, async (req, res) => {
    try {
        const statusFilter = sanitizePlainText(req.query?.status, 40).toLowerCase() || 'pending';
        const snap = await getAdminDb().collection('accountRecoveryAppeals').get();
        const appeals = [];
        snap.forEach((docSnap) => {
            const data = { id: docSnap.id, ...docSnap.data() };
            if (statusFilter !== 'all' && (data.status || 'pending') !== statusFilter) return;
            appeals.push(data);
        });
        appeals.sort((a, b) => toMillis(b.updatedAt || b.submittedAt) - toMillis(a.updatedAt || a.submittedAt));
        res.json({ ok: true, appeals });
    } catch (err) {
        console.error('[admin-appeals]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not load recovery appeals.' });
    }
});

async function resolveRecoveryAppeal(appealId, adminProfile, action, body = {}) {
    const db = getAdminDb();
    const appealRef = db.collection('accountRecoveryAppeals').doc(appealId);
    const appealSnap = await appealRef.get();
    if (!appealSnap.exists) {
        const err = new Error('Recovery appeal not found.');
        err.statusCode = 404;
        throw err;
    }
    const appeal = appealSnap.data() || {};
    if ((appeal.status || 'pending') !== 'pending') {
        const err = new Error('This recovery appeal has already been reviewed.');
        err.statusCode = 409;
        throw err;
    }
    const user = await getUserProfileOrThrow(appeal.uid);
    const actorName = getDisplayName(adminProfile, 'Admin');
    const decisionReason = sanitizePlainText(body.decisionReason, 240);
    const reviewNotes = sanitizePlainText(body.reviewNotes, 500);
    if (action === 'approve') {
        const restrictions = sanitizeProbationRestrictions(body.restrictions);
        const durationDays = Number(body.durationDays || DEFAULT_PROBATION_DURATION_DAYS) > 0
            ? Number(body.durationDays || DEFAULT_PROBATION_DURATION_DAYS)
            : DEFAULT_PROBATION_DURATION_DAYS;
        const probationEndsAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
        const probation = {
            active: true,
            reason: decisionReason || 'Account restored under probation after suspension appeal approval.',
            restrictions,
            startedAt: new Date().toISOString(),
            endsAt: probationEndsAt,
            clearedAt: null,
            actorUid: adminProfile.uid,
            actorName
        };
        await setUserModerationState(appeal.uid, {
            accountStatus: 'active',
            probation,
            authDisabled: false
        });
        await admin.auth().updateUser(appeal.uid, { disabled: false }).catch(() => { });
        await appealRef.set({
            status: 'approved',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedBy: adminProfile.uid,
            reviewedByName: actorName,
            reviewNotes,
            decisionReason
        }, { merge: true });
        await appendAdminAuditLog(appeal.uid, {
            action: 'recovery_appeal_approved',
            category: sanitizeModerationCategory(user.suspension?.category),
            reason: decisionReason || user.suspension?.reason || '',
            notes: reviewNotes,
            previousStatus: user.accountStatus || 'suspended',
            nextStatus: 'active',
            actorUid: adminProfile.uid,
            actorName,
            targetName: getDisplayName(user, user.email || appeal.uid),
            metadata: { probation }
        });
        await createNotificationDirect({
            uid: appeal.uid,
            type: 'account-reactivated',
            title: 'Appeal Approved',
            message: `Your account is active again under probation until ${new Date(probationEndsAt).toLocaleString()}.${decisionReason ? ` ${decisionReason}` : ''}`
        });
        return { ok: true, status: 'approved', probation };
    }

    if (action === 'reject') {
        await appealRef.set({
            status: 'rejected',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
            reviewedBy: adminProfile.uid,
            reviewedByName: actorName,
            reviewNotes,
            decisionReason
        }, { merge: true });
        await appendAdminAuditLog(appeal.uid, {
            action: 'recovery_appeal_rejected',
            category: sanitizeModerationCategory(user.suspension?.category),
            reason: decisionReason || user.suspension?.reason || '',
            notes: reviewNotes,
            previousStatus: user.accountStatus || 'suspended',
            nextStatus: user.accountStatus || 'suspended',
            actorUid: adminProfile.uid,
            actorName,
            targetName: getDisplayName(user, user.email || appeal.uid)
        });
        await createNotificationDirect({
            uid: appeal.uid,
            type: 'appeal-rejected',
            title: 'Appeal Rejected',
            message: decisionReason || 'Your recovery appeal was reviewed and rejected. The suspension remains in place.'
        });
        return { ok: true, status: 'rejected' };
    }

    const err = new Error('Unsupported recovery appeal action.');
    err.statusCode = 400;
    throw err;
}

app.post('/api/admin/account-recovery-appeals/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await resolveRecoveryAppeal(req.params.id, req.adminProfile, 'approve', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-appeal-approve]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not approve that recovery appeal.' });
    }
});

app.post('/api/admin/account-recovery-appeals/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await resolveRecoveryAppeal(req.params.id, req.adminProfile, 'reject', req.body || {});
        res.json(result);
    } catch (err) {
        console.error('[admin-appeal-reject]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not reject that recovery appeal.' });
    }
});

app.post('/api/admin/users/:uid/clear-probation', requireAuth, requireAdmin, async (req, res) => {
    try {
        const user = await getUserProfileOrThrow(req.params.uid);
        const decisionReason = sanitizePlainText(req.body?.decisionReason, 240);
        const reviewNotes = sanitizePlainText(req.body?.reviewNotes, 500);
        await setUserModerationState(req.params.uid, {
            probation: buildClearedProbation(
                user.probation || null,
                req.adminProfile.uid,
                getDisplayName(req.adminProfile, 'Admin')
            )
        });
        await appendAdminAuditLog(req.params.uid, {
            action: 'probation_cleared',
            category: sanitizeModerationCategory(user.suspension?.category),
            reason: decisionReason,
            notes: reviewNotes,
            previousStatus: user.accountStatus || 'active',
            nextStatus: user.accountStatus || 'active',
            actorUid: req.adminProfile.uid,
            actorName: getDisplayName(req.adminProfile, 'Admin'),
            targetName: getDisplayName(user, user.email || req.params.uid)
        });
        await createNotificationDirect({
            uid: req.params.uid,
            type: 'probation-cleared',
            title: 'Probation Cleared',
            message: decisionReason || 'Your probation period has ended and full SkillSwap access is restored.'
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('[admin-clear-probation]', err.message);
        res.status(err.statusCode || 500).json({ error: err.message || 'Could not clear probation.' });
    }
});

app.get('/api/health', (_req, res) => res.json({
    status: 'ok',
    ownershipCode: OWNERSHIP_CODE,
    calendarConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REDIRECT_URI),
    firebaseAdminConfigured: !!getFirebaseServiceAccount(),
    ai: {
        verification: 'tavily',
        verificationPrimaryModel: 'tavily-evidence-only',
        verificationFallbackModels: [],
        studyMaterials: 'tavily-evidence-only',
        notesImprover: 'groq'
    }
}));

// NOTE: Server starts at the bottom of this file after all routes are registered.


// --- AI NOTES ROUTES (GROQ + TAVILY) ---
const STUDY_NOTES_GROQ_MODEL = 'llama-3.1-8b-instant';
const STUDY_NOTES_GROQ_FALLBACK_MODEL = 'gemma2-9b-it';

function stripModelCodeFences(value) {
    return String(value || '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
}

function parseJsonObjectFromModelResponse(value, label) {
    const cleaned = stripModelCodeFences(value);
    try {
        return JSON.parse(cleaned);
    } catch (_err) {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw new Error(`Could not parse ${label} JSON response.`);
    }
}

// Strip common UTF-8 artifact characters that appear when AI output is mis-encoded
function sanitizeAiText(str) {
    if (typeof str !== 'string') return str;
    return str
        .replace(/â€™/g, "'").replace(/â€˜/g, "'")
        .replace(/â€œ/g, '"').replace(/â€/g, '"')
        .replace(/â€"/g, '–').replace(/â€"/g, '—')
        .replace(/â€¦/g, '...').replace(/â€¢/g, '•')
        .replace(/Â·/g, '·').replace(/Â /g, ' ').replace(/Â/g, '')
        .replace(/\u00e2\u0080\u0099/g, "'").replace(/\u00e2\u0080\u009c/g, '"').replace(/\u00e2\u0080\u009d/g, '"')
        .replace(/\u00c2/g, '').replace(/\u00a0/g, ' ')
        .trim();
}

function toCleanText(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') return sanitizeAiText(value.trim()) || fallback;
    return sanitizeAiText(String(value).trim()) || fallback;
}

function toStringArray(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value
        .map(item => toCleanText(item))
        .filter(Boolean)
        .filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function clampScore(value, fallback = 0) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeNotesPayload(rawNotes, topic) {
    const notes = rawNotes && typeof rawNotes === 'object' && rawNotes.notes && typeof rawNotes.notes === 'object'
        ? rawNotes.notes
        : rawNotes;
    const summary = toCleanText(notes && notes.summary, `Study notes for ${topic}.`);
    const keyPoints = toStringArray(notes && notes.keyPoints).slice(0, 8);
    const sections = Array.isArray(notes && notes.sections)
        ? notes.sections
            .map(section => ({
                heading: toCleanText(section && section.heading),
                content: toCleanText(section && section.content)
            }))
            .filter(section => section.heading || section.content)
            .slice(0, 8)
        : [];

    return {
        summary,
        keyPoints,
        sections
    };
}

function normalizeVerificationReport(rawReport, options = {}) {
    const report = rawReport && typeof rawReport === 'object' ? rawReport : {};
    const accuracy = report.accuracy && typeof report.accuracy === 'object' ? report.accuracy : {};
    const completeness = report.completeness && typeof report.completeness === 'object' ? report.completeness : {};
    const clarity = report.clarity && typeof report.clarity === 'object' ? report.clarity : {};
    const depth = report.depth && typeof report.depth === 'object' ? report.depth : {};
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const hasEvidence = sources.length > 0;
    const requestedScoreMode = toCleanText(
        report.scoreMode || report.score_mode || options.scoreMode,
        hasEvidence ? 'full' : 'fallback'
    ).toLowerCase();
    const scoreMode = requestedScoreMode === 'fallback' ? 'fallback' : 'full';

    const accuracyIssues = toStringArray(accuracy.issues);
    const accuracyStrengths = toStringArray(accuracy.strengths);
    const completenessMissing = toStringArray(completeness.missing);
    const completenessCovered = toStringArray(completeness.covered);
    const corrections = toStringArray([]
        .concat(report.corrections || [])
        .concat(report.needs_correction || [])
        .concat(accuracyIssues));
    const missingConcepts = toStringArray([]
        .concat(report.missingConcepts || [])
        .concat(report.missing_concepts || [])
        .concat(completenessMissing));
    const verifiedFacts = toStringArray([]
        .concat(report.verifiedFacts || [])
        .concat(report.verified_facts || [])
        .concat(accuracyStrengths));
    const suggestions = toStringArray(report.suggestions);
    const scoreFallback = Math.round((
        clampScore(accuracy.score, 0)
        + clampScore(completeness.score, 0)
        + clampScore(clarity.score, 0)
        + clampScore(depth.score, 0)
    ) / 4);

    let status = toCleanText(report.status, '').toLowerCase();
    if (!['verified', 'partial', 'unavailable'].includes(status)) {
        status = scoreMode === 'fallback'
            ? (hasEvidence ? 'partial' : 'unavailable')
            : (hasEvidence ? 'verified' : 'partial');
    }
    if (scoreMode === 'fallback' && status === 'verified') {
        status = hasEvidence ? 'partial' : 'unavailable';
    }
    // Only force partial when there's no evidence AND we're in fallback mode.
    // In full (Groq) mode, a score-based 'verified' from the AI is kept as-is.
    if (!hasEvidence && status === 'verified' && scoreMode !== 'full') {
        status = 'partial';
    }

    let overview = toCleanText(report.overview || report.summary);
    if (!overview) {
        overview = hasEvidence
            ? 'Verification completed against external Tavily evidence and Groq synthesis.'
            : 'Verification completed with limited external evidence; treat the results as partial.';
    }

    let improvementPrompt = toCleanText(report.improvementPrompt || report.improvement_prompt);
    if (!improvementPrompt) {
        improvementPrompt = [
            corrections.length ? `Correct these issues: ${corrections.join('; ')}.` : '',
            missingConcepts.length ? `Add these missing concepts: ${missingConcepts.join('; ')}.` : '',
            suggestions.length ? `Improve clarity and structure with these suggestions: ${suggestions.join('; ')}.` : '',
            'Do not repeat previously flagged mistakes.'
        ].filter(Boolean).join(' ');
    }

    const allowHighScores = scoreMode === 'full' && status === 'verified';
    const overallScoreCap = allowHighScores ? 100 : status === 'unavailable' ? 69 : 89;
    const metricScoreCap = allowHighScores ? 100 : status === 'unavailable' ? 74 : 89;

    return {
        status,
        scoreMode,
        score: Math.min(overallScoreCap, clampScore(report.score, scoreFallback)),
        overview,
        accuracy: {
            score: Math.min(metricScoreCap, clampScore(accuracy.score, scoreFallback)),
            issues: accuracyIssues,
            strengths: accuracyStrengths
        },
        completeness: {
            score: Math.min(metricScoreCap, clampScore(completeness.score, scoreFallback)),
            missing: completenessMissing,
            covered: completenessCovered
        },
        clarity: {
            score: Math.min(metricScoreCap, clampScore(clarity.score, scoreFallback)),
            feedback: toCleanText(clarity.feedback, hasEvidence
                ? 'Clear structure overall, with room for tighter explanations where noted.'
                : 'Clarity was judged with limited external evidence.')
        },
        depth: {
            score: Math.min(metricScoreCap, clampScore(depth.score, scoreFallback)),
            assessment: toCleanText(depth.assessment, hasEvidence
                ? 'Depth was assessed against the available external evidence.'
                : 'Depth was assessed cautiously because external evidence was limited.')
        },
        corrections,
        missingConcepts,
        verifiedFacts,
        suggestions,
        improvementPrompt,
        sources,
        checkedAt: new Date().toISOString(),
        evidenceStatus: scoreMode === 'fallback' ? 'fallback' : (hasEvidence ? 'tavily-backed' : 'limited'),
        evidenceNote: toCleanText(options.evidenceNote)
    };
}

function isGroqRateLimitError(error) {
    const message = String(error && error.message ? error.message : '').toLowerCase();
    return error?.response?.status === 429
        || error?.status === 429
        || message.includes('429')
        || message.includes('rate limit')
        || message.includes('too many requests');
}

function collectNoteKeywords(topic, sources) {
    const text = [topic]
        .concat((sources || []).map(source => `${source.title || ''} ${source.snippet || ''}`))
        .join(' ')
        .toLowerCase();
    const tokens = text.match(/[a-z][a-z0-9+\-]{3,}/g) || [];
    const stop = new Set(['about', 'above', 'after', 'again', 'against', 'along', 'also', 'because', 'before', 'being', 'between', 'build', 'clear', 'concept', 'concepts', 'detail', 'details', 'during', 'evidence', 'explain', 'explains', 'their', 'there', 'these', 'those', 'through', 'topic', 'using', 'which', 'while', 'would', 'your', 'study', 'notes']);
    const counts = {};
    tokens.forEach(token => {
        if (stop.has(token)) return;
        counts[token] = (counts[token] || 0) + 1;
    });
    return Object.keys(counts)
        .sort((left, right) => counts[right] - counts[left] || left.localeCompare(right))
        .slice(0, 8);
}

function buildVerificationFallback(topic, notesContent, tavilyResult) {
    const sources = Array.isArray(tavilyResult && tavilyResult.sources) ? tavilyResult.sources : [];
    const evidenceNote = toCleanText(tavilyResult && tavilyResult.evidenceNote, 'This verification used Tavily evidence only.');
    const noteText = toCleanText(notesContent).toLowerCase();
    const keywords = collectNoteKeywords(topic, sources);
    const matchedKeywords = keywords.filter(keyword => noteText.includes(keyword));
    const coverageRatio = keywords.length ? matchedKeywords.length / keywords.length : 0.45;
    const averageSourceScore = sources.length
        ? sources.reduce((sum, source) => sum + (Number(source && source.score) || 0), 0) / sources.length
        : 0;
    const evidenceStrength = Math.max(0, Math.min(1, averageSourceScore || coverageRatio));
    const structureBonus = Math.max(0, Math.min(1, (notesContent.length || 0) / 1400));
    const evidenceQuality = Math.max(0, Math.min(1, (averageSourceScore || 0.4) * 1.2));
    const allowHighScores = sources.length >= 2 && coverageRatio >= 0.75 && evidenceQuality >= 0.6 && (notesContent.length || 0) >= 700;
    const accuracyScore = clampScore(70 + Math.round(coverageRatio * 16) + Math.round(evidenceStrength * 5), allowHighScores ? 100 : 86);
    const completenessScore = clampScore(66 + Math.round(coverageRatio * 18) + Math.round(structureBonus * 5), allowHighScores ? 100 : 84);
    const clarityScore = clampScore(72 + Math.min(18, Math.round((notesContent.length || 0) / 150)), allowHighScores ? 100 : 85);
    const depthScore = clampScore(64 + Math.round(coverageRatio * 18) + Math.round(structureBonus * 6), allowHighScores ? 100 : 83);
    const missingConcepts = uniqueListFromArray(keywords.filter(keyword => !matchedKeywords.includes(keyword)).map(keyword => `Explain ${keyword} more clearly.`)).slice(0, 4);
    const verifiedFacts = uniqueListFromArray(matchedKeywords.map(keyword => `The notes mention ${keyword}, which appears in the external evidence.`)).slice(0, 4);
    const corrections = sources.length
        ? ['Review the notes against the linked sources and tighten any claims that are not directly supported.']
        : ['External evidence was limited, so confirm factual claims before relying on them.'];
    const fallbackAverage = Math.round((accuracyScore + completenessScore + clarityScore + depthScore) / 4);
    const overallScore = sources.length
        ? (allowHighScores ? clampScore(fallbackAverage, 96) : Math.min(89, clampScore(fallbackAverage, 76)))
        : Math.min(69, clampScore(fallbackAverage, 58));

    return normalizeVerificationReport({
        status: allowHighScores ? 'verified' : (sources.length ? 'partial' : 'unavailable'),
        scoreMode: 'full',
        score: overallScore,
        overview: sources.length
            ? (allowHighScores
                ? 'Verification completed using Tavily evidence, and the notes appear well-supported by multiple sources.'
                : 'Verification completed using Tavily evidence only. This score reflects coverage against the available sources but is not a full model critique.')
            : 'Tavily evidence was too limited for a high-confidence review, so this result is low-confidence and unavailable for 90-plus scoring.',
        accuracy: {
            score: accuracyScore,
            issues: corrections,
            strengths: verifiedFacts
        },
        completeness: {
            score: completenessScore,
            missing: missingConcepts,
            covered: verifiedFacts
        },
        clarity: {
            score: clarityScore,
            feedback: allowHighScores
                ? 'The structure appears clear based on the available evidence.'
                : 'The structure appears readable, but expand with more evidence-backed detail for higher confidence.'
        },
        depth: {
            score: depthScore,
            assessment: allowHighScores
                ? 'Depth appears adequate for the covered sources.'
                : 'Depth was estimated from topic coverage rather than a full model critique.'
        },
        corrections,
        missingConcepts,
        verifiedFacts,
        suggestions: [
            'Add concrete explanations for the missing concepts listed below.'
        ],
        improvementPrompt: 'Improve the notes by adding the missing concepts, tightening unsupported claims, avoiding the previously flagged issues, and aligning strictly with Tavily evidence.'
    }, {
        sources,
        scoreMode: 'full',
        evidenceNote: evidenceNote || 'This verification used Tavily evidence only.'
    });
}

function buildNotesFromEvidence(topic, tavilyResult) {
    // Fallback when Groq is unavailable — never dump raw web scrapes into notes
    const sources = Array.isArray(tavilyResult && tavilyResult.sources) ? tavilyResult.sources : [];
    return {
        topic,
        notes: {
            summary: `${topic} is an important subject with a well-defined set of concepts, patterns, and practical applications. AI-powered notes are temporarily unavailable — the content below is a generic overview. Try again in a few minutes for fully AI-generated, source-grounded notes.`,
            keyPoints: [
                `Understanding the fundamentals of ${topic} is the essential first step.`,
                `${topic} is built on a clear set of core principles that everything else builds on.`,
                `Practical application through real projects is the fastest way to master ${topic}.`,
                `The ${topic} ecosystem includes tools, libraries, and strong community support.`,
                `Breaking ${topic} into focused sub-topics makes progressive learning far easier.`,
                `Consistent daily practice significantly accelerates skill development in ${topic}.`
            ],
            sections: [
                {
                    heading: `What ${topic} Is`,
                    content: `${topic} is a well-established concept in its field. It provides a structured approach to solving specific kinds of problems and building reliable solutions. Grasping its purpose and scope is the essential first step toward mastery.`
                },
                {
                    heading: 'Core Concepts',
                    content: `The core concepts of ${topic} form the foundation that all advanced knowledge builds upon. Focus on understanding the key principles, terminology, and underlying mental models before moving to more complex material.`
                },
                {
                    heading: 'How It Works',
                    content: `${topic} follows defined patterns and processes. Understanding how it works internally — its architecture, data flow, and key mechanisms — gives you the insight needed to apply it correctly and debug problems efficiently.`
                },
                {
                    heading: 'Practical Applications',
                    content: `${topic} is applied across many real-world contexts. Working through projects and exercises is the most reliable way to move from theoretical understanding to genuine, transferable proficiency.`
                },
                {
                    heading: 'Getting Started',
                    content: `Begin with the documented fundamentals of ${topic}, set up the recommended tooling, and follow a structured learning path. Build small projects early to apply what you learn, then expand progressively toward more complex scenarios.`
                }
            ]
        },
        mindmap: null,
        flashcards: [],
        quiz: [],
        sources,
        evidenceNote: 'AI generation was temporarily unavailable (rate limit). Showing generic notes — try again shortly.',
        providerLimited: true
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function trimEvidenceSnippet(value, maxLen = 280) {
    const text = toCleanText(value);
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function cleanTavilySnippet(rawSnippet) {
    if (!rawSnippet || typeof rawSnippet !== 'string') return '';
    return rawSnippet
        .split('\n')
        .filter(line => {
            const t = line.trim();
            if (!t || t.length < 15) return false;
            if (/\.(png|jpg|gif|svg|webp)/i.test(t)) return false; // image filenames
            if (/^(geeksforgeeks|skip to|re-watch|follow us|sign in|log in|subscribe|read more|click here|developer notes|android|ios|web)$/i.test(t)) return false;
            if (/^[\s*\-#|]+$/.test(t)) return false; // lines that are pure punctuation/decorators
            if (/^(Interview Prep|React Course|React Tutorial|React Exercise|React Basic|React Components|React Props|React Hooks|React Router|React Advanced|React Examples|React Interview|React Projects)/i.test(t)) return false;
            if (t.split(' ').length < 3) return false; // ultra-short nav items
            return true;
        })
        .join(' ')
        .replace(/\[\.\.\.]|\[([^\]]+)\]\([^)]+\)|```[^```]*```/g, ' ')
        .replace(/#{1,6}\s+/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 420);
}

function buildVerificationEvidenceSummary(tavilyResult) {
    const sources = Array.isArray(tavilyResult && tavilyResult.sources) ? tavilyResult.sources : [];
    if (!sources.length) {
        return 'No Tavily sources available. Score conservatively and set status=partial.';
    }
    return sources.slice(0, 3).map((source, index) => {
        const cleaned = cleanTavilySnippet(source.snippet);
        return `[Source ${index + 1}]\nTitle: ${trimEvidenceSnippet(source.title, 100)}\nEvidence: ${cleaned.slice(0, 350)}`;
    }).join('\n\n');
}

async function callGroqChatWithRetry(messages, options = {}, retryOptions = {}) {
    const retries = Math.max(0, Number(retryOptions.retries) || 0);
    const baseDelayMs = Math.max(0, Number(retryOptions.backoffMs) || 0);
    let lastError = null;

    // Try primary model first
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await callGroqChat(messages, options);
        } catch (err) {
            lastError = err;
            if (attempt >= retries || !isGroqRateLimitError(err)) {
                if (!isGroqRateLimitError(err)) throw err;
                break; // rate limited — try fallback model

            }
            await delay(baseDelayMs * (attempt + 1 || 1));
        }
    }

    // Primary model was rate-limited — try fallback model (separate quota)
    console.warn('[groq] Primary model rate-limited. Trying fallback model:', STUDY_NOTES_GROQ_FALLBACK_MODEL);
    try {
        return await callGroqChat(messages, { ...options, model: STUDY_NOTES_GROQ_FALLBACK_MODEL });
    } catch (fallbackErr) {
        console.warn('[groq] Fallback model also failed:', fallbackErr.message);
        throw lastError || fallbackErr;
    }
}

function uniqueListFromArray(values) {
    const seen = new Set();
    return (values || [])
        .map(item => toCleanText(item))
        .filter(Boolean)
        .filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function buildImprovedNotesFallback(topic, previousNotes, verificationReport) {
    const notes = normalizeNotesPayload(previousNotes, topic);
    const report = normalizeVerificationReport(verificationReport || {}, {
        sources: Array.isArray(verificationReport && verificationReport.sources) ? verificationReport.sources : [],
        evidenceNote: toCleanText(verificationReport && verificationReport.evidenceNote)
    });

    const keyPoints = uniqueListFromArray([]
        .concat(notes.keyPoints || [])
        .concat((report.missingConcepts || []).map(item => `Added concept: ${item}`))
        .concat((report.corrections || []).slice(0, 2).map(item => `Correction to review: ${item}`))
    ).slice(0, 8);

    const sections = (notes.sections || []).map(section => ({
        heading: section.heading,
        content: section.content
    }));

    return normalizeNotesPayload({
        summary: notes.summary,
        keyPoints,
        sections
    }, topic);
}

async function callGroqChat(messages, options = {}) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
        throw new Error('Groq API Key not configured on server');
    }

    const model = options.model || STUDY_NOTES_GROQ_MODEL;

    const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            model,
            messages,
            temperature: options.temperature === undefined ? 0.3 : options.temperature,
            max_tokens: options.maxTokens || 2500
        },
        {
            timeout: TIMEOUT_MS,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${groqKey}`
            }
        }
    );

    const content = response && response.data && response.data.choices && response.data.choices[0]
        && response.data.choices[0].message
        ? response.data.choices[0].message.content
        : '';
    if (!content) {
        throw new Error('Groq returned an empty response.');
    }
    return content;
}

async function searchTavilyEvidence(topic) {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
        return {
            sources: [],
            evidenceNote: 'Tavily API key is not configured, so the verification used limited external evidence.'
        };
    }

    try {
        const response = await axios.post(
            'https://api.tavily.com/search',
            {
                query: `authoritative overview and core concepts of ${topic}`,
                topic: 'general',
                search_depth: 'advanced',
                max_results: 4,
                chunks_per_source: 2,
                include_answer: false,
                include_raw_content: false,
                include_favicon: false
            },
            {
                timeout: TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${tavilyKey}`
                }
            }
        );

        const sources = Array.isArray(response && response.data && response.data.results)
            ? response.data.results
                .map(item => ({
                    title: toCleanText(item && item.title, 'Untitled source'),
                    url: toCleanText(item && item.url),
                    snippet: toCleanText(item && item.content),
                    score: Number(item && item.score) || 0
                }))
                .filter(item => item.url && item.snippet)
            : [];

        return {
            sources,
            evidenceNote: sources.length
                ? ''
                : 'Tavily returned no strong source snippets for this topic, so the verification is partial.'
        };
    } catch (err) {
        return {
            sources: [],
            evidenceNote: `Tavily evidence lookup was limited: ${err.response && err.response.data && err.response.data.error ? err.response.data.error : err.message}`
        };
    }
}

app.post('/api/generate-notes', async (req, res) => {
    try {
        const prompt = toCleanText(req.body && req.body.prompt);
        const explicitTopic = toCleanText(req.body && req.body.topic);
        const topic = explicitTopic || prompt;
        if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

        const tavilyResult = await searchTavilyEvidence(topic);
        const sourceSummary = buildVerificationEvidenceSummary(tavilyResult);
        const hasEvidence = Array.isArray(tavilyResult && tavilyResult.sources) && tavilyResult.sources.length > 0;
        let result;
        try {
            const genPrompt = [
                'Generate a comprehensive study package for the topic below.',
                'Use the Tavily sources for factual accuracy, but write in your own clear teaching language — never copy snippets verbatim.',
                '',
                'TOPIC: ' + topic,
                '',
                hasEvidence ? ('TAVILY SOURCES:\n' + sourceSummary) : 'No external sources available — use your knowledge of this topic.',
                '',
                'STRICT RULES:',
                '- Do NOT use website names, URLs, or author bylines as headings or content.',
                '- Do NOT mention Tavily, Groq, or AI in the output content.',
                '- All content must be topic-specific. No generic filler.',
                '- Vary which option index (0-3) is correct across quiz questions.',
                '- Flashcard answers: 2-3 informative sentences each.',
                '- Section content: 2-4 clear teaching sentences each.',
                '- keyPoints: exactly 6 specific, useful revision bullets.',
                '- sections: exactly 5 sections with conceptual headings.',
                '- mindmap branches: exactly 4 with 3 subnodes each (max 6 words per subnode).',
                '- flowchart: exactly 6 steps — a progressive, topic-specific learning path (not generic advice).',
                '- flashcards: exactly 6 cards testing different concepts.',
                '- quiz: exactly 5 questions with 4 options each.',
                '',
                'Return ONLY valid JSON — no markdown fences, no extra keys:',
                '{"topic":"TOPIC","notes":{"summary":"4-6 sentence overview","keyPoints":["p1","p2","p3","p4","p5","p6"],"sections":[{"heading":"What TOPIC Is","content":"..."},{"heading":"Core Concepts","content":"..."},{"heading":"How It Works","content":"..."},{"heading":"Practical Applications","content":"..."},{"heading":"Key Benefits","content":"..."}]},"mindmap":{"center":"TOPIC","branches":[{"label":"Branch1","color":"#7c5cfc","subnodes":["s1","s2","s3"]},{"label":"Branch2","color":"#4facfe","subnodes":["s1","s2","s3"]},{"label":"Branch3","color":"#34d399","subnodes":["s1","s2","s3"]},{"label":"Branch4","color":"#f59e0b","subnodes":["s1","s2","s3"]}]},"flowchart":[{"step":1,"title":"Topic-specific step 1","description":"What to do at this stage"},{"step":2,"title":"...","description":"..."},{"step":3,"title":"...","description":"..."},{"step":4,"title":"...","description":"..."},{"step":5,"title":"...","description":"..."},{"step":6,"title":"...","description":"..."}],"flashcards":[{"question":"Q1?","answer":"A1"},{"question":"Q2?","answer":"A2"},{"question":"Q3?","answer":"A3"},{"question":"Q4?","answer":"A4"},{"question":"Q5?","answer":"A5"},{"question":"Q6?","answer":"A6"}],"quiz":[{"question":"Q1?","options":["A","B","C","D"],"correct":0},{"question":"Q2?","options":["A","B","C","D"],"correct":2},{"question":"Q3?","options":["A","B","C","D"],"correct":1},{"question":"Q4?","options":["A","B","C","D"],"correct":3},{"question":"Q5?","options":["A","B","C","D"],"correct":0]}]'
            ].join('\n');
            const raw = await callGroqChatWithRetry(
                [
                    { role: 'system', content: 'You are an expert educator. Return ONLY valid JSON matching the exact shape requested. No markdown code fences.' },
                    { role: 'user', content: genPrompt }
                ],
                { temperature: 0.4, maxTokens: 3200 },
                { retries: 2, backoffMs: 1500 }
            );
            const parsed = parseJsonObjectFromModelResponse(raw, 'generated study package');
            result = {
                topic,
                notes: normalizeNotesPayload(parsed.notes || parsed, topic),
                mindmap: parsed.mindmap || null,
                flowchart: Array.isArray(parsed.flowchart) && parsed.flowchart.length ? parsed.flowchart : null,
                flashcards: Array.isArray(parsed.flashcards) ? parsed.flashcards : [],
                quiz: Array.isArray(parsed.quiz) ? parsed.quiz : [],
                sources: (tavilyResult && tavilyResult.sources) || [],
                evidenceNote: toCleanText(tavilyResult && tavilyResult.evidenceNote),
                providerLimited: false
            };
        } catch (groqErr) {
            console.warn('[generate-notes] Groq failed, using Tavily fallback:', groqErr.message);
            result = buildNotesFromEvidence(topic, tavilyResult);
            result.providerLimited = true;
        }
        res.json({ result });
    } catch (err) {
        console.error('[generate-notes]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/verify-notes', async (req, res) => {
    try {
        const topic = toCleanText(req.body && req.body.topic);
        const notesContent = toCleanText(req.body && req.body.notesContent);
        if (!topic || !notesContent) {
            return res.status(400).json({ error: 'Topic and notes content required' });
        }

        const tavilyResult = await searchTavilyEvidence(topic);
        const sourceSummary = buildVerificationEvidenceSummary(tavilyResult);
        const hasEvidence = Array.isArray(tavilyResult && tavilyResult.sources) && tavilyResult.sources.length > 0;
        let verifyResult;
        try {
            const verifyPrompt = [
                'You are a strict, honest academic fact-checker. Evaluate the student notes below against the Tavily sources and return a verification report with REAL computed scores.',
                '',
                'TOPIC: ' + topic,
                '',
                'STUDENT NOTES:',
                notesContent.slice(0, 4000),
                '',
                hasEvidence ? ('TAVILY SOURCES (ground truth):\n' + sourceSummary) : 'NOTE: No Tavily sources found. Cap score at 60 and set status=partial.',
                '',
                'SCORING: Calculate REAL integer scores (0-100) for each field based on your actual analysis. Do NOT use example/placeholder numbers.',
                '',
                'Return ONLY valid JSON — no markdown fences:',
                '{"status":"COMPUTED_STATUS","score":OVERALL_0_100,"overview":"2-3 sentence honest quality summary based on actual analysis","accuracy":{"score":ACCURACY_0_100,"issues":["specific inaccuracy found in notes"],"strengths":["specific accurate point in notes"]},"completeness":{"score":COMPLETENESS_0_100,"missing":["important concept missing from notes"],"covered":["concept well covered in notes"]},"clarity":{"score":CLARITY_0_100,"feedback":"specific clarity observation about the notes"},"depth":{"score":DEPTH_0_100,"assessment":"specific depth observation about how deeply concepts are explained"},"corrections":["specific correction needed"],"missingConcepts":["concept to add"],"verifiedFacts":["confirmed fact from sources"],"improvementPrompt":"Specific guidance on which concepts to expand or correct - reference actual note content."}',
                '',
                'RULES: status="verified" if score>=85, "partial" if 40-84, "unverified" if <40. Replace ALL CAPS placeholders with your actual computed integers. Do not output placeholder text literally.'
            ].join('\n');
            const rawVerify = await callGroqChatWithRetry(
                [
                    { role: 'system', content: 'You are a strict academic fact-checker. Carefully evaluate student notes against provided sources. Compute REAL integer scores for each dimension — do NOT copy example values. Return ONLY valid JSON.' },
                    { role: 'user', content: verifyPrompt }
                ],
                { temperature: 0.3, maxTokens: 1800 },
                { retries: 1, backoffMs: 1500 }
            );
            const parsed = parseJsonObjectFromModelResponse(rawVerify, 'verification report');
            if (typeof parsed.score === 'number') {
                parsed.status = parsed.score >= 85 ? 'verified' : 'partial';
            }
            verifyResult = normalizeVerificationReport(parsed, {
                sources: (tavilyResult && tavilyResult.sources) || [],
                evidenceNote: toCleanText(tavilyResult && tavilyResult.evidenceNote)
            });
        } catch (groqErr) {
            console.warn('[verify-notes] Groq failed, using heuristic fallback:', groqErr.message);
            verifyResult = buildVerificationFallback(topic, notesContent, tavilyResult);
        }
        res.json(verifyResult);
    } catch (err) {
        console.error('[verify-notes]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/regenerate-notes-with-feedback', async (req, res) => {
    try {
        const topic = toCleanText(req.body && req.body.topic);
        const previousNotes = req.body && req.body.previousNotes;
        const verificationReport = req.body && req.body.verificationReport;

        if (!topic || !previousNotes || !verificationReport) {
            return res.status(400).json({ error: 'Topic, previous notes, and verification report are required' });
        }

        const normalizedPreviousNotes = normalizeNotesPayload(previousNotes, topic);
        const normalizedVerification = normalizeVerificationReport(verificationReport, {
            sources: Array.isArray(verificationReport && verificationReport.sources) ? verificationReport.sources : [],
            evidenceNote: toCleanText(verificationReport && verificationReport.evidenceNote)
        });
        const priorMistakes = toStringArray(
            []
                .concat(verificationReport.priorMistakes || [])
                .concat(verificationReport.prior_mistakes || [])
                .concat(normalizedVerification.corrections || [])
                .concat(normalizedVerification.missingConcepts || [])
        );

        const tavilyResult = await searchTavilyEvidence(topic);
        const sourceSummary = buildVerificationEvidenceSummary(tavilyResult);

        // Build compact payloads — no pretty-print, strip sources (already in TAVILY EVIDENCE)
        // Raise notes cap to 6000 so improved notes aren't truncated on re-improvement
        const currentScore = normalizedVerification.score || 0;
        const isHighScore = currentScore >= 85;
        const compactVerification = isHighScore
            ? {
                // High-score notes: only send real corrections and missing concepts
                // Omit suggestions to prevent Groq from over-editing working content
                corrections: (normalizedVerification.corrections || []).slice(0, 5),
                missingConcepts: (normalizedVerification.missingConcepts || []).slice(0, 5),
                improvementPrompt: normalizedVerification.improvementPrompt || '',
                priorMistakes: priorMistakes.slice(0, 5)
            }
            : {
                corrections: normalizedVerification.corrections || [],
                missingConcepts: normalizedVerification.missingConcepts || [],
                suggestions: normalizedVerification.suggestions || [],
                improvementPrompt: normalizedVerification.improvementPrompt || '',
                priorMistakes: priorMistakes.slice(0, 12)
            };
        const previousNotesStr = JSON.stringify(normalizedPreviousNotes).slice(0, 6000);
        const verificationStr = JSON.stringify(compactVerification).slice(0, 2000);
        const evidenceStr = sourceSummary.slice(0, 3000);
        const highScoreGuard = isHighScore
            ? `\n- IMPORTANT: These notes already scored ${currentScore}%. They are mostly correct. Make ONLY the specific corrections listed. Do NOT change sections that are already verified correct. Minimal targeted edits only.`
            : '';

        const promptText = `Rewrite these study notes so they clearly improve on the earlier version using ONLY the evidence below.

TOPIC:
${topic}

EARLIER NOTES JSON:
${previousNotesStr}

VERIFICATION REPORT JSON:
${verificationStr}

TAVILY EVIDENCE:
${evidenceStr}

Rules:
- Correct every flagged issue.
- Include missing concepts that matter for understanding the topic.
- Preserve useful accurate parts when possible.
- Treat the prior mistakes as a hard do-not-repeat list.
- Improve the overview, key points, and sections so the notes are clearly better than before.
- Aim for notes that could earn an 85-plus score on a strict Tavily verification by being accurate, complete, clear, and sufficiently deep.
- Do not mention verification, scores, Tavily, Groq, or provider limits inside the notes.
- If the report shows uncertainty, rewrite cautiously instead of inventing facts.
- Do NOT reproduce the previous notes verbatim. Write genuinely new, improved content.
- Include all 5 sections with conceptual headings. Target score: 85+.${highScoreGuard}
- Return ONLY valid JSON with this exact shape (no markdown fences):
{
  "notes": {
    "summary": "Write 4-6 sentences summarising the topic here.",
    "keyPoints": ["Specific key point one.", "Specific key point two.", "Specific key point three.", "Specific key point four.", "Specific key point five.", "Specific key point six."],
    "sections": [
      { "heading": "What TOPIC Is", "content": "Write 2-4 sentences of real content here." },
      { "heading": "Core Concepts", "content": "Write 2-4 sentences of real content here." },
      { "heading": "How It Works", "content": "Write 2-4 sentences of real content here." },
      { "heading": "Practical Applications", "content": "Write 2-4 sentences of real content here." },
      { "heading": "Key Benefits", "content": "Write 2-4 sentences of real content here." }
    ]
  }
}`;
        // Note: mindmap, flashcards, quiz, flowchart are intentionally excluded. 
        // We preserve the initial AI generation for those.

        const rawImprovedNotes = await callGroqChatWithRetry(
            [
                {
                    role: 'system',
                    content: 'You are an expert educator rewriting weak study notes. You MUST fix every issue listed in the verification report. You MUST NOT reproduce the previous notes verbatim — write genuinely improved content grounded in the Tavily sources. Return ONLY valid JSON. No markdown fences.'
                },
                { role: 'user', content: promptText }
            ],
            { temperature: 0.35, maxTokens: 3200 },
            { retries: 2, backoffMs: 1500 }
        );

        const parsedImproved = parseJsonObjectFromModelResponse(rawImprovedNotes, 'improved notes');
        const notes = normalizeNotesPayload(parsedImproved.notes || parsedImproved, topic);
        const improvedResult = { notes, providerLimited: false, fallback: false };
        // Intentionally do NOT regenerate or overwrite mindmap, flashcards, quiz, or flowchart
        // Focus Groq's tokens and attention purely on improving the notes text.
        res.json(improvedResult);
    } catch (err) {
        console.error('[regenerate-notes-with-feedback]', err.message);
        if (isGroqRateLimitError(err) || /Could not parse improved notes JSON response|Groq returned an empty response/i.test(String(err && err.message || ''))) {
            const topic = toCleanText(req.body && req.body.topic);
            const previousNotes = req.body && req.body.previousNotes;
            const verificationReport = req.body && req.body.verificationReport;
            const fallbackNotes = buildImprovedNotesFallback(topic, previousNotes, verificationReport);
            return res.json({
                notes: fallbackNotes,
                providerLimited: true,
                fallback: true,
                message: 'Groq was rate-limited, so SkillSwap used a fallback note improver. Re-run later for a stronger AI rewrite.'
            });
        }
        res.status(500).json({ error: err.message });
    }
});

// ── Start server (single listen — after all routes are registered) ──────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SkillSwap Verification Server — port ${PORT}`);
    console.log(`🔐 Ownership code: "${OWNERSHIP_CODE}" | Cap without it: ${UNVERIFIED_CAP}`);
    console.log(`🤖 Groq AI: ${process.env.GROQ_API_KEY ? 'Configured ✅' : 'NOT configured ❌'}`);
    if (!process.env.GROQ_API_KEY) console.warn('[WARNING] GROQ_API_KEY not set — AI features disabled.');
});

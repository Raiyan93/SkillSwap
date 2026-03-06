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
    allowedHeaders: ['Content-Type']
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

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ownershipCode: OWNERSHIP_CODE }));

app.listen(5000, () => {
    console.log('🚀 SkillSwap Verification Server — port 5000');
    console.log(`🔐 Ownership code: "${OWNERSHIP_CODE}" | Cap without it: ${UNVERIFIED_CAP}`);
});
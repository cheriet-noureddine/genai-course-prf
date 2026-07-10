const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Data loaded once at boot. In a real deployment swap these for DB reads
// (e.g. Postgres/Mongo) - the route handlers below don't care where the
// data comes from, only that bodies/answers never leave the server directly.
// ---------------------------------------------------------------------------
const courseMeta = readJSON('course-meta.json');
const lessonQuizzes = readJSON('lesson-quizzes.json'); // { "mi-li": {q,opts,correct,explain} }
const authConfig = readJSON('auth.json'); // { salt, hash }

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
}

function lessonExists(mi, li) {
  return fs.existsSync(path.join(DATA, 'lessons', `${mi}-${li}.json`));
}
function readLesson(mi, li) {
  return readJSON(path.join('lessons', `${mi}-${li}.json`));
}
function readModuleQuiz(mi) {
  const p = path.join(DATA, 'module-quizzes', `${mi}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function readDiagram(key) {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '');
  const p = path.join(DATA, 'diagrams', `${safe}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// ---------------------------------------------------------------------------
// Stateless, signed-cookie sessions.
//
// This used to be `const sessions = new Map()` (token -> {createdAt}) kept
// in server memory. That works fine on a single long-running Node process,
// but breaks on serverless deployments (e.g. Vercel): each request can be
// routed to a different, independent function instance, and each instance
// has its OWN empty Map. A login on instance A is invisible to instance B,
// so any later request that happens to land on a different instance gets a
// spurious 401 - which is exactly what caused lesson content/quizzes to
// intermittently vanish while clicking through the course (the client
// treats a failed quiz fetch as "no quiz for this lesson" and just skips
// it), and occasional "not authenticated" errors while paging forward.
//
// Fix: the session token itself carries its own proof of validity (an
// HMAC signature), so ANY instance can verify it with no shared state and
// no database/Redis needed. `getSession` below is a pure function of the
// cookie value.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'genai_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const SESSION_SECRET = process.env.SESSION_SECRET || authConfig.salt || 'genai-course-fallback-secret';

function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
}

function createSession() {
  const payloadB64 = Buffer.from(JSON.stringify({ iat: Date.now() })).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

function getSession(req) {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payloadB64);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || typeof payload.iat !== 'number' || Date.now() - payload.iat > SESSION_TTL_MS) return null;
  return { createdAt: payload.iat };
}
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Non authentifié.' });
  req.session = session;
  next();
}

function verifyPassword(candidate) {
  const hash = crypto.scryptSync(candidate, authConfig.salt, 64).toString('hex');
  // timing-safe compare
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(authConfig.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();

// When deployed behind a reverse proxy (nginx, Caddy, a load balancer, etc.)
// express needs to know so req.ip / X-Forwarded-For is trusted correctly;
// otherwise express-rate-limit ends up counting requests against the
// proxy's IP instead of the real client's, which defeats the login/quiz
// limiters below. Set TRUST_PROXY=1 (or the number of hops) in production.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY;
  app.set('trust proxy', tp === 'true' ? 1 : (Number.isNaN(Number(tp)) ? tp : Number(tp)));
}

// Security headers. CSP is left off because the lesson/diagram content
// intentionally uses inline <script> tags and onclick="" handlers (see
// loadDiagram in public/app.js) - a default CSP would break those. Every
// other helmet protection (X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, etc.) still applies.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

// Quiz options are few (usually 4), so without a limiter here someone could
// script-guess correct answers by hammering /quiz/submit. Same shape as
// loginLimiter, kept as its own instance so quiz attempts and login attempts
// don't share one counter.
//
// IMPORTANT: this must be keyed per-quiz (session + route), not just per
// IP/session globally. The course has 29 lesson quizzes + 7 module quizzes
// = 36 legitimate submit calls to finish it once, with zero retries. A
// single shared counter capped at 30 meant every student got hard-blocked
// with a 429 partway through the course just from normal progress - not
// from abuse. Scoping the key to req.originalUrl keeps the brute-force
// protection meaningful (30 attempts on the SAME question in 15 minutes is
// still plenty to catch script-guessing) without that budget being drained
// by simply moving through the rest of the course.
const quizSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.cookies && req.cookies[SESSION_COOKIE];
    return `${token || req.ip}:${req.originalUrl}`;
  },
  message: { error: 'Trop de tentatives, réessayez plus tard.' },
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || !verifyPassword(password)) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  const token = createSession();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD, // requires HTTPS; only safe to force on once actually deployed behind TLS
    maxAge: SESSION_TTL_MS,
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: !!session });
});

// ---------------------------------------------------------------------------
// Course structure - table of contents only. No lesson bodies, no answers.
// ---------------------------------------------------------------------------
app.get('/api/toc', requireAuth, (req, res) => {
  res.json(courseMeta);
});

app.get('/api/final-project', requireAuth, (req, res) => {
  res.json(courseMeta.finalProject);
});

// ---------------------------------------------------------------------------
// Single lesson, fetched on demand. This is the "serve only the current
// lesson" piece: the client never sees any lesson body except the one
// it's currently viewing.
// ---------------------------------------------------------------------------
app.get('/api/lesson/:mi/:li', requireAuth, (req, res) => {
  const mi = parseInt(req.params.mi, 10);
  const li = parseInt(req.params.li, 10);
  if (Number.isNaN(mi) || Number.isNaN(li) || !lessonExists(mi, li)) {
    return res.status(404).json({ error: 'Leçon introuvable.' });
  }
  res.json(readLesson(mi, li));
});

// Lesson quiz question WITHOUT the correct answer or explanation.
app.get('/api/lesson/:mi/:li/quiz', requireAuth, (req, res) => {
  const key = `${req.params.mi}-${req.params.li}`;
  const quiz = lessonQuizzes[key];
  if (!quiz) return res.status(404).json({ error: 'Quiz introuvable.' });
  res.json({ q: quiz.q, opts: quiz.opts });
});

// Grade the answer server-side; only now do we reveal correct/explain.
app.post('/api/lesson/:mi/:li/quiz/submit', requireAuth, quizSubmitLimiter, (req, res) => {
  const key = `${req.params.mi}-${req.params.li}`;
  const quiz = lessonQuizzes[key];
  if (!quiz) return res.status(404).json({ error: 'Quiz introuvable.' });
  const { selected } = req.body || {};
  if (typeof selected !== 'number') {
    return res.status(400).json({ error: 'Réponse manquante.' });
  }
  res.json({
    correct: selected === quiz.correct,
    correctIndex: quiz.correct,
    explain: quiz.explain,
  });
});

// Module quiz - same pattern: questions without answers, then grade on submit.
app.get('/api/module/:mi/quiz', requireAuth, (req, res) => {
  const mi = parseInt(req.params.mi, 10);
  const quiz = readModuleQuiz(mi);
  if (!quiz) return res.status(404).json({ error: 'Quiz de module introuvable.' });
  res.json({
    title: quiz.title,
    questions: quiz.questions.map((q) => ({ q: q.q, opts: q.opts })),
  });
});

app.post('/api/module/:mi/quiz/submit', requireAuth, quizSubmitLimiter, (req, res) => {
  const mi = parseInt(req.params.mi, 10);
  const quiz = readModuleQuiz(mi);
  if (!quiz) return res.status(404).json({ error: 'Quiz de module introuvable.' });
  const { answers } = req.body || {}; // array of selected indices, same order as questions
  if (!Array.isArray(answers) || answers.length !== quiz.questions.length) {
    return res.status(400).json({ error: 'Réponses invalides.' });
  }
  let score = 0;
  const results = quiz.questions.map((q, i) => {
    const correct = answers[i] === q.correct;
    if (correct) score++;
    return { correct, correctIndex: q.correct, explain: q.explain };
  });
  res.json({ score, total: quiz.questions.length, results });
});

// Diagram fragments (charts etc.) - fetched only when a lesson that
// references them is actually rendered.
app.get('/api/diagram/:key', requireAuth, (req, res) => {
  const diagram = readDiagram(req.params.key);
  if (!diagram) return res.status(404).json({ error: 'Diagramme introuvable.' });
  res.json(diagram);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Course API listening on http://localhost:${PORT}`);
});

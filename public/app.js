// ---------------------------------------------------------------------------
// All course content lives on the server. This file only ever asks for:
//   - the table of contents (titles, no lesson text, no quiz answers)
//   - the ONE lesson currently being viewed
//   - the ONE diagram a lesson references, only when that lesson is open
//   - quiz questions without answers, then a graded result after submitting
// Visual behaviour mirrors the original single-file course exactly.
// ---------------------------------------------------------------------------

const API = '/api';

let toc = null;          // { parts, modules, finalProject } from /api/toc
let FLAT = [];           // flattened [{type:'lesson',mi,li}|{type:'quiz',mi}|{type:'project'}]
let currentIndex = -1;

async function api(path, opts) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Progress (kept client-side in localStorage, exactly like the original —
// it isn't sensitive data, so there's no need to round-trip it through the
// server).
// ---------------------------------------------------------------------------
const PROGRESS_STORAGE_KEY = 'genai_course_progress_v3';
function loadProgress() {
  try { return JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY)) || { done: {}, quizScores: {}, lessonQuiz: {} }; }
  catch (e) { return { done: {}, quizScores: {}, lessonQuiz: {} }; }
}
function saveProgress(p) { localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(p)); }
let progress = loadProgress();
if (!progress.lessonQuiz) progress.lessonQuiz = {};
if (!progress.quizScores) progress.quizScores = {};
if (!progress.done) progress.done = {};

function keyFor(item) {
  if (item.type === 'lesson') return `l-${item.mi}-${item.li}`;
  if (item.type === 'quiz') return `q-${item.mi}`;
  return 'project';
}
function totalCount() { return FLAT.length; }
function doneCount() { return Object.keys(progress.done).filter(k => progress.done[k]).length; }

function updateOverallProgress() {
  const pct = totalCount() ? Math.round((doneCount() / totalCount()) * 100) : 0;
  const fill = document.getElementById('overallFill');
  const pctEl = document.getElementById('overallPct');
  const topbarPct = document.getElementById('topbarPct');
  if (fill) fill.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '% complete';
  if (topbarPct) topbarPct.textContent = pct + '%';
}

function markDone(k, val) {
  progress.done[k] = val;
  saveProgress(progress);
  updateOverallProgress();
}

// ---------------------------------------------------------------------------
// Login gate — replicates the original's centered card exactly, including
// the password field being plain text (never masked) and asking only for
// the course password, no name.
// ---------------------------------------------------------------------------
function showLoginGate(errorMsg) {
  let overlay = document.getElementById('studentGateOverlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'studentGateOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(20,20,16,0.55);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:Inter,sans-serif;';
  overlay.innerHTML = `
    <div style="background:#faf7f0;padding:32px 28px;border-radius:10px;max-width:340px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3);text-align:center;">
      <div style="font-size:32px;margin-bottom:8px;">🎓</div>
      <h2 style="margin:0 0 8px;font-family:'Fraunces',serif;font-size:1.2rem;">Bienvenue</h2>
      <p style="margin:0 0 16px;color:#5a5e54;font-size:.9rem;">Entrez le mot de passe du cours pour continuer.</p>
      <input id="studentNameInput" type="text" placeholder="Mot de passe" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="width:100%;padding:10px 12px;border:1px solid #dcd5c2;border-radius:6px;font-size:.95rem;margin-bottom:10px;box-sizing:border-box;">
      <div id="studentGateError" style="color:#b3413a;font-size:.8rem;min-height:18px;margin-bottom:6px;">${errorMsg || ''}</div>
      <button id="studentGateBtn" style="width:100%;padding:10px;border:none;border-radius:6px;background:#0f6e64;color:#fff;font-size:.95rem;cursor:pointer;">Continuer</button>
    </div>`;
  document.body.appendChild(overlay);
  const input = document.getElementById('studentNameInput');
  const btn = document.getElementById('studentGateBtn');
  input.focus();

  async function submit() {
    const pw = input.value.trim();
    const errEl = document.getElementById('studentGateError');
    if (!pw) { errEl.textContent = 'Veuillez entrer le mot de passe.'; return; }
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      overlay.remove();
      await boot();
    } catch (e) {
      errEl.textContent = 'Mot de passe incorrect.';
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

async function switchStudent() {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  location.reload();
}
document.getElementById('lockLink').addEventListener('click', (e) => { e.preventDefault(); switchStudent(); });

async function checkExistingSession() {
  try {
    const me = await api('/auth/me');
    if (me.authenticated) { await boot(); return; }
  } catch (e) { /* fall through to gate */ }
  showLoginGate();
}

// ---------------------------------------------------------------------------
// Boot: fetch the TOC only (no lesson bodies yet), build the nav & home page
// ---------------------------------------------------------------------------
async function boot() {
  document.getElementById('shell').style.display = '';
  toc = await api('/toc');

  FLAT = [];
  toc.modules.forEach((m) => {
    m.lessons.forEach((l) => FLAT.push({ type: 'lesson', mi: m.mi, li: l.li }));
    FLAT.push({ type: 'quiz', mi: m.mi });
  });
  FLAT.push({ type: 'project' });

  buildNav();
  renderHome();
}

// ---------------------------------------------------------------------------
// Sidebar navigation
// ---------------------------------------------------------------------------
function setActiveNav(idx) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const item = FLAT[idx];
  if (!item) return;
  const k = keyFor(item);
  const el = document.getElementById('navitem-' + k);
  if (el) {
    el.classList.add('active');
    const modDiv = el.closest('.nav-mod');
    if (modDiv) modDiv.classList.add('open');
  }
}

function buildNav() {
  const tree = document.getElementById('navTree');
  tree.innerHTML = '';
  let lastPart = -1;
  toc.modules.forEach((m) => {
    if (m.part !== lastPart) {
      lastPart = m.part;
      const pb = document.createElement('div');
      pb.className = 'part-block';
      const lbl = document.createElement('div');
      lbl.className = 'part-label';
      lbl.style.background = toc.parts[m.part].color;
      lbl.textContent = toc.parts[m.part].label;
      pb.appendChild(lbl);
      tree.appendChild(pb);
    }
    const modDiv = document.createElement('div');
    modDiv.className = 'nav-mod';
    modDiv.id = 'navmod-' + m.mi;
    const head = document.createElement('div');
    head.className = 'nav-mod-title';
    head.innerHTML = `<span class="nav-mod-num">${m.num}</span><span>${m.icon || ''} ${m.title}</span><span class="caret">▶</span>`;
    head.addEventListener('click', () => { modDiv.classList.toggle('open'); });
    modDiv.appendChild(head);

    const lessonsWrap = document.createElement('div');
    lessonsWrap.className = 'nav-lessons';
    m.lessons.forEach((l) => {
      const k = `l-${m.mi}-${l.li}`;
      const item = document.createElement('div');
      item.className = 'nav-item' + (progress.done[k] ? ' done' : '');
      item.id = 'navitem-' + k;
      item.innerHTML = `<span class="dot">${progress.done[k] ? '✓' : ''}</span><span>${l.title}</span>`;
      item.addEventListener('click', () => goTo(FLAT.findIndex(f => f.type === 'lesson' && f.mi === m.mi && f.li === l.li)));
      lessonsWrap.appendChild(item);
    });
    if (m.hasQuiz) {
      const qk = `q-${m.mi}`;
      const quizItem = document.createElement('div');
      quizItem.className = 'nav-item quiz-item' + (progress.done[qk] ? ' done' : '');
      quizItem.id = 'navitem-' + qk;
      quizItem.innerHTML = `<span class="dot">📋</span><span>${m.quizTitle || 'Quiz de module'}</span>`;
      quizItem.addEventListener('click', () => goTo(FLAT.findIndex(f => f.type === 'quiz' && f.mi === m.mi)));
      lessonsWrap.appendChild(quizItem);
    }
    modDiv.appendChild(lessonsWrap);
    tree.appendChild(modDiv);
  });

  const pb = document.createElement('div');
  pb.className = 'part-block';
  const lbl = document.createElement('div');
  lbl.className = 'part-label';
  lbl.style.background = 'var(--ink)';
  lbl.textContent = 'Projet final';
  pb.appendChild(lbl);
  const projItem = document.createElement('div');
  projItem.className = 'nav-item quiz-item' + (progress.done['project'] ? ' done' : '');
  projItem.id = 'navitem-project';
  projItem.style.marginLeft = '20px';
  projItem.innerHTML = `<span class="dot">🎓</span><span>${toc.finalProject.title}</span>`;
  projItem.addEventListener('click', () => goTo(FLAT.findIndex(f => f.type === 'project')));
  pb.appendChild(projItem);
  tree.appendChild(pb);

  wireNavKeyboard();
}

function wireNavKeyboard() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
  });
}

// ---------------------------------------------------------------------------
// Home / hero page
// ---------------------------------------------------------------------------
function renderHome() {
  currentIndex = -1;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const wrap = document.getElementById('contentWrap');
  wrap.innerHTML = `
    <div class="hero">
      <div class="hero-tag">✦ Selouani School · EFIEG</div>
      <h1>IA Générative &amp;<br>Pédagogie</h1>
      <p>Du premier prompt à une séquence pédagogique complète construite avec l'IA — avec un mini-quiz après chaque leçon, des quiz de module et un projet final concret.</p>
      <div class="hero-stats">
        <div class="hero-stat"><span class="hstat-num">${toc.modules.length}</span><span class="hstat-label">Modules</span></div>
        <div class="hero-stat"><span class="hstat-num">${toc.modules.reduce((n, m) => n + m.lessons.length, 0)}</span><span class="hstat-label">Leçons</span></div>
        <div class="hero-stat"><span class="hstat-num">${toc.modules.reduce((n, m) => n + m.lessons.length + (m.hasQuiz ? 1 : 0), 0)}</span><span class="hstat-label">Quiz</span></div>
        <div class="hero-stat"><span class="hstat-num">16h</span><span class="hstat-label">Durée totale</span></div>
      </div>
      <button class="start-btn" id="heroStartBtn">Commencer →</button>
      <div class="howto" style="margin-top:28px;">
        <h3>✦ Ce que contient la formation</h3>
        <div class="howto-grid">
          <div class="howto-item"><span class="howto-icon">⚡</span><span>Un mini-quiz « Quick Check » après chaque leçon</span></div>
          <div class="howto-item"><span class="howto-icon">🖼️</span><span>Des exemples concrets prêts à l'emploi</span></div>
          <div class="howto-item"><span class="howto-icon">📋</span><span>Des quiz de module pour valider les acquis</span></div>
          <div class="howto-item"><span class="howto-icon">💾</span><span>Progression enregistrée automatiquement</span></div>
        </div>
      </div>
    </div>
  `;
  document.getElementById('heroStartBtn').addEventListener('click', () => goTo(0));
  document.title = 'IA Générative pour Enseignants — Formation complète';
  updateOverallProgress();
}

// ---------------------------------------------------------------------------
// Diagrams: fetched only when the lesson that needs them is open.
// ---------------------------------------------------------------------------
async function loadDiagram(key, container) {
  const myToken = navToken;
  let diagram;
  try { diagram = await api(`/diagram/${key}`); }
  catch (e) { return; }
  if (myToken !== navToken) return; // the lesson this diagram belonged to has since been navigated away from

  const wrapper = document.createElement('div');
  wrapper.innerHTML = diagram.html;
  const scripts = wrapper.querySelectorAll('script');
  scripts.forEach(s => s.remove());

  wrapper.querySelectorAll('canvas').forEach(canvas => {
    const existingId = canvas.id;
    if (existingId) {
      const old = document.getElementById(existingId);
      if (old && window.Chart) {
        const existing = Chart.getChart(old);
        if (existing) existing.destroy();
      }
    }
  });

  container.appendChild(wrapper);

  // Re-run inline chart-setup scripts (Chart.js needs the canvas in the DOM first)
  const temp = document.createElement('div');
  temp.innerHTML = diagram.html;
  temp.querySelectorAll('script').forEach(s => {
    try {
      const el = document.createElement('script');
      el.textContent = s.textContent;
      document.body.appendChild(el);
    } catch (e) { console.warn('diagram script error:', e); }
  });
}

// ---------------------------------------------------------------------------
// Lesson mini-quiz ("Vérification rapide"). The question is fetched WITHOUT
// the correct answer; grading happens server-side on submit, which is the
// only point the answer/explain text ever reaches the browser. The result
// is then cached locally so a revisit shows the same state without needing
// another round trip (and without ever storing the raw answer key client
// side ahead of time).
// ---------------------------------------------------------------------------
async function buildLessonQuiz(mi, li, container) {
  const myToken = navToken;
  const key = `${mi}-${li}`;
  let quiz;
  try { quiz = await api(`/lesson/${mi}/${li}/quiz`); }
  catch (e) { return; } // no quiz for this lesson
  // If the user has since navigated to a different page, `container` is a
  // detached node from the lesson we started loading for - appending to it
  // and then looking elements up via document.getElementById (which only
  // searches the live document) would find nothing and throw. Bail instead.
  if (myToken !== navToken) return;

  const saved = progress.lessonQuiz[key];
  const answered = !!saved;

  const div = document.createElement('div');
  div.className = 'lesson-quiz';
  div.id = `lq-${mi}-${li}`;

  div.innerHTML = `
    <div class="lesson-quiz-header">
      <span class="lesson-quiz-badge">Vérification rapide</span>
      <span class="lesson-quiz-title">Testez votre compréhension</span>
    </div>
    <div class="lq-question-text">${quiz.q}</div>
    <div class="lq-opts" id="lqopts-${mi}-${li}">
      ${quiz.opts.map((o, i) => `
        <div class="lq-opt ${answered && saved.selected === i ? 'selected' : ''} ${answered && i === saved.correctIndex ? 'correct' : ''} ${answered && i === saved.selected && !saved.correct ? 'incorrect' : ''} ${answered ? 'disabled' : ''}" data-idx="${i}">
          <span class="lq-letter">${String.fromCharCode(65 + i)}</span>
          <span>${o}</span>
        </div>`).join('')}
    </div>
    <div class="lq-feedback ${answered ? (saved.correct ? 'show correct-fb' : 'show wrong-fb') : ''}" id="lqfb-${mi}-${li}">
      ${answered ? (saved.correct ? '✅ Correct ! ' : '❌ Pas tout à fait. ') + saved.explain : ''}
    </div>
    ${!answered
      ? `<button class="lq-submit" id="lqbtn-${mi}-${li}" disabled>Vérifier la réponse</button>`
      : `<button class="lq-retry" id="lqretry-${mi}-${li}">↺ Réessayer</button>`}
  `;
  container.appendChild(div);

  let selected = null;
  const optsDiv = div.querySelector(`#lqopts-${mi}-${li}`);

  if (!answered) {
    optsDiv.querySelectorAll('.lq-opt').forEach(el => {
      el.addEventListener('click', () => {
        selected = parseInt(el.dataset.idx);
        optsDiv.querySelectorAll('.lq-opt').forEach(o => o.classList.toggle('selected', parseInt(o.dataset.idx) === selected));
        const btn = document.getElementById(`lqbtn-${mi}-${li}`);
        if (btn) btn.disabled = false;
      });
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'radio');
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
    });
    const submitBtn = document.getElementById(`lqbtn-${mi}-${li}`);
    submitBtn.addEventListener('click', async () => {
      if (selected === null) return;
      submitBtn.disabled = true;
      let result;
      try {
        result = await api(`/lesson/${mi}/${li}/quiz/submit`, { method: 'POST', body: JSON.stringify({ selected }) });
      } catch (e) { submitBtn.disabled = false; return; }
      progress.lessonQuiz[key] = { selected, correct: result.correct, correctIndex: result.correctIndex, explain: result.explain };
      saveProgress(progress);

      optsDiv.querySelectorAll('.lq-opt').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        el.classList.add('disabled');
        if (idx === result.correctIndex) el.classList.add('correct');
        else if (idx === selected) el.classList.add('incorrect');
      });
      const fb = document.getElementById(`lqfb-${mi}-${li}`);
      fb.textContent = (result.correct ? '✅ Correct ! ' : '❌ Pas tout à fait. ') + result.explain;
      fb.className = 'lq-feedback show ' + (result.correct ? 'correct-fb' : 'wrong-fb');
      submitBtn.outerHTML = `<button class="lq-retry" id="lqretry-${mi}-${li}">↺ Réessayer</button>`;
      document.getElementById(`lqretry-${mi}-${li}`).addEventListener('click', () => resetLQ(mi, li));
    });
  } else {
    document.getElementById(`lqretry-${mi}-${li}`).addEventListener('click', () => resetLQ(mi, li));
  }
}

function resetLQ(mi, li) {
  const key = `${mi}-${li}`;
  delete progress.lessonQuiz[key];
  saveProgress(progress);
  const mountDiv = document.getElementById(`lq-${mi}-${li}`);
  if (mountDiv) mountDiv.remove();
  const quizMount = document.getElementById('lessonQuizMount');
  if (quizMount) buildLessonQuiz(mi, li, quizMount);
}

// ---------------------------------------------------------------------------
// Fetch and render ONE lesson. Nothing else is downloaded until clicked.
// ---------------------------------------------------------------------------
async function renderLesson(idx) {
  const myToken = navToken;
  currentIndex = idx;
  setActiveNav(idx);
  const item = FLAT[idx];
  const m = toc.modules.find(mod => mod.mi === item.mi);
  const l = m.lessons.find(les => les.li === item.li);
  const k = keyFor(item);
  const isDone = !!progress.done[k];

  const wrap = document.getElementById('contentWrap');
  wrap.innerHTML = '<div class="loading">Chargement de la leçon…</div>';

  let lesson;
  try { lesson = await api(`/lesson/${item.mi}/${item.li}`); }
  catch (e) { if (myToken !== navToken) return; wrap.innerHTML = `<div class="loading">Erreur : ${e.message}</div>`; return; }
  if (myToken !== navToken) return; // a newer navigation started while this was loading

  wrap.innerHTML = `
    <div class="crumb">${toc.parts[m.part].label} · Module ${m.num} · ${m.title}</div>
    <div class="lesson-title">${lesson.title}</div>
    <div class="lesson-meta">
      <span>⏱ ${lesson.time}</span>
      <span>${m.level}</span>
    </div>
    <div class="lesson-body" id="lessonBody">${lesson.body}</div>
    <div id="lessonDiagram"></div>
    <div id="lessonQuizMount"></div>
    <div class="mark-row">
      <div class="mark-complete ${isDone ? 'done' : ''}" id="markBtn">
        ${isDone ? '✓ Leçon terminée' : 'Marquer comme terminé'}
      </div>
    </div>
    <div class="lesson-nav">
      <button class="nav-btn" id="prevBtn">← Précédent</button>
      <button class="nav-btn primary" id="nextBtn">Suivant →</button>
    </div>
  `;

  document.getElementById('markBtn').addEventListener('click', () => toggleDone(k));

  if (lesson.diagramKey) loadDiagram(lesson.diagramKey, document.getElementById('lessonDiagram'));
  buildLessonQuiz(item.mi, item.li, document.getElementById('lessonQuizMount'));

  wirePrevNext(idx);
  document.title = lesson.title + ' — Formation IA';
  window.scrollTo(0, 0);
  closeSidebar();
}

function toggleDone(k) {
  markDone(k, !progress.done[k]);
  const btn = document.getElementById('markBtn');
  if (btn) {
    btn.classList.toggle('done', !!progress.done[k]);
    btn.textContent = progress.done[k] ? '✓ Leçon terminée' : 'Marquer comme terminé';
  }
  buildNav();
}

// ---------------------------------------------------------------------------
// Module quiz: questions without answers, then grade on submit.
// ---------------------------------------------------------------------------
async function renderQuiz(idx) {
  const myToken = navToken;
  currentIndex = idx;
  setActiveNav(idx);
  const item = FLAT[idx];
  const m = toc.modules.find(mod => mod.mi === item.mi);
  const k = keyFor(item);
  const wrap = document.getElementById('contentWrap');
  wrap.innerHTML = '<div class="loading">Chargement du quiz…</div>';

  let quiz;
  try { quiz = await api(`/module/${item.mi}/quiz`); }
  catch (e) { if (myToken !== navToken) return; wrap.innerHTML = `<div class="loading">Erreur : ${e.message}</div>`; return; }
  if (myToken !== navToken) return; // a newer navigation started while this was loading

  let qHtml = '';
  quiz.questions.forEach((q, qi) => {
    let optsHtml = '';
    q.opts.forEach((opt, oi) => {
      optsHtml += `<div class="quiz-opt" data-q="${qi}" data-o="${oi}">
        <span class="letter">${String.fromCharCode(65 + oi)}</span><span>${opt}</span>
      </div>`;
    });
    qHtml += `<div class="quiz-q" id="quizq-${qi}">
      <div class="quiz-q-text">${qi + 1}. ${q.q}</div>
      <div class="quiz-opts">${optsHtml}</div>
      <div class="quiz-explain" id="explain-${qi}"></div>
    </div>`;
  });

  wrap.innerHTML = `
    <div class="crumb">${toc.parts[m.part].label} · Module ${m.num} · ${m.title}</div>
    <div class="lesson-title">${quiz.title}</div>
    <div class="lesson-meta"><span>📋 ${quiz.questions.length} questions</span></div>
    <div class="quiz-result" id="quizResult"></div>
    <div id="quizQuestions">${qHtml}</div>
    <div class="quiz-actions">
      <button class="nav-btn primary" id="submitQuizBtn">Valider le quiz</button>
      <button class="nav-btn" id="retakeBtn" style="display:none">Repasser le quiz</button>
    </div>
    <div class="lesson-nav">
      <button class="nav-btn" id="prevBtn">← Précédent</button>
      <button class="nav-btn primary" id="nextBtn">Suivant →</button>
    </div>
  `;
  wirePrevNext(idx);

  const answers = new Array(quiz.questions.length).fill(null);

  function selectOption(qi, oi) {
    answers[qi] = oi;
    const qBlock = document.getElementById('quizq-' + qi);
    qBlock.querySelectorAll('.quiz-opt').forEach(el => {
      el.classList.toggle('selected', parseInt(el.dataset.o) === oi);
    });
  }

  function wireOptions() {
    document.querySelectorAll('.quiz-opt:not(.disabled)').forEach(el => {
      el.addEventListener('click', () => selectOption(parseInt(el.dataset.q), parseInt(el.dataset.o)));
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'radio');
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
    });
  }
  wireOptions();

  function lockAndReveal(results, selectedAnswers) {
    quiz.questions.forEach((q, qi) => {
      const qBlock = document.getElementById('quizq-' + qi);
      const chosen = selectedAnswers[qi];
      qBlock.querySelectorAll('.quiz-opt').forEach(el => {
        el.classList.add('disabled');
        const oi = parseInt(el.dataset.o);
        if (oi === results[qi].correctIndex) el.classList.add('correct');
        else if (oi === chosen) el.classList.add('incorrect');
        if (oi === chosen) el.classList.add('selected');
      });
      const exp = document.getElementById('explain-' + qi);
      exp.textContent = '💡 ' + results[qi].explain;
      exp.classList.add('show');
    });
  }

  function showResult(score, total) {
    const pass = score >= Math.ceil(total * 0.6);
    const el = document.getElementById('quizResult');
    el.className = 'quiz-result show ' + (pass ? 'pass' : 'fail');
    el.innerHTML = `<div class="score">${score} / ${total}</div><p>${pass ? 'Bravo — vous avez réussi ce quiz.' : 'Pas encore tout à fait — relisez les explications ci-dessous, puis repassez le quiz.'}</p>`;
    document.getElementById('submitQuizBtn').style.display = 'none';
    document.getElementById('retakeBtn').style.display = 'inline-block';
    if (pass) { markDone(k, true); } else { saveProgress(progress); }
    buildNav();
  }

  document.getElementById('submitQuizBtn').addEventListener('click', async () => {
    const submitBtn = document.getElementById('submitQuizBtn');
    submitBtn.disabled = true;
    let result;
    try {
      result = await api(`/module/${item.mi}/quiz/submit`, { method: 'POST', body: JSON.stringify({ answers }) });
    } catch (e) { submitBtn.disabled = false; return; }
    progress.quizScores[k] = { answers: answers.slice(), submitted: true, score: result.score, total: result.total, results: result.results };
    saveProgress(progress);
    lockAndReveal(result.results, answers);
    showResult(result.score, result.total);
  });

  document.getElementById('retakeBtn').addEventListener('click', () => {
    delete progress.quizScores[k];
    saveProgress(progress);
    renderQuiz(idx);
  });

  // Restore a previous attempt, if any, without re-hitting the grading
  // endpoint (the result was already cached locally when it was earned).
  const saved = progress.quizScores[k];
  if (saved && saved.submitted) {
    saved.answers.forEach((ans, qi) => { if (ans !== null && ans !== undefined) selectOption(qi, ans); });
    lockAndReveal(saved.results, saved.answers);
    showResult(saved.score, saved.total);
  }

  window.scrollTo(0, 0);
  closeSidebar();
}

// ---------------------------------------------------------------------------
// Final project page
// ---------------------------------------------------------------------------
function renderProject() {
  const idx = FLAT.length - 1;
  currentIndex = idx;
  setActiveNav(idx);
  const k = 'project';
  const isDone = !!progress.done[k];
  const fp = toc.finalProject;
  let cardsHtml = '';
  fp.deliverables.forEach(d => {
    cardsHtml += `<div class="deliverable-card">
      <h4><span class="tag-icon">${d.icon}</span> ${d.name}</h4>
      <ul>${d.points.map(p => `<li>${p}</li>`).join('')}</ul>
    </div>`;
  });
  const wrap = document.getElementById('contentWrap');
  wrap.innerHTML = `
    <div class="crumb">Projet final · Capstone · ${fp.time}</div>
    <div class="lesson-title">🎓 ${fp.title}</div>
    <p style="color:var(--ink-soft);max-width:620px;margin-bottom:30px;">${fp.desc}</p>
    ${cardsHtml}
    <div class="mark-row">
      <div class="mark-complete ${isDone ? 'done' : ''}" id="markBtn">
        ${isDone ? '✓ Terminé' : 'Marquer le projet final comme terminé'}
      </div>
    </div>
    <div class="lesson-nav">
      <button class="nav-btn" id="prevBtn">← Précédent</button>
      <button class="nav-btn" id="homeBtn">Retour à l'accueil du cours</button>
    </div>
  `;
  document.getElementById('markBtn').addEventListener('click', () => {
    markDone(k, !progress.done[k]);
    const btn = document.getElementById('markBtn');
    btn.classList.toggle('done', !!progress.done[k]);
    btn.textContent = progress.done[k] ? '✓ Terminé' : 'Marquer le projet final comme terminé';
    buildNav();
  });
  document.getElementById('homeBtn').addEventListener('click', () => transitionTo(renderHome));
  document.getElementById('prevBtn').addEventListener('click', () => goTo(idx - 1));
  window.scrollTo(0, 0);
  closeSidebar();
}

// ---------------------------------------------------------------------------
// Prev/next + transitions + sidebar
// ---------------------------------------------------------------------------
function wirePrevNext(idx) {
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (prevBtn) {
    prevBtn.disabled = idx <= 0;
    prevBtn.addEventListener('click', () => {
      if (idx <= 0) return;
      prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      goTo(idx - 1);
    });
  }
  if (nextBtn) {
    const isLast = idx >= FLAT.length - 1;
    nextBtn.textContent = isLast ? 'Aller au projet final →' : 'Suivant →';
    nextBtn.addEventListener('click', () => {
      nextBtn.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
      goTo(idx + 1);
    });
  }
  wireNavKeyboard();
}

// Bumped on every navigation request. Async render functions (renderLesson,
// renderQuiz, and the async pieces they kick off - buildLessonQuiz,
// loadDiagram) capture the token in effect when they start and check it
// again after each await; if it no longer matches, a newer navigation has
// since started and they abandon their update instead of touching the DOM.
// This is what makes clicking "Suivant"/"Précédent" repeatedly (or any nav
// item) in quick succession safe instead of racing overlapping renders
// against each other, which is what used to throw errors on rapid clicks.
let navToken = 0;

function transitionTo(fn) {
  const myToken = ++navToken;
  const wrap = document.getElementById('contentWrap');
  wrap.classList.add('fade-out');
  setTimeout(() => {
    if (myToken !== navToken) return; // superseded by a newer navigation
    wrap.classList.remove('fade-out');
    fn();
    wrap.classList.add('fade-in');
    setTimeout(() => wrap.classList.remove('fade-in'), 250);
  }, 180);
}

function goTo(idx) {
  if (idx < 0) { transitionTo(renderHome); return; }
  if (idx >= FLAT.length) { transitionTo(renderProject); return; }
  const item = FLAT[idx];
  if (item.type === 'lesson') transitionTo(() => renderLesson(idx));
  else if (item.type === 'quiz') transitionTo(() => renderQuiz(idx));
  else transitionTo(renderProject);
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('show');
}
function closeSidebar() {
  if (window.innerWidth > 900) return;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}
document.getElementById('openSidebarBtn').addEventListener('click', openSidebar);

// Fade-in keyframes used for page transitions
const transitionStyle = document.createElement('style');
transitionStyle.textContent = '@keyframes fadeIn{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}';
document.head.appendChild(transitionStyle);

// ---------------------------------------------------------------------------
checkExistingSession();

/**
 * server.js — web UI for the PDF scanner.
 *
 * Usage: npm run web   →   http://localhost:3131
 *
 * Serves the terminal-style page from public/ and three JSON endpoints:
 *   GET  /api/documents  — list scanned documents
 *   POST /api/ingest     — multipart PDF upload, scans synchronously (~20s/book)
 *   POST /api/ask        — { question, history? } → answer or passages
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import multer from 'multer';
import { ingestPdf, slugify, loadIndexes, search, formatContext } from './lib.js';
import { answerWithGroq, quizQuestion, gradeAnswer, revealAnswer, generateStructured, rewriteQuery, groqAvailable } from './llm.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const PORT = process.env.PORT || 3131;

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are accepted'));
  },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/documents', (req, res) => {
  const docs = loadIndexes().map((d) => ({
    name: d.name,
    title: d.title,
    pages: d.pages,
    chunks: d.chunks.length,
  }));
  res.json({ docs, groq: groqAvailable() });
});

app.post('/api/ingest', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const title = (req.body.title || '').trim()
    || req.file.originalname.replace(/\.pdf$/i, '');
  // Keep the PDF under a stable name so /pdf/:slug can serve it later
  const dest = path.join(UPLOAD_DIR, `${slugify(title)}.pdf`);
  try {
    fs.renameSync(req.file.path, dest);
    const started = Date.now();
    const result = await ingestPdf(dest, title);
    if (result.duplicate) {
      fs.rm(dest, { force: true }, () => {});
      return res.status(409).json({
        error: `Already in your library as "${result.existingTitle}" — skipped to avoid duplication.`,
        duplicate: true,
      });
    }
    res.json({ ...result, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (err) {
    fs.rm(dest, { force: true }, () => {});
    res.status(500).json({ error: err.message });
  }
});

// Serve a scanned document's source PDF (so reference links can open it at a page)
app.get('/pdf/:slug', (req, res) => {
  const doc = loadIndexes().find((d) => d.name === req.params.slug);
  if (!doc || !doc.source || !fs.existsSync(doc.source)) {
    return res.status(404).send('Source PDF not available (moved or external drive unplugged?)');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(doc.source).replace(/"/g, '')}"`);
  fs.createReadStream(doc.source).pipe(res);
});

app.post('/api/ask', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  try {
    const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];

    // Follow-ups like "explain that more" retrieve nothing useful verbatim —
    // rewrite them into a standalone query first (best effort).
    let searchQuery = question;
    if (history.length > 0 && groqAvailable()) {
      try { searchQuery = await rewriteQuery(question, history); } catch { /* use raw question */ }
    }

    const hits = await search(searchQuery);
    const sources = [...new Set(hits.map((h) => `p. ${h.pageStart}`))];
    const refs = hits.map((h) => ({
      doc: h.doc,
      slug: h.slug,
      pageStart: h.pageStart,
      pageEnd: h.pageEnd,
      text: h.text,
    }));
    if (groqAvailable()) {
      const answer = await answerWithGroq(question, formatContext(hits), history);
      res.json({ mode: 'groq', answer, sources, refs });
    } else {
      res.json({ mode: 'passages', answer: formatContext(hits), sources, refs });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Quiz mode ────────────────────────────────────────────────────────────────

const toRefs = (hits) => hits.map((h) => ({
  doc: h.doc, slug: h.slug, pageStart: h.pageStart, pageEnd: h.pageEnd, text: h.text,
}));

// Pick a random run of consecutive chunks from a random document
function randomRefs(count = 3) {
  const docs = loadIndexes();
  if (docs.length === 0) return [];
  const doc = docs[Math.floor(Math.random() * docs.length)];
  const start = Math.floor(Math.random() * Math.max(1, doc.chunks.length - count));
  return doc.chunks.slice(start, start + count).map((c) => ({
    doc: doc.title, slug: doc.name, pageStart: c.pageStart, pageEnd: c.pageEnd, text: c.text,
  }));
}

// ── Structured payload validation ────────────────────────────────────────────

const isStr = (s) => typeof s === 'string' && s.trim().length > 0;
const TAG_RE = /^[A-Z][A-Z0-9_]{0,11}$/;
const EXPR_RE = /^[\sA-Z0-9_()!&|]+$/;

// Whitelisted boolean expression over known tags → evaluator function
function exprEvaluator(expr, tags) {
  if (!EXPR_RE.test(expr)) throw new Error('solution has invalid characters');
  const used = expr.match(/[A-Z][A-Z0-9_]*/g) || [];
  for (const t of used) {
    if (!tags.includes(t)) throw new Error(`solution references unknown tag ${t}`);
  }
  const fn = new Function(...tags, `return !!(${expr});`);
  return (values) => fn(...values);
}

function validatePayload(type, p) {
  const fail = (msg) => { throw new Error(msg); };
  if (!isStr(p.hint) || !isStr(p.explanation)) fail('missing hint or explanation');
  switch (type) {
    case 'mcq':
      if (!isStr(p.question)) fail('missing question');
      if (!Array.isArray(p.options) || p.options.length !== 4 || !p.options.every(isStr)) fail('options must be 4 strings');
      if (!Number.isInteger(p.correctIndex) || p.correctIndex < 0 || p.correctIndex > 3) fail('correctIndex must be 0-3');
      if (new Set(p.options.map((o) => o.trim().toLowerCase())).size !== 4) fail('options must be distinct');
      break;
    case 'tf':
      if (!isStr(p.statement)) fail('missing statement');
      if (typeof p.isTrue !== 'boolean') fail('isTrue must be boolean');
      break;
    case 'order':
      if (!isStr(p.question)) fail('missing question');
      if (!Array.isArray(p.items) || p.items.length < 4 || p.items.length > 6 || !p.items.every(isStr)) fail('items must be 4-6 strings');
      if (new Set(p.items.map((i) => i.trim().toLowerCase())).size !== p.items.length) fail('items must be distinct');
      break;
    case 'match':
      if (!isStr(p.question)) fail('missing question');
      if (!Array.isArray(p.pairs) || p.pairs.length < 3 || p.pairs.length > 5) fail('pairs must be 3-5 items');
      for (const pair of p.pairs) if (!pair || !isStr(pair.left) || !isStr(pair.right)) fail('each pair needs left and right');
      if (new Set(p.pairs.map((x) => x.left.trim().toLowerCase())).size !== p.pairs.length) fail('left terms must be distinct');
      break;
    case 'ladder': {
      if (!isStr(p.description)) fail('missing description');
      if (!Array.isArray(p.inputs) || p.inputs.length < 2 || p.inputs.length > 4) fail('inputs must be 2-4 items');
      for (const inp of p.inputs) if (!inp || !TAG_RE.test(inp.tag || '') || !isStr(inp.desc)) fail('each input needs a TAG and desc');
      if (!p.output || !TAG_RE.test(p.output.tag || '') || !isStr(p.output.desc)) fail('output needs a TAG and desc');
      const tags = [...p.inputs.map((i) => i.tag), p.output.tag];
      if (new Set(tags).size !== tags.length) fail('tags must be distinct');
      if (!isStr(p.solution)) fail('missing solution');
      const evalFn = exprEvaluator(p.solution, tags); // throws if malformed
      evalFn(tags.map(() => false)); // must actually evaluate
      break;
    }
    default:
      fail(`unknown type ${type}`);
  }
  return p;
}

const QUIZ_TYPES = ['free', 'mcq', 'tf', 'order', 'match', 'ladder'];

// ── Question bank (persistent training log) ──────────────────────────────────

const DATA_DIR = path.join(ROOT, 'data');
const BANK_FILE = path.join(DATA_DIR, 'question-bank.jsonl');

function readBank() {
  if (!fs.existsSync(BANK_FILE)) return [];
  return fs.readFileSync(BANK_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ── Curriculum: the skill map a job-ready PLC engineer needs ─────────────────
// Results are attributed to a stage by keyword match; the Progress view turns
// that into per-stage mastery.

const CURRICULUM = [
  { id: 'fundamentals', name: 'PLC Fundamentals', desc: 'What a PLC is, the scan cycle, I/O, and the IEC 61131-3 languages.', drill: 'PLC basics and the scan cycle', keywords: ['plc', 'scan cycle', 'input scan', 'output scan', 'iec 61131', 'programmable logic', 'relay logic', 'sensor', 'actuator'] },
  { id: 'ladder', name: 'Ladder Logic', desc: 'Contacts, coils, series/parallel logic, seal-in latches, boolean thinking.', drill: 'ladder logic contacts coils and seal-in circuits', keywords: ['ladder', 'contact', 'coil', 'rung', 'seal-in', 'normally open', 'normally closed', 'boolean', 'latch'] },
  { id: 'timers', name: 'Timers, Counters & Program Flow', desc: 'TON/TOF timers, up/down counters, and controlling program flow.', drill: 'PLC timers and counters', keywords: ['timer', 'ton', 'tof', 'rto', 'counter', 'ctu', 'ctd', 'delay', 'preset', 'accumulator'] },
  { id: 'languages', name: 'Structured Text & IEC Languages', desc: 'ST programming, function blocks, instruction list, and SFC.', drill: 'structured text programming', keywords: ['structured text', 'function block', 'instruction list', 'sfc', 'sequential function', 'variable', 'array', 'enum', 'if then', 'while'] },
  { id: 'comms', name: 'Modbus & Industrial Comms', desc: 'Modbus RTU/TCP, function codes, exceptions, and remote I/O over networks.', drill: 'Modbus protocol and function codes', keywords: ['modbus', 'tcp', 'rtu', 'function code', 'register', 'holding', 'exception', 'client', 'server', 'esp8266', 'network'] },
  { id: 'hardware', name: 'Hardware, Wiring & Commissioning', desc: 'Wiring inputs/outputs, 24 V circuits, sourcing/sinking, installation.', drill: 'wiring PLC inputs and outputs', keywords: ['wiring', 'wire', '24v', '24 v', 'sourcing', 'sinking', 'terminal', 'power supply', 'installation', 'commission', 'circuit', 'gpio'] },
  { id: 'hmi', name: 'HMI & Visualization', desc: 'Operator screens and process visualization over Modbus.', drill: 'HMI visualization of PLC processes', keywords: ['hmi', 'visualization', 'advancedhmi', 'screen', 'operator', 'web server', 'display'] },
];

function attributeStage(text) {
  const lower = ' ' + (text || '').toLowerCase() + ' ';
  let best = 'general';
  let bestHits = 0;
  for (const stage of CURRICULUM) {
    let hits = 0;
    for (const k of stage.keywords) if (lower.includes(k)) hits++;
    if (hits > bestHits) { bestHits = hits; best = stage.id; }
  }
  return best;
}

const verdictPoints = (v) => (v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0);

// POST /api/quiz { topic?, type?, avoid? } → { type, question|payload, refs }
app.post('/api/quiz', async (req, res) => {
  if (!groqAvailable()) return res.status(400).json({ error: 'Quiz mode requires GROQ_API_KEY or XAI_API_KEY' });
  try {
    const topic = (req.body.topic || '').trim();
    const type = QUIZ_TYPES.includes(req.body.type) ? req.body.type : 'free';
    const clientAvoid = Array.isArray(req.body.avoid) ? req.body.avoid.slice(-10) : [];

    // Merge in recent same-type questions from the persistent bank so repeats
    // are avoided across sessions, not just within one page load.
    const bankAvoid = readBank().filter((e) => e.type === type).slice(-15).map((e) => e.question);
    const avoid = [...new Set([...bankAvoid, ...clientAvoid])].slice(-12);

    const refs = topic ? toRefs(await search(topic, 6)) : randomRefs();
    if (refs.length === 0) return res.status(400).json({ error: 'No documents scanned yet' });
    const context = formatContext(refs);

    if (type === 'free') {
      const question = await quizQuestion(context, avoid);
      return res.json({ type, question, refs });
    }

    // LLMs skew true/false toward "true" — steer half the generations false.
    const variant = type === 'tf'
      ? (Math.random() < 0.5
        ? 'Make the statement TRUE.'
        : 'Make the statement FALSE — a plausible misconception a student might believe.')
      : null;

    // Structured: generate → validate, retry once with the validation error
    let payload;
    try {
      payload = validatePayload(type, await generateStructured(type, context, avoid, null, variant));
    } catch (firstErr) {
      payload = validatePayload(type, await generateStructured(type, context, avoid, firstErr.message, variant));
    }

    // LLMs favor certain option positions — shuffle server-side so answer
    // placement carries no signal.
    if (type === 'mcq') {
      const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
      payload.options = order.map((i) => payload.options[i]);
      payload.correctIndex = order.indexOf(payload.correctIndex);
    }

    res.json({ type, payload, refs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quiz/result — append outcome to the question bank log
app.post('/api/quiz/result', (req, res) => {
  const { type, question, verdict, attempts, topic, mode } = req.body || {};
  if (!isStr(type) || !isStr(question) || !isStr(verdict)) {
    return res.status(400).json({ error: 'type, question and verdict are required' });
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      type,
      question,
      verdict,
      attempts: attempts || 1,
      topic: isStr(topic) ? topic : '',
      mode: mode === 'exam' ? 'exam' : 'practice',
      stage: attributeStage(`${topic || ''} ${question}`),
    };
    fs.appendFileSync(BANK_FILE, JSON.stringify(entry) + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curriculum — stages with mastery computed from the question bank
app.get('/api/curriculum', (req, res) => {
  const bank = readBank();
  const stages = CURRICULUM.map((s) => {
    const entries = bank.filter((e) => e.stage === s.id);
    const points = entries.reduce((sum, e) => sum + verdictPoints(e.verdict), 0);
    return {
      id: s.id,
      name: s.name,
      desc: s.desc,
      drill: s.drill,
      answered: entries.length,
      mastery: entries.length > 0 ? Math.round((100 * points) / entries.length) : null,
    };
  });
  res.json({ stages });
});

// GET /api/progress — overall stats, per-type accuracy, recent misses, activity
app.get('/api/progress', (req, res) => {
  const bank = readBank();
  const totals = { answered: bank.length, correct: 0, partial: 0, miss: 0 };
  const byType = {};
  const days = {};
  for (const e of bank) {
    totals[e.verdict] = (totals[e.verdict] || 0) + 1;
    byType[e.type] = byType[e.type] || { answered: 0, points: 0 };
    byType[e.type].answered++;
    byType[e.type].points += verdictPoints(e.verdict);
    const day = e.ts.slice(0, 10);
    days[day] = (days[day] || 0) + 1;
  }
  const recentMisses = bank
    .filter((e) => e.verdict === 'miss')
    .slice(-8)
    .reverse()
    .map((e) => ({ question: e.question, type: e.type, stage: e.stage, ts: e.ts }));
  res.json({ totals, byType, recentMisses, days });
});

// POST /api/quiz/grade { question, answer, refs } → { verdict, feedback, refs }
app.post('/api/quiz/grade', async (req, res) => {
  if (!groqAvailable()) return res.status(400).json({ error: 'Quiz mode requires GROQ_API_KEY or XAI_API_KEY' });
  const { question, answer, refs } = req.body;
  if (!question || !answer || !Array.isArray(refs)) {
    return res.status(400).json({ error: 'question, answer and refs are required' });
  }
  try {
    const { verdict, feedback } = await gradeAnswer(question, answer, formatContext(refs));
    res.json({ verdict, feedback, refs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/quiz/reveal { question, refs } → { answer, refs } (student gave up)
app.post('/api/quiz/reveal', async (req, res) => {
  if (!groqAvailable()) return res.status(400).json({ error: 'Quiz mode requires GROQ_API_KEY or XAI_API_KEY' });
  const { question, refs } = req.body;
  if (!question || !Array.isArray(refs)) {
    return res.status(400).json({ error: 'question and refs are required' });
  }
  try {
    const answer = await revealAnswer(question, formatContext(refs));
    res.json({ answer, refs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multer and other middleware errors as JSON
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`PDF scanner terminal online → http://localhost:${PORT}`);
});

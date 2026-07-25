/**
 * lib.js — shared engine for the PDF scanner.
 *
 * Embeddings run locally via transformers.js (all-MiniLM-L6-v2), so scanning
 * and search need no API key and have no rate limits. The model (~25 MB) is
 * downloaded once on first run and cached.
 *
 * Each scanned PDF becomes one JSON index in index/ holding its chunks,
 * page numbers, and embedding vectors.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
// Import the inner module directly — pdf-parse's index.js runs debug code when
// it can't detect a parent module, which breaks under ESM.
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { pipeline, AutoTokenizer, AutoModelForSequenceClassification } from '@xenova/transformers';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_DIR = path.join(ROOT, 'index');

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const EMBED_MODEL = 'Xenova/bge-base-en-v1.5';
// BGE retrieves better when the query (not the passages) carries this prefix
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
const RERANK_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
const RETRIEVE_K = 30; // hybrid-search candidates handed to the reranker
export const DEFAULT_SUBJECT = 'PLC / Automation';

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  }
  return embedderPromise;
}

export async function embed(texts) {
  const embedder = await getEmbedder();
  const vectors = [];
  for (const text of texts) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data));
  }
  return vectors;
}

async function embedQuery(text) {
  const [vector] = await embed([QUERY_PREFIX + text]);
  return vector;
}

// ── Cross-encoder reranking ──────────────────────────────────────────────────
// Reads question + passage together and scores true relevance — much sharper
// than cosine similarity. Applied to the top RETRIEVE_K hybrid candidates.

let rerankerPromise = null;
function getReranker() {
  if (!rerankerPromise) {
    rerankerPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANK_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { quantized: true }),
    ]);
  }
  return rerankerPromise;
}

async function rerank(question, candidates, topK) {
  const [tokenizer, model] = await getReranker();
  const scores = [];
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    const inputs = tokenizer(batch.map(() => question), {
      text_pair: batch.map((c) => c.text),
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    for (let j = 0; j < batch.length; j++) scores.push(logits.data[j]);
  }
  return candidates
    .map((c, i) => ({ ...c, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── PDF extraction with per-page text so chunks can cite page numbers ────────

export async function extractPages(pdfPath) {
  const pages = [];
  await pdf(fs.readFileSync(pdfPath), {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent();
      // Join items, inserting newlines when the y-position changes (new line on page)
      let lastY = null;
      let text = '';
      for (const item of content.items) {
        const y = item.transform[5];
        text += (lastY !== null && Math.abs(y - lastY) > 1 ? '\n' : ' ') + item.str;
        lastY = y;
      }
      pages.push(text.trim());
      return text;
    },
  });
  return pages;
}

// ── Chunking: fixed-size with overlap, carrying page numbers ─────────────────

export function chunkPages(pages) {
  // Build one continuous string while remembering where each page starts
  let full = '';
  const pageStarts = []; // [charOffset, pageNumber]
  pages.forEach((pageText, i) => {
    pageStarts.push([full.length, i + 1]);
    full += pageText + '\n\n';
  });

  const pageAt = (offset) => {
    let page = 1;
    for (const [start, num] of pageStarts) {
      if (start > offset) break;
      page = num;
    }
    return page;
  };

  const chunks = [];
  let i = 0;
  while (i < full.length) {
    const text = full.slice(i, i + CHUNK_SIZE).trim();
    if (text.length > 50) {
      chunks.push({ text, pageStart: pageAt(i), pageEnd: pageAt(Math.min(i + CHUNK_SIZE, full.length - 1)) });
    }
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

// ── Index storage ────────────────────────────────────────────────────────────

export function indexPath(name) {
  return path.join(INDEX_DIR, `${name}.json`);
}

// ── Duplicate detection ──────────────────────────────────────────────────────
// manifest.json maps slug → { title, hash } so dedup checks don't have to
// parse every (large) index file.

const MANIFEST = path.join(INDEX_DIR, 'manifest.json');

export function fileHash(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}

function updateManifest(slug, title, hash) {
  const m = readManifest();
  m[slug] = { title, hash };
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
}

export function saveIndex(name, docMeta, chunks, embeddings) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const payload = {
    ...docMeta,
    model: EMBED_MODEL,
    createdAt: new Date().toISOString(),
    chunks: chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
  };
  fs.writeFileSync(indexPath(name), JSON.stringify(payload));
}

// In-memory cache of parsed index files, keyed by filename. Every search()
// call used to re-read and JSON.parse the full library from disk (110MB+ at
// 13 docs, ~2s of pure I/O/parsing per question) — now a file is only
// re-parsed when its mtime/size changes, which happens exactly when ingestPdf
// writes a new or updated index. No manual invalidation needed elsewhere.
const indexCache = new Map(); // filename -> { mtimeMs, size, data }

export function loadIndexes() {
  if (!fs.existsSync(INDEX_DIR)) return [];
  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  const fileSet = new Set(files);

  // Evict entries for documents removed from disk since the last call
  for (const cached of indexCache.keys()) {
    if (!fileSet.has(cached)) indexCache.delete(cached);
  }

  const docs = [];
  for (const f of files) {
    const full = path.join(INDEX_DIR, f);
    const stat = fs.statSync(full);
    const cached = indexCache.get(f);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      docs.push(cached.data);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    const data = { name: f.replace(/\.json$/, ''), subject: DEFAULT_SUBJECT, ...parsed };
    indexCache.set(f, { mtimeMs: stat.mtimeMs, size: stat.size, data });
    docs.push(data);
  }
  return docs;
}

// ── Search ───────────────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are normalized, so dot product = cosine similarity
}

// Hybrid search: dense cosine similarity + a keyword bonus. Technical manuals
// hinge on exact tokens (TON, FC03, %IX0.0) that embeddings underweight.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'what', 'how', 'why', 'with', 'that', 'this', 'from',
  'are', 'is', 'a', 'an', 'of', 'to', 'in', 'on', 'does', 'do', 'when',
  'which', 'can', 'you', 'your', 'it', 'be', 'or', 'as', 'at', 'by', 'about',
]);
const KEYWORD_WEIGHT = 0.12;

function queryTokens(question) {
  const raw = question.toLowerCase().match(/[a-z0-9%#._-]{2,}/g) || [];
  return [...new Set(raw)].filter((t) => !STOPWORDS.has(t) && (t.length >= 3 || /\d/.test(t)));
}

export async function search(question, topK = 10, subject = null) {
  let docs = loadIndexes();
  if (subject) {
    docs = docs.filter((d) => d.subject === subject);
    if (docs.length === 0) {
      throw new Error(`No documents scanned for subject "${subject}".`);
    }
  }
  if (docs.length === 0) {
    throw new Error('No scanned documents yet. Run: npm run ingest -- "<path-to-pdf>"');
  }
  // Vectors from a different embedding model are incomparable — skip those
  // docs (they need a re-scan) rather than corrupting the ranking.
  const stale = docs.filter((d) => d.model !== EMBED_MODEL);
  if (stale.length > 0) {
    console.warn(`Skipping ${stale.length} doc(s) indexed with an older embedding model — re-scan: ${stale.map((d) => d.title).join(', ')}`);
    docs = docs.filter((d) => d.model === EMBED_MODEL);
    if (docs.length === 0) {
      throw new Error('All documents were indexed with an older embedding model — re-scan them (npm run ingest) to search again.');
    }
  }

  const queryVec = await embedQuery(question);
  const tokens = queryTokens(question);
  const scored = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      let kw = 0;
      if (tokens.length > 0) {
        const lower = chunk.text.toLowerCase();
        let hits = 0;
        for (const t of tokens) if (lower.includes(t)) hits++;
        kw = hits / tokens.length;
      }
      scored.push({
        doc: doc.title,
        slug: doc.name,
        text: chunk.text,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        score: cosine(queryVec, chunk.embedding) + KEYWORD_WEIGHT * kw,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Drop near-duplicate chunks (manuals repeat headers/boilerplate across pages)
  const kept = [];
  const seen = new Set();
  for (const hit of scored) {
    const sig = hit.text.slice(0, 80);
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push(hit);
    if (kept.length === RETRIEVE_K) break;
  }

  // Rerank the candidates with the cross-encoder; fall back to hybrid order
  // if the reranker fails (e.g. model download interrupted).
  try {
    return await rerank(question, kept, topK);
  } catch (err) {
    console.warn(`Reranker unavailable (${err.message}) — using hybrid order`);
    return kept.slice(0, topK);
  }
}

// ── Full ingest pipeline: PDF → pages → chunks → embeddings → saved index ────

export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export async function ingestPdf(pdfPath, title, subject, onProgress) {
  const resolvedSubject = (subject || '').trim() || DEFAULT_SUBJECT;
  const contentHash = fileHash(pdfPath);
  let slug = slugify(title);

  const manifest = readManifest();
  // Same bytes under a different slug → duplicate; skip and point at the original.
  const dupSlug = Object.keys(manifest).find((s) => manifest[s].hash === contentHash && s !== slug);
  if (dupSlug) {
    return { duplicate: true, slug: dupSlug, existingTitle: manifest[dupSlug].title };
  }
  // Same slug but different bytes → a different document that happens to share
  // the name; keep both by uniquifying the slug instead of silently replacing.
  if (manifest[slug] && manifest[slug].hash !== contentHash) {
    slug = `${slug}-${contentHash.slice(0, 6)}`;
  }

  const pages = await extractPages(pdfPath);
  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    throw new Error('No usable text found in this PDF (it may be a scanned image without OCR).');
  }

  const texts = chunks.map((c) => c.text);
  const embeddings = [];
  for (let i = 0; i < texts.length; i += 16) {
    embeddings.push(...(await embed(texts.slice(i, i + 16))));
    onProgress?.(Math.min(i + 16, texts.length), texts.length);
  }

  saveIndex(slug, { title, source: path.resolve(pdfPath), pages: pages.length, contentHash, subject: resolvedSubject }, chunks, embeddings);
  updateManifest(slug, title, contentHash);
  return { slug, title, subject: resolvedSubject, pages: pages.length, chunks: chunks.length };
}

export function formatContext(hits) {
  return hits
    .map((h) => {
      const pages = h.pageStart === h.pageEnd ? `p. ${h.pageStart}` : `pp. ${h.pageStart}–${h.pageEnd}`;
      return `[${h.doc}, ${pages}]\n${h.text}`;
    })
    .join('\n\n---\n\n');
}

/**
 * ingest.js — scan a PDF into the local knowledge base.
 *
 * Usage:
 *   npm run ingest -- "<path-to-pdf>" [document title] [--subject "<subject>"]
 *
 * Extracts text page by page, chunks it, embeds every chunk locally, and
 * writes index/<slug>.json. No API key, no rate limits.
 */

import fs from 'fs';
import path from 'path';
import { ingestPdf, indexPath, DEFAULT_SUBJECT } from './lib.js';

const rawArgs = process.argv.slice(2);
let subject = null;
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--subject') { subject = rawArgs[++i]; continue; }
  if (a.startsWith('--subject=')) { subject = a.slice('--subject='.length); continue; }
  args.push(a);
}
const [pdfPath, ...titleParts] = args;

if (!pdfPath) {
  console.error('Usage: npm run ingest -- "<path-to-pdf>" [document title] [--subject "<subject>"]');
  process.exit(1);
}
if (!fs.existsSync(pdfPath)) {
  console.error(`File not found: ${pdfPath}`);
  process.exit(1);
}

const title = titleParts.join(' ').trim() || path.basename(pdfPath, path.extname(pdfPath));
const resolvedSubject = (subject || '').trim() || DEFAULT_SUBJECT;

console.log(`Scanning "${title}" [${resolvedSubject}] … (first run downloads the embedding model)`);
const started = Date.now();

try {
  const result = await ingestPdf(pdfPath, title, resolvedSubject, (done, total) => {
    process.stdout.write(`\r  embedded ${done}/${total} chunks`);
  });
  if (result.duplicate) {
    console.log(`Already in the library as "${result.existingTitle}" — skipped (identical file contents).`);
    process.exit(0);
  }
  console.log();
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`✅ Done in ${secs}s — ${result.pages} pages, ${result.chunks} chunks → ${indexPath(result.slug)}`);
  console.log(`Ask questions with:  npm run ask -- "your question"   or   npm run chat`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

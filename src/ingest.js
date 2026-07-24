/**
 * ingest.js — scan a PDF into the local knowledge base.
 *
 * Usage:
 *   npm run ingest -- "<path-to-pdf>" [document title]
 *
 * Extracts text page by page, chunks it, embeds every chunk locally, and
 * writes index/<slug>.json. No API key, no rate limits.
 */

import fs from 'fs';
import path from 'path';
import { ingestPdf, indexPath } from './lib.js';

const [, , pdfPath, ...titleParts] = process.argv;

if (!pdfPath) {
  console.error('Usage: npm run ingest -- "<path-to-pdf>" [document title]');
  process.exit(1);
}
if (!fs.existsSync(pdfPath)) {
  console.error(`File not found: ${pdfPath}`);
  process.exit(1);
}

const title = titleParts.join(' ').trim() || path.basename(pdfPath, path.extname(pdfPath));

console.log(`Scanning "${title}" … (first run downloads the embedding model)`);
const started = Date.now();

try {
  const result = await ingestPdf(pdfPath, title, (done, total) => {
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

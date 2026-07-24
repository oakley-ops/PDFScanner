/**
 * ask.js — one-shot question against the scanned documents.
 *
 * Usage:
 *   npm run ask -- "How do I wire the Raspberry Pi inputs?"
 *
 * Retrieval is fully local. If GROQ_API_KEY is set in .env, the top passages
 * are sent to Groq for a synthesized answer; otherwise the passages themselves
 * are printed with page citations.
 */

import 'dotenv/config';
import { search, formatContext } from './lib.js';
import { answerWithGroq, groqAvailable } from './llm.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

const hits = await search(question);

if (groqAvailable()) {
  const answer = await answerWithGroq(question, formatContext(hits));
  console.log(`\n${answer}\n`);
  console.log('Sources: ' + hits.map((h) => `p. ${h.pageStart}`).join(', '));
} else {
  console.log('\n(No GROQ_API_KEY set — showing the most relevant passages. Add one to .env for synthesized answers.)\n');
  console.log(formatContext(hits));
}

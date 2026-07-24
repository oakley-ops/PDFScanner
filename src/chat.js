/**
 * chat.js — interactive Q&A session over the scanned documents.
 *
 * Usage: npm run chat
 * Type a question, get an answer; Ctrl+C or "exit" to quit.
 * With GROQ_API_KEY set, the last few exchanges are kept as conversation
 * history so follow-up questions work.
 */

import 'dotenv/config';
import readline from 'readline';
import { search, formatContext, loadIndexes } from './lib.js';
import { answerWithGroq, groqAvailable } from './llm.js';

const docs = loadIndexes();
if (docs.length === 0) {
  console.error('No scanned documents yet. Run: npm run ingest -- "<path-to-pdf>"');
  process.exit(1);
}

console.log('Loaded documents:');
for (const d of docs) console.log(`  • ${d.title} (${d.pages} pages, ${d.chunks.length} chunks)`);
console.log(groqAvailable()
  ? 'Groq answers enabled. Ask away — "exit" to quit.\n'
  : 'No GROQ_API_KEY — passages will be shown directly. Ask away — "exit" to quit.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const history = []; // rolling {role, content} pairs for Groq

const prompt = () => rl.question('❓ ', async (line) => {
  const question = line.trim();
  if (!question) return prompt();
  if (question.toLowerCase() === 'exit') { rl.close(); return; }

  try {
    const hits = await search(question);
    if (groqAvailable()) {
      const answer = await answerWithGroq(question, formatContext(hits), history);
      console.log(`\n${answer}\n`);
      console.log('Sources: ' + [...new Set(hits.map((h) => `p. ${h.pageStart}`))].join(', ') + '\n');
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      while (history.length > 8) history.shift();
    } else {
      console.log('\n' + formatContext(hits) + '\n');
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
  prompt();
});

prompt();

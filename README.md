# PLC Instructor

A personal training platform for becoming a job-ready PLC engineer. Scan
technical PDFs (books, vendor manuals, protocol specs) into a local knowledge
base, then learn, drill, and take exams against it. Everything runs on your
machine — embeddings (bge-base-en-v1.5) and cross-encoder reranking
(ms-marco-MiniLM) run locally via transformers.js with no API key and no rate
limits; only answer generation and question writing use Groq's free API
(openai/gpt-oss-120b by default; override with GROQ_MODEL in .env).

Retrieval pipeline: hybrid search (dense cosine + exact-keyword bonus) selects
30 candidates, a local cross-encoder reranks them, and the top 10 ground the
answer. Changing the embedding model requires re-scanning: documents indexed
with an older model are skipped at search time until re-ingested.

## Run it

```bash
npm install
npm run web        # → http://localhost:3131
```

Optional CLI equivalents: `npm run ingest -- "<pdf>" [title]`, `npm run ask -- "question"`, `npm run chat`.

For synthesized answers and quiz generation, copy `.env.example` to `.env` and
add a free Groq key from console.groq.com. Without it, Learn mode still works
(returns cited passages) but Quiz mode is unavailable.

## The three tabs

**Learn** — instructor-style chat over the whole library. Answers cite page
numbers; sources expand to the exact passages, with links that open the PDF at
that page. Follow-up questions are rewritten from conversation context before
retrieval so "explain that more" finds the right pages.

**Quiz** — six question types: multiple choice, true/false, ordering
(drag & drop), matching (drag & drop), a ladder-logic rung builder
(drag contacts into series/parallel, graded by truth-table equivalence with
counterexample feedback), and written answers. Coaching philosophy: wrong
answers get a hint and study pages, never the answer; retry until correct or
give up via "Reveal answer". Scoring: first-try ✓, after retries ½, revealed ✗.
**Start exam** runs a timed 10-question mixed test — 15:00, one attempt each,
no hints — and produces a report card.

**Progress** — a 7-stage curriculum (fundamentals → ladder → timers/counters →
IEC languages → Modbus → wiring → HMI) with mastery bars computed from every
answer you've ever given, per-question-type accuracy, and recent misses with
one-click "drill similar" retakes. Results persist in `data/question-bank.jsonl`.

## How grading stays honest

Structured questions are generated once by the LLM as JSON (schema-validated,
one auto-retry), then graded deterministically in the browser — the LLM is
never in the grading loop. MCQ options are shuffled server-side, true/false
generation is coin-flip balanced, and recent questions are remembered across
sessions to avoid repeats. Only written answers are LLM-graded, against the
retrieved source passages.

## Layout

```
src/lib.js     extraction, chunking, local embeddings, hybrid search, ingest
src/llm.js     Groq calls: answers, query rewrite, question gen, grading
src/ingest.js  CLI scan          src/ask.js  one-shot Q&A     src/chat.js  REPL
src/server.js  Express API: ask / quiz / curriculum / progress / pdf serving
public/        index.html + style.css + app.js (all grading logic client-side)
index/         vector indexes    uploads/  source PDFs    data/  question bank
```
#PDFScanner
# PDFScanner

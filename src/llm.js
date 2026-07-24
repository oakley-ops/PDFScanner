/**
 * llm.js — optional answer generation via Groq and/or xAI Grok.
 *
 * Scanning and search need no API key. When GROQ_API_KEY and/or XAI_API_KEY
 * is set, requests try each backend in order; rate limits and token caps
 * automatically fall through to the next model.
 */

import 'dotenv/config';
import Groq from 'groq-sdk';

const MAX_CONTEXT_CHARS = Number(process.env.LLM_CONTEXT_CHARS) || 10000;

const DEFAULT_GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'qwen/qwen3-32b',
];

function hasKey(name) {
  const key = process.env[name];
  return Boolean(key && !key.startsWith('your_'));
}

function backendKey(b) {
  return `${b.provider}:${b.model}`;
}

function dedupeBackends(chain) {
  const seen = new Set();
  return chain.filter((b) => {
    const k = backendKey(b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseFallbackSpec(spec) {
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(':');
    if (colon <= 0) throw new Error(`Invalid LLM_FALLBACK entry "${entry}" — use provider:model`);
    const provider = entry.slice(0, colon).toLowerCase();
    const model = entry.slice(colon + 1).trim();
    if (provider !== 'groq' && provider !== 'xai') {
      throw new Error(`Unknown LLM provider "${provider}" in LLM_FALLBACK — use groq or xai`);
    }
    if (!model) throw new Error(`Missing model in LLM_FALLBACK entry "${entry}"`);
    if (provider === 'groq' && !hasKey('GROQ_API_KEY')) return null;
    if (provider === 'xai' && !hasKey('XAI_API_KEY')) return null;
    return {
      provider,
      model,
      reasoningEffort: provider === 'groq' && /gpt-oss|qwen/.test(model)
        ? (process.env.GROQ_REASONING_EFFORT || 'low')
        : null,
    };
  }).filter(Boolean);
}

export function llmBackends() {
  if (process.env.LLM_FALLBACK) {
    try {
      return dedupeBackends(parseFallbackSpec(process.env.LLM_FALLBACK));
    } catch (err) {
      console.warn(`LLM_FALLBACK ignored (${err.message}) — using auto chain`);
    }
  }

  const chain = [];
  const primaryModel = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
  const primaryEffort = process.env.GROQ_REASONING_EFFORT || 'high';

  if (hasKey('GROQ_API_KEY')) {
    const models = [primaryModel, ...DEFAULT_GROQ_MODELS.filter((m) => m !== primaryModel)];
    for (const model of models) {
      chain.push({
        provider: 'groq',
        model,
        reasoningEffort: model === primaryModel && /gpt-oss|qwen/.test(model) ? primaryEffort : 'low',
      });
    }
  }

  if (hasKey('XAI_API_KEY')) {
    chain.push({
      provider: 'xai',
      model: process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning',
    });
  }

  return dedupeBackends(chain);
}

export function llmProvider() {
  const chain = llmBackends();
  return chain.length > 0 ? chain[0].provider : null;
}

/** @deprecated use llmAvailable() */
export function groqAvailable() {
  return llmAvailable();
}

export function llmAvailable() {
  return llmBackends().length > 0;
}

function trimContext(context) {
  if (context.length <= MAX_CONTEXT_CHARS) return context;
  return `${context.slice(0, MAX_CONTEXT_CHARS)}\n\n[…excerpts truncated for token limit…]`;
}

function isRetryable(err) {
  const msg = String(err.message || err).toLowerCase();
  const status = err.status ?? err.statusCode ?? err.httpStatus;
  if ([413, 429, 503, 529].includes(status)) return true;
  return /rate.?limit|too large|token|tpm|tpd|rpd|quota|capacity|overloaded|timeout|529|413|429/.test(msg);
}

async function callGroq(backend, { messages, max_tokens, json = false }) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const effort = backend.reasoningEffort;
  const think = effort && /gpt-oss|qwen/.test(backend.model) ? { reasoning_effort: effort } : {};
  try {
    const response = await groq.chat.completions.create({
      model: backend.model,
      max_tokens,
      ...think,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages,
    });
    return response.choices[0].message.content;
  } catch (err) {
    const wrapped = new Error(err.message || 'Groq request failed');
    wrapped.status = err.status;
    throw wrapped;
  }
}

async function callXai(backend, { messages, max_tokens, json = false }) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: backend.model,
      messages,
      max_tokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || data.error || res.statusText;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data.choices[0].message.content;
}

async function chatCompletion(opts) {
  const chain = llmBackends();
  if (chain.length === 0) {
    throw new Error('No LLM API key configured (set GROQ_API_KEY and/or XAI_API_KEY in .env)');
  }

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const backend = { ...chain[i] };
    if (opts.reasoningEffort && backend.provider === 'groq') {
      backend.reasoningEffort = opts.reasoningEffort;
    }
    try {
      const text = backend.provider === 'groq'
        ? await callGroq(backend, opts)
        : await callXai(backend, opts);
      if (i > 0) {
        console.warn(`LLM fallback → ${backendKey(backend)} (after ${chain[i - 1].provider}/${chain[i - 1].model} failed)`);
      }
      return text;
    } catch (err) {
      lastErr = err;
      const hasNext = i < chain.length - 1;
      if (hasNext && isRetryable(err)) {
        console.warn(`LLM ${backendKey(backend)} failed (${err.message}) — trying next`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const DISAGREEMENT_RULE = [
  'If two excerpts disagree with each other on a specific point, do NOT silently pick one',
  'and present it as settled. Say explicitly that the sources disagree, summarize each',
  'position, and name which document (title + page) each came from, so the student can',
  'check the primary source and judge for themselves. Never blend conflicting claims into',
  'one unqualified statement.',
].join('\n');

const SYSTEM_PROMPT = [
  'You are a patient instructor training a student in PLC systems and industrial',
  'automation, coaching them through hands-on work (e.g. building a project in TIA Portal)',
  'using excerpts from books and manuals the student has scanned.',
  '',
  'Default to guiding, not lecturing:',
  '- Give ONE next step at a time — the single action to take right now, plus the',
  '  one-sentence "why" or gotcha that matters for it. Do not queue up step 2, 3, 4 in the',
  '  same reply.',
  '- End nearly every reply with a short checkpoint ("Once you see the config screen, tell',
  '  me what options it shows" / "Does that match what you have?") so it stays a',
  '  back-and-forth, not a monologue.',
  '- Keep replies short — a few sentences plus the step. Save longer explanations for when',
  '  the student is stuck or asks for them.',
  '- If asked a broad "how do I do X" question, do not answer all of it at once: name the',
  '  first concrete step and start there.',
  '',
  'Give the full picture in one reply instead when:',
  '- The student explicitly asks for it ("give me the whole procedure", "just tell me",',
  '  "explain fully", etc.).',
  '- The student is stuck or troubleshooting ("why isn\'t this working") — go as deep as',
  '  needed, not one drip-fed step.',
  '- It is a quick factual lookup (a definition, a value, a single fact), not a multi-step',
  '  task — just answer it.',
  '',
  'Always cite page numbers from the excerpt headers (e.g. "p. 87") so the student can read',
  'more. If the excerpts only partially cover the question, say what is missing.',
  DISAGREEMENT_RULE,
].join('\n');

export async function rewriteQuery(question, history) {
  const convo = history.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-3000);
  const rewritten = await chatCompletion({
    max_tokens: 512,
    reasoningEffort: 'low',
    messages: [
      {
        role: 'system',
        content: 'Rewrite the student\'s latest message as ONE standalone search query for a technical document index, resolving pronouns and references using the conversation. Output only the query text, nothing else.',
      },
      { role: 'user', content: `Conversation so far:\n${convo}\n\nLatest message: ${question}\n\nStandalone search query:` },
    ],
  });
  return rewritten.trim().replace(/^["']|["']$/g, '') || question;
}

export async function answerWithGroq(question, context, history = []) {
  const text = await chatCompletion({
    max_tokens: 4096,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: `Book excerpts:\n\n${trimContext(context)}\n\n---\n\nQuestion: ${question}` },
    ],
  });
  return text;
}

const QUIZ_PROMPT = [
  'You are an instructor writing exam questions for a student of PLC systems and',
  'industrial automation. You will be given excerpts from the study material.',
  'Write exactly ONE exam question that tests understanding of the excerpts.',
  'It must be answerable from the excerpts alone. Prefer questions about concepts,',
  'reasoning, procedures, or applications — not trivia about wording.',
  'If the excerpts genuinely disagree with each other on the point you were about to test,',
  'do not build a question around it — pick a different, uncontested point instead.',
  'Output ONLY the question text, nothing else.',
].join('\n');

export async function quizQuestion(context, avoid = []) {
  const avoidNote = avoid.length
    ? `\n\nDo NOT repeat or closely resemble these earlier questions:\n- ${avoid.join('\n- ')}`
    : '';
  const text = await chatCompletion({
    max_tokens: 2048,
    messages: [
      { role: 'system', content: QUIZ_PROMPT },
      { role: 'user', content: `Study material excerpts:\n\n${trimContext(context)}${avoidNote}\n\n---\n\nWrite one exam question.` },
    ],
  });
  return text.trim();
}

const GRADE_PROMPT = [
  'You are an instructor grading a student\'s answer to an exam question about',
  'PLC systems and industrial automation. Grade ONLY against the provided excerpts.',
  'Your reply MUST start with exactly one of these lines:',
  'VERDICT: CORRECT',
  'VERDICT: PARTIAL',
  'VERDICT: INCORRECT',
  'If the verdict is CORRECT: confirm briefly what made the answer right, citing pages.',
  'If the verdict is PARTIAL or INCORRECT, you are coaching, not answering:',
  '- NEVER state the correct answer or quote the excerpt sentences that contain it.',
  '- Say in general terms what the answer got right and what kind of thing is missing.',
  '- Give ONE guiding hint phrased as something to think about, not a fact.',
  '- Point to where to study: the document name and page numbers from the excerpt headers.',
  '- Encourage the student to read those pages and try the same question again.',
  'A student who says "I don\'t know" gets INCORRECT with study directions and a hint,',
  'never the answer.',
  'If your grading would depend on a fact the excerpts state inconsistently with each other,',
  'say so in your feedback instead of grading as if it were settled — name both sources and',
  'let the student resolve it, rather than marking them wrong against a disputed claim.',
].join('\n');

export async function gradeAnswer(question, studentAnswer, context) {
  const text = (await chatCompletion({
    max_tokens: 2048,
    messages: [
      { role: 'system', content: GRADE_PROMPT },
      { role: 'user', content: `Study material excerpts:\n\n${trimContext(context)}\n\n---\n\nExam question: ${question}\n\nStudent's answer: ${studentAnswer}` },
    ],
  })).trim();
  const match = text.match(/^VERDICT:\s*(CORRECT|PARTIAL|INCORRECT)/i);
  return {
    verdict: match ? match[1].toUpperCase() : 'UNGRADED',
    feedback: text.replace(/^VERDICT:\s*(CORRECT|PARTIAL|INCORRECT)\s*/i, '').trim(),
  };
}

const TYPE_SPECS = {
  mcq: [
    'Create ONE multiple-choice exam question with exactly 4 options.',
    'Return JSON: {"question": string, "options": [string, string, string, string],',
    '"correctIndex": integer 0-3, "hint": string, "explanation": string}',
    'Exactly one option is correct; the wrong options must be plausible.',
  ].join('\n'),
  tf: [
    'Create ONE true/false exam statement. Make it non-trivial — a common',
    'misconception or a precise technical detail. Return JSON:',
    '{"statement": string, "isTrue": boolean, "hint": string, "explanation": string}',
  ].join('\n'),
  order: [
    'Create ONE ordering exercise: a sequence of 4-6 steps or stages described',
    'in the excerpts (a procedure, a protocol transaction, a scan cycle...).',
    'Return JSON: {"question": string (what to arrange), "items": [strings IN',
    'THE CORRECT ORDER], "hint": string, "explanation": string}',
    'Each item must be short (under 12 words) and the order unambiguous.',
  ].join('\n'),
  match: [
    'Create ONE matching exercise: 4 term→definition pairs from the excerpts',
    '(e.g. instructions→behavior, function codes→purpose, components→role).',
    'Return JSON: {"question": string, "pairs": [{"left": short term, "right":',
    'short definition}, x4], "hint": string, "explanation": string}',
    'Definitions must be clearly distinguishable from each other.',
  ].join('\n'),
  ladder: [
    'Create ONE ladder-logic exercise implementable as a SINGLE rung.',
    'Describe a control behavior in plain words (what should happen, when).',
    'Return JSON: {"description": string (the behavior — no ladder jargon,',
    'describe the desired machine behavior), "inputs": [{"tag": UPPERCASE tag',
    'like START or GUARD, "desc": string}, 2-4 items], "output": {"tag":',
    'UPPERCASE, "desc": string}, "solution": string (boolean expression over',
    'the tags using && (series/AND), || (parallel/OR), ! (N.C. contact),',
    'parentheses; use the output tag in the expression ONLY for a seal-in',
    'latch), "hint": string, "explanation": string}',
    'Good patterns: start/stop seal-in, safety interlocks, mode selection.',
    'Example solution for seal-in: "(START || MOTOR) && !STOP"',
  ].join('\n'),
};

export async function generateStructured(type, context, avoid = [], priorError = null, variant = null) {
  const spec = TYPE_SPECS[type];
  if (!spec) throw new Error(`Unknown question type: ${type}`);
  const avoidNote = avoid.length
    ? `\n\nDo NOT repeat or closely resemble these earlier questions:\n- ${avoid.join('\n- ')}`
    : '';
  const errorNote = priorError
    ? `\n\nYour previous attempt was invalid (${priorError}). Fix that and return valid JSON.`
    : '';
  const variantNote = variant ? `\n\n${variant}` : '';
  const text = await chatCompletion({
    max_tokens: 4096,
    json: true,
    messages: [
      {
        role: 'system',
        content: [
          'You are an instructor writing exam material for a student of PLC systems',
          'and industrial automation. Base the question ONLY on the provided excerpts.',
          'The "hint" must guide thinking WITHOUT giving away the answer.',
          'The "explanation" teaches why the answer is right, citing pages (e.g. "p. 12").',
          'If the excerpts genuinely disagree with each other on the point this question would',
          'test, pick a different, uncontested point instead — never build graded material on',
          'a disputed claim.',
          'Respond with a single JSON object exactly matching the requested schema.',
          spec,
        ].join('\n'),
      },
      { role: 'user', content: `Study material excerpts:\n\n${trimContext(context)}${avoidNote}${errorNote}${variantNote}\n\n---\n\nWrite the question as JSON.` },
    ],
  });
  return JSON.parse(text);
}

const REVEAL_PROMPT = [
  'You are an instructor. The student has given up on an exam question.',
  'Using ONLY the provided excerpts, give the model answer clearly and completely,',
  'citing page numbers (e.g. "p. 18"). Then add one sentence on what to review',
  'so this topic sticks.',
  DISAGREEMENT_RULE,
].join('\n');

export async function revealAnswer(question, context) {
  const text = await chatCompletion({
    max_tokens: 2048,
    messages: [
      { role: 'system', content: REVEAL_PROMPT },
      { role: 'user', content: `Study material excerpts:\n\n${trimContext(context)}\n\n---\n\nExam question: ${question}` },
    ],
  });
  return text.trim();
}

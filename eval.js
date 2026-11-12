#!/usr/bin/env node
// Evaluation harness — scores the current prompt (prompts.js) against the photos you have verified.
//
//   ANTHROPIC_API_KEY=sk-ant-... node eval.js                 # held-out test set (~20% of verified photos)
//   ANTHROPIC_API_KEY=sk-ant-... node eval.js --limit 20      # quick smoke test
//   ANTHROPIC_API_KEY=sk-ant-... node eval.js --split all     # every verified photo
//   node eval.js --history                                    # show past runs, no API key needed
//
// Options: --api <url>  --model <id>  --split test|train|all  --limit <n>  --concurrency <n>  --label <text>
//
// How it works: verified photos (your confirmed/corrected answers) are the "answer key". Each photo is
// re-analysed with the prompt currently in prompts.js and compared to your answer, field by field.
// ~20% of photos (chosen by a hash of their id, so it never changes) are the held-out TEST set: use
// the other ~80% to learn from (examples, style guide) and keep the test set only for scoring.
// Results are appended to evals/history.json so you can compare prompt versions over time.
// Cost: roughly 1 Claude image call per photo (~$0.02 each); the images are the 900px gallery copies.

const fs = require('fs');
const path = require('path');
const { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } = require('./prompts.js');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = name => argv.includes('--' + name);

const API = (opt('api', process.env.ART_API || 'https://art-pokedex-production.up.railway.app')).replace(/\/$/, '');
const MODEL = opt('model', 'claude-opus-5');
const SPLIT = opt('split', 'test');
const LIMIT = parseInt(opt('limit', '0'), 10) || 0;
const CONCURRENCY = Math.max(1, parseInt(opt('concurrency', '3'), 10) || 3);
const LABEL = opt('label', '');
const OUT_DIR = path.join(__dirname, 'evals');
const HISTORY = path.join(OUT_DIR, 'history.json');

const FIELDS = ['artist', 'style', 'period', 'medium', 'country', 'location'];

// ── helpers (exported for tests) ────────────────────────────────────────────
function hashId(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
const isTest = id => hashId(id) % 5 === 0;                       // ~20% held out

function norm(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\bc\.(?=\s|$)/g, 'century').replace(/[^a-z0-9]+/g, ' ').trim();
}
const tokens = v => new Set(norm(v).split(' ').filter(t => t.length > 1 && !['the', 'of', 'and', 'art'].includes(t)));
// location: compare the venue (text before the first comma)
const venue = v => norm(String(v ?? '').split(',')[0]);

// → { exact: bool, close: bool }
function scoreField(field, ai, human) {
  if (field === 'location') { const a = venue(ai), h = venue(human); const m = !!a && a === h; return { exact: m, close: m || (!!a && !!h && (a.includes(h) || h.includes(a))) }; }
  const a = norm(ai), h = norm(human);
  if (!h) return null;                                           // nothing to compare against
  if (a === h) return { exact: true, close: true };
  const ta = tokens(ai), th = tokens(human);
  if (!ta.size || !th.size) return { exact: false, close: false };
  const inter = [...ta].filter(t => th.has(t)).length;
  if (field === 'artist') {
    // "Van Gogh" ≈ "Vincent van Gogh", but "the Elder" ≠ "the Younger"
    const suffixes = ['elder', 'younger', 'jr', 'sr'];
    const conflict = suffixes.some(x => ta.has(x) !== th.has(x));
    return { exact: false, close: !conflict && inter === Math.min(ta.size, th.size) };
  }
  const jac = inter / (ta.size + th.size - inter);
  return { exact: false, close: jac > 0.5 };
}

function scorePhoto(ai, human) {
  const out = {};
  for (const f of FIELDS) { const s = scoreField(f, ai[f], human[f]); if (s) out[f] = s; }
  return out;
}

function summarise(results) {
  const sum = {};
  for (const f of FIELDS) {
    const rs = results.map(r => r.scores[f]).filter(Boolean);
    sum[f] = { n: rs.length, exact: rs.length ? rs.filter(r => r.exact).length / rs.length : null,
                              close: rs.length ? rs.filter(r => r.close).length / rs.length : null };
  }
  return sum;
}

function extractJson(text) {
  const s = text.indexOf('{'); if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return text.slice(s, i + 1);
  }
  return null;
}

// Mirror of the site's cleanup so eval compares like with like
function cleanArtist(a) {
  let s = String(a || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+[—–-]\s+.*$/, '').replace(/\?/g, '').trim();
  return s || 'Unknown Artist';
}

const pct = v => v == null ? '  — ' : (Math.round(v * 1000) / 10).toFixed(1).padStart(5) + '%';

// ── history viewer ──────────────────────────────────────────────────────────
function showHistory() {
  if (!fs.existsSync(HISTORY)) { console.log('No eval runs yet.'); return; }
  const h = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  console.log('date                 prompt  model         split  n    ' + FIELDS.map(f => f.padEnd(8)).join(' '));
  for (const r of h) {
    console.log(`${r.date.slice(0, 19).replace('T', ' ')}  ${String(r.promptVersion).padEnd(6)}  ${r.model.padEnd(12)}  ${r.split.padEnd(5)}  ${String(r.n).padEnd(4)} ` +
      FIELDS.map(f => pct(r.summary[f]?.exact).padEnd(8)).join(' ') + (r.label ? '  ' + r.label : ''));
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function analyse(row, imgB64, key) {
  const gps = row.location_source === 'gps' && row.gps_lat != null && row.gps_lng != null ? [row.gps_lat, row.gps_lng] : null;
  const body = {
    model: MODEL, max_tokens: 2048, system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgB64 } },
      { type: 'text', text: buildUserPrompt(gps, null) }
    ] }]
  };
  if (MODEL === 'claude-opus-5') body.thinking = { type: 'disabled' };   // same as production
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const j = extractJson(text);
    if (!j) continue;
    try { const p = JSON.parse(j); p.artist = cleanArtist(p.artist); return { parsed: p, usage: data.usage || {} }; } catch (_) { /* retry */ }
  }
  throw new Error('no parsable reply');
}

async function main() {
  if (flag('history')) return showHistory();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.error('Set ANTHROPIC_API_KEY (or use --history).'); process.exit(1); }

  console.log(`Loading photos from ${API} …`);
  const all = await getJson(`${API}/api/photos`);
  let gold = all.filter(r => r.verified && r.has_image);
  const total = gold.length;
  if (SPLIT === 'test') gold = gold.filter(r => isTest(r.id));
  else if (SPLIT === 'train') gold = gold.filter(r => !isTest(r.id));
  if (LIMIT) gold = gold.slice(0, LIMIT);
  console.log(`${total} verified photos; evaluating ${gold.length} (${SPLIT} split) with ${MODEL}, prompt ${PROMPT_VERSION}`);
  if (gold.length < 10) console.log('⚠ Fewer than 10 photos — scores will be noisy. Verify more photos (aim for 100+; test split is ~20% of them).');
  if (!gold.length) return;

  const results = []; let done = 0, tokensIn = 0, tokensOut = 0, failed = 0;
  const queue = [...gold];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      try {
        const img = Buffer.from(await (await fetch(`${API}/api/photos/${row.id}/thumb?v=${row.img_v}`)).arrayBuffer()).toString('base64');
        const { parsed, usage } = await analyse(row, img, key);
        tokensIn += usage.input_tokens || 0; tokensOut += usage.output_tokens || 0;
        const human = { artist: row.artist, style: row.style, period: row.period, medium: row.medium, country: row.country, location: row.location };
        results.push({ id: row.id, ai: parsed, human, scores: scorePhoto(parsed, human) });
      } catch (e) { failed++; console.warn(`  ✗ ${row.id}: ${e.message}`); }
      process.stdout.write(`\r  ${++done}/${gold.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');

  const summary = summarise(results);
  console.log('\nField      exact   close   (n)');
  for (const f of FIELDS) console.log(`${f.padEnd(9)} ${pct(summary[f].exact)} ${pct(summary[f].close)}   (${summary[f].n})`);
  const cost = (tokensIn * 5 + tokensOut * 25) / 1e6;
  console.log(`\nTokens: ${tokensIn} in / ${tokensOut} out  (~$${cost.toFixed(2)} at Opus 5 list price)${failed ? `  · ${failed} failed` : ''}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const date = new Date().toISOString();
  const run = { date, promptVersion: PROMPT_VERSION, model: MODEL, split: SPLIT, n: results.length, label: LABEL, summary };
  const hist = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, 'utf8')) : [];
  hist.push(run);
  fs.writeFileSync(HISTORY, JSON.stringify(hist, null, 2));
  const detail = path.join(OUT_DIR, `run-${date.replace(/[:.]/g, '-')}-${PROMPT_VERSION}.json`);
  fs.writeFileSync(detail, JSON.stringify({ ...run, results }, null, 2));
  console.log(`Saved ${path.relative(__dirname, detail)} and updated evals/history.json`);
  console.log('Compare runs with: node eval.js --history');
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { hashId, isTest, norm, scoreField, scorePhoto, summarise };

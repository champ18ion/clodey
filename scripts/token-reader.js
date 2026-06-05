const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const HEADERS_FILE = path.join(CLAUDE_DIR, 'last-response-headers.json');
const STATE_FILE   = path.join(CLAUDE_DIR, 'clodey-state.json');

const CONTEXT_WINDOW = 200000;

function parseJSON(raw) {
  return JSON.parse(raw.replace(/^﻿/, ''));
}

// ── Rate-limit (subscription window) ─────────────────────────────────────────
// Cached by rate-fetcher.js from API response headers.
// Matches what the web UI shows — 5h/7d billing window.
function readRateLimit() {
  const raw = fs.readFileSync(HEADERS_FILE, 'utf8');
  const h   = parseJSON(raw);

  if (h.source === 'unified') {
    const pct              = Math.min(100, Math.round(h.utilization * 100));
    const resetEpoch       = h.resetEpoch || 0;
    const minsLeft         = resetEpoch ? Math.max(0, Math.round((resetEpoch * 1000 - Date.now()) / 60000)) : null;
    const sessionStartPct  = h.sessionStartUtilization !== undefined ? Math.round(h.sessionStartUtilization * 100) : null;
    const sessionDeltaPct  = sessionStartPct !== null ? Math.max(0, pct - sessionStartPct) : null;
    return { pct, resetAt: h.resetAt, minsLeft, windowLabel: h.windowLabel, sessionStartPct, sessionDeltaPct };
  }
  if (h.source === 'ratelimit' && h.limit) {
    const pct = Math.round((1 - h.remaining / h.limit) * 100);
    return { pct, remaining: h.remaining, limit: h.limit, resetAt: h.resetAt, minsLeft: null, windowLabel: 'rate-limit' };
  }
  throw new Error('unrecognised format');
}

// ── Session context usage (from transcript) ───────────────────────────────────
// Reads the LAST usage entry — represents what's currently in Claude's context.
// Separate from rate-limit; shown alongside it in status.
function readSession(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8')
    .replace(/^﻿/, '')
    .split('\n')
    .filter(Boolean);

  let lastUsage = null;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const u = (entry.message && entry.message.usage) || entry.usage;
      if (u && (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined)) {
        lastUsage = u;
      }
    } catch (_) {}
  }
  if (!lastUsage) return null;

  const cacheRead     = lastUsage.cache_read_input_tokens     || 0;
  const cacheCreation = lastUsage.cache_creation_input_tokens || 0;
  const newInput      = lastUsage.input_tokens                || 0;
  const output        = lastUsage.output_tokens               || 0;
  const contextUsed   = cacheRead + cacheCreation + newInput + output;
  const contextPct    = Math.min(100, Math.round((contextUsed / CONTEXT_WINDOW) * 100));

  return { contextUsed, contextPct, cacheRead, cacheCreation, newInput, output };
}

function cacheTokens(tokens) {
  try {
    let state = {};
    try { state = parseJSON(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
    state.tokens = tokens;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {}
}

function getTokens(transcriptPath) {
  let rateLimit = null;
  let session   = null;

  try { rateLimit = readRateLimit(); } catch (_) {}
  if (transcriptPath) {
    try { session = readSession(transcriptPath); } catch (_) {}
  }

  // pct drives the state machine — prefer rate-limit (matches web UI), fall back to context %
  const pct = rateLimit ? rateLimit.pct : (session ? session.contextPct : 0);

  const tokens = {
    pct,
    source:           rateLimit ? 'rate-limit' : (session ? 'context-window' : 'none'),
    windowLabel:      rateLimit ? rateLimit.windowLabel     : null,
    minsLeft:         rateLimit ? rateLimit.minsLeft        : null,
    resetAt:          rateLimit ? rateLimit.resetAt         : null,
    sessionStartPct:  rateLimit ? rateLimit.sessionStartPct : null,
    sessionDeltaPct:  rateLimit ? rateLimit.sessionDeltaPct : null,
    session,
  };

  cacheTokens(tokens);
  return tokens;
}

module.exports = { getTokens };

if (require.main === module) {
  const transcriptPath = process.argv[2] || null;
  const t = getTokens(transcriptPath);

  console.log(`\nClodey token meter`);
  console.log(`──────────────────────────────`);
  if (t.source === 'rate-limit') {
    console.log(`Plan usage    : ${t.pct}%  (${t.windowLabel})`);
    if (t.sessionDeltaPct !== null) {
      console.log(`This session  : +${t.sessionDeltaPct}%  (was ${t.sessionStartPct}% when session started)`);
    }
    if (t.minsLeft !== null) {
      const h = Math.floor(t.minsLeft / 60), m = t.minsLeft % 60;
      console.log(`Resets in     : ${h}h ${m}min`);
    }
  }
  if (t.session) {
    const s = t.session;
    console.log(`This session: ${s.contextPct}%  (${s.contextUsed.toLocaleString()} / 200,000 tokens)`);
    console.log(`  cache read : ${s.cacheRead.toLocaleString()}`);
    console.log(`  new input  : ${s.newInput.toLocaleString()}`);
    console.log(`  output     : ${s.output.toLocaleString()}`);
  }
  if (t.source === 'none') console.log('No token data available yet.');
}

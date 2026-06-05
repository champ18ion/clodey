#!/usr/bin/env node
'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, 'clodey-state.json');

const { getTokens }             = require('./token-reader');
const { transition, readState } = require('./state-machine');
const { render }                = require('./mascot');
const rateFetcher               = require('./rate-fetcher');

const MASCOT_LINES   = 11; // bubble(4) + body(6) + meter(1)
const MASCOT_COLS    = 24; // matches mascot.js grid width
const REFRESH_MS     = 10 * 60 * 1000; // re-fetch rate-limit at most every 10 min

// ── Terminal helpers ───────────────────────────────────────────────────────────

function getTTY() {
  if (process.stdout.isTTY) return process.stdout;

  try {
    const ttyPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
    const fd = fs.openSync(ttyPath, 'w');
    // Use tty.WriteStream so Node can query console dimensions directly
    const ttyMod = require('tty');
    const ws = new ttyMod.WriteStream(fd);
    if (!ws.columns || ws.columns < 20) {
      // Fallback to saved files if tty module can't read size
      ws.columns = parseInt(fs.readFileSync(CLAUDE_DIR + '/clodey-cols', 'utf8') || '80', 10);
      ws.rows    = parseInt(fs.readFileSync(CLAUDE_DIR + '/clodey-rows', 'utf8') || '24', 10);
    }
    return ws;
  } catch (_) {
    return null;
  }
}

function saveDimensions() {
  // Save from real TTY stdout, or from CONOUT$ if hook context
  const out = getTTY();
  if (!out) return;
  if (out.columns > 20) fs.writeFileSync(CLAUDE_DIR + '/clodey-cols', String(out.columns));
  if (out.rows    > 5)  fs.writeFileSync(CLAUDE_DIR + '/clodey-rows', String(out.rows));
}

// Protect bottom MASCOT_LINES+1 rows from scroll (plus 1 blank row as buffer)
function setScrollRegion(out) {
  const rows = out.rows || 24;
  const safeRows = rows - MASCOT_LINES - 1;
  if (safeRows < 5) return;
  out.write(`\x1b[1;${safeRows}r`);
}

// Draw mascot at bottom-right using cursor save/restore
function drawMascot(out, state, frame, pct, minsLeft, showBubble) {
  const cols = out.columns || 80;
  const rows = out.rows    || 24;
  if (cols < 60 || rows < MASCOT_LINES + 4) return;

  const startCol = Math.max(1, cols - MASCOT_COLS);
  const startRow = Math.max(1, rows - MASCOT_LINES);
  const lines    = render(state, frame, pct, minsLeft, showBubble);

  let buf = '\x1b[s';
  for (let i = 0; i < lines.length; i++) {
    buf += `\x1b[${startRow + i};${startCol}H\x1b[K${lines[i]}`;
  }
  buf += '\x1b[u';
  out.write(buf);
}

// Clear mascot zone
function clearMascot(out) {
  const cols = out.columns || 80;
  const rows = out.rows    || 24;
  const startCol = Math.max(1, cols - MASCOT_COLS);
  const startRow = Math.max(1, rows - MASCOT_LINES);
  let buf = '\x1b[s';
  for (let i = 0; i < MASCOT_LINES; i++) {
    buf += `\x1b[${startRow + i};${startCol}H\x1b[K`;
  }
  buf += '\x1b[u';
  out.write(buf);
}

// Check if rate-limit headers are stale (> REFRESH_MS old)
function shouldRefreshTokens() {
  try {
    const headersFile = path.join(CLAUDE_DIR, 'last-response-headers.json');
    const stat = fs.statSync(headersFile);
    return (Date.now() - stat.mtimeMs) > REFRESH_MS;
  } catch (_) {
    return true; // file missing — refresh
  }
}

// ── Daemon mode (dedicated terminal window) ───────────────────────────────────

function runDaemon() {
  const out = process.stdout;
  if (!out.isTTY) { console.error('daemon needs a TTY — run in a real terminal'); process.exit(1); }

  saveDimensions();

  const cols = out.columns || 80;
  const rows = out.rows    || 24;
  if (cols < 60 || rows < MASCOT_LINES + 4) { console.error('Terminal too small'); process.exit(1); }

  const startCol     = Math.max(1, cols - MASCOT_COLS);
  const zoneStartRow = rows - MASCOT_LINES + 1;

  out.write(`\x1b[1;${zoneStartRow - 1}r`);

  let frame = 0, blinkCycle = 0, lastState = null, bubbleExp = 0;

  function loop() {
    try {
      const sd  = readState();
      const st  = sd.mascotState || 'idle';
      const tok = sd.tokens || {};
      const pct = tok.pct || 0;
      const min = tok.minsLeft != null ? tok.minsLeft : null;

      if (st !== lastState) { bubbleExp = Date.now() + 2500; lastState = st; }
      const showBubble = Date.now() < bubbleExp;

      blinkCycle = (blinkCycle + 1) % 24;
      const f = (st === 'idle' && blinkCycle === 0) ? 2 : frame;
      const lines = render(st, f, pct, min, showBubble);

      let buf = '\x1b[s';
      for (let i = 0; i < lines.length; i++) {
        buf += `\x1b[${zoneStartRow + i};${startCol}H\x1b[K${lines[i]}`;
      }
      buf += '\x1b[u';
      out.write(buf);

      frame = (frame + 1) % 2;
    } catch (_) {}
  }

  const iv = setInterval(loop, 125);

  function cleanup() {
    clearInterval(iv);
    out.write('\x1b[r');
    let buf = '\x1b[s';
    for (let i = 0; i < MASCOT_LINES; i++) buf += `\x1b[${zoneStartRow + i};${startCol}H\x1b[K`;
    buf += '\x1b[u';
    out.write(buf);
    process.exit(0);
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT',  cleanup);
}

// ── Stdin reader ──────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { d += c; });
    process.stdin.on('end',  () => { try { resolve(JSON.parse(d.replace(/^﻿/, ''))); } catch (_) { resolve(null); } });
    process.stdin.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 300);
  });
}

// ── Hook render ───────────────────────────────────────────────────────────────

async function hookRender(signal) {
  const payload        = await readStdin();
  const transcriptPath = payload && payload.transcript_path ? payload.transcript_path : null;

  // Refresh rate-limit data if stale
  if (shouldRefreshTokens()) {
    await rateFetcher.run(true).catch(() => {});
  }

  const tokens   = getTokens(transcriptPath);
  const newState = transition(signal, tokens.pct);

  const out = getTTY();
  if (!out) return;

  // Re-assert scroll region so it survives any Claude Code terminal redraws
  setScrollRegion(out);

  const sd  = readState();
  const pct = tokens.pct;
  const min = tokens.minsLeft != null ? tokens.minsLeft : null;

  const prevState  = sd.mascotState;
  const showBubble = (newState !== prevState) || signal === 'start';

  for (let f = 0; f < 3; f++) {
    drawMascot(out, newState, f % 2, pct, min, showBubble && f < 2);
    if (f < 2) await new Promise(r => setTimeout(r, 120));
  }
}

// ── Session start ─────────────────────────────────────────────────────────────

async function startCommand() {
  saveDimensions();
  await rateFetcher.run(true).catch(() => {});
  const tokens = getTokens();
  transition('start', tokens.pct);

  const out = getTTY();
  if (!out) return;

  setScrollRegion(out);

  const pct = tokens.pct;
  const min = tokens.minsLeft != null ? tokens.minsLeft : null;

  for (let f = 0; f < 6; f++) {
    drawMascot(out, 'reset', f % 2, pct, min, f < 4);
    await new Promise(r => setTimeout(r, 120));
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

function statusCommand() {
  const t      = getTokens();
  const sd     = readState();
  const mascot = sd.mascotState || 'idle';

  let resetLine = '';
  if (t.minsLeft != null) {
    resetLine = `in ${Math.floor(t.minsLeft / 60)}h ${t.minsLeft % 60}min`;
  } else if (t.resetAt) {
    resetLine = t.resetAt;
  }

  console.log('┌─ Clodey Status ──────────────────────┐');
  console.log(`│ Plan usage  : ${String(t.pct + '%').padEnd(22)} │`);
  if (t.windowLabel)          console.log(`│ Window      : ${t.windowLabel.padEnd(22)} │`);
  if (t.sessionDeltaPct != null) console.log(`│ This session: ${String('+' + t.sessionDeltaPct + '%').padEnd(22)} │`);
  if (resetLine)              console.log(`│ Resets      : ${resetLine.padEnd(22)} │`);
  console.log(`│ Mascot      : ${mascot.padEnd(22)} │`);
  console.log('└──────────────────────────────────────┘');

  const out = getTTY();
  if (out) drawMascot(out, mascot, 0, t.pct, t.minsLeft, true);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const [,, cmd, signal] = process.argv;

if      (cmd === 'start')                   startCommand();
else if (cmd === 'daemon')                  runDaemon();
else if (cmd === 'state' && signal != null) hookRender(signal);
else if (cmd === 'status')                  statusCommand();
else { console.error('Usage: clodey.js <start|daemon|state <signal>|status>'); process.exit(1); }

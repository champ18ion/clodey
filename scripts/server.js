#!/usr/bin/env node
'use strict';

/**
 * Clodey server — runs in your terminal with real TTY access.
 * Hooks POST events here instead of rendering directly (which fails
 * because Claude Code spawns hooks without a console handle).
 *
 * Usage: node scripts/server.js
 * Then start Claude Code in the same terminal session.
 */

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const PORT_FILE    = path.join(CLAUDE_DIR, 'clodey-port');
const STATE_FILE   = path.join(CLAUDE_DIR, 'clodey-state.json');
const DEFAULT_PORT = 49152;

const { transition, readState } = require('./state-machine');
const { render }                = require('./mascot');
const rateFetcher               = require('./rate-fetcher');
const { getTokens }             = require('./token-reader');

const MASCOT_LINES = 11;
const MASCOT_COLS  = 24;
const REFRESH_MS   = 10 * 60 * 1000;

// ── Terminal ──────────────────────────────────────────────────────────────────

const out = process.stdout;

if (!out.isTTY) {
  console.error('[clodey] server must run in a real terminal (isTTY required)');
  process.exit(1);
}

function setScrollRegion() {
  const rows    = out.rows || 24;
  const safeRows = rows - MASCOT_LINES - 1;
  if (safeRows < 5) return;
  out.write(`\x1b[1;${safeRows}r`);
}

function drawMascot(state, frame, pct, minsLeft, showBubble) {
  const cols = out.columns || 80;
  const rows = out.rows    || 24;
  if (cols < 60 || rows < MASCOT_LINES + 4) return;

  const startCol = Math.max(1, cols - MASCOT_COLS);
  const startRow = rows - MASCOT_LINES;
  const lines    = render(state, frame, pct, minsLeft, showBubble);

  let buf = '\x1b[s';
  for (let i = 0; i < lines.length; i++) {
    buf += `\x1b[${startRow + i};${startCol}H\x1b[K${lines[i]}`;
  }
  buf += '\x1b[u';
  out.write(buf);
}

function clearMascot() {
  const cols = out.columns || 80;
  const rows = out.rows    || 24;
  const startCol = Math.max(1, cols - MASCOT_COLS);
  const startRow = rows - MASCOT_LINES;
  let buf = '\x1b[s';
  for (let i = 0; i < MASCOT_LINES; i++) {
    buf += `\x1b[${startRow + i};${startCol}H\x1b[K`;
  }
  buf += '\x1b[u';
  out.write(buf);
}

// ── Animation loop ────────────────────────────────────────────────────────────

let frame      = 0;
let blinkCycle = 0;
let bubbleExp  = 0;
let lastState  = null;

function tick() {
  try {
    const sd  = readState();
    const st  = sd.mascotState || 'idle';
    const tok = sd.tokens || {};
    const pct = tok.pct    || 0;
    const min = tok.minsLeft != null ? tok.minsLeft : null;

    if (st !== lastState) { bubbleExp = Date.now() + 2500; lastState = st; }
    const showBubble = Date.now() < bubbleExp;

    blinkCycle = (blinkCycle + 1) % 24;
    const f = (st === 'idle' && blinkCycle === 0) ? 2 : frame;

    drawMascot(st, f, pct, min, showBubble);
    frame = (frame + 1) % 2;
  } catch (_) {}
}

const animInterval = setInterval(tick, 125);

// ── Token refresh ─────────────────────────────────────────────────────────────

function tokenAge() {
  try {
    return Date.now() - fs.statSync(path.join(CLAUDE_DIR, 'last-response-headers.json')).mtimeMs;
  } catch (_) { return Infinity; }
}

async function handleEvent(signal, transcriptPath) {
  if (signal === 'idle' || signal === 'start') {
    // Refresh after every Claude response (Stop hook) — run in background, don't block
    rateFetcher.run(true).catch(() => {}).then(() => {
      // Re-read tokens after fetch completes so the meter updates
      getTokens(transcriptPath);
    });
  } else if (tokenAge() > REFRESH_MS) {
    // For other signals, only refresh if data is stale (> 10 min)
    await rateFetcher.run(true).catch(() => {});
  }

  const tokens = getTokens(transcriptPath);
  transition(signal, tokens.pct);
  bubbleExp = Date.now() + 2500;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => {
      try { resolve(JSON.parse(data.replace(/^﻿/, ''))); }
      catch (_) { resolve({}); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/hook') {
    const body = await readBody(req).catch(() => ({}));
    const signal         = body.signal || 'idle';
    const transcriptPath = body.transcript_path || null;

    await handleEvent(signal, transcriptPath).catch(() => {});

    res.writeHead(200);
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end();
});

// Find an open port starting from DEFAULT_PORT
function listen(port) {
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(PORT_FILE, String(port));
    // Save dimensions so hooks can read them if needed
    fs.writeFileSync(CLAUDE_DIR + '/clodey-cols', String(out.columns || 80));
    fs.writeFileSync(CLAUDE_DIR + '/clodey-rows', String(out.rows    || 24));

    setScrollRegion();
    tick(); // draw immediately

    out.write('\x1b[s\x1b[1;1H\x1b[2K'); // clear first line briefly for status
    out.write(`\x1b[38;2;204;120;92mclodey\x1b[0m listening on :${port} — start claude in this terminal\r\n`);
    out.write('\x1b[u');
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && port < DEFAULT_PORT + 10) {
      listen(port + 1);
    } else {
      console.error(`[clodey] server error: ${e.message}`);
      process.exit(1);
    }
  });
}

listen(DEFAULT_PORT);

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup() {
  clearInterval(animInterval);
  server.close();
  try { fs.unlinkSync(PORT_FILE); } catch (_) {}
  out.write('\x1b[r'); // restore full scroll region
  clearMascot();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT',  cleanup);
process.on('exit',    cleanup);

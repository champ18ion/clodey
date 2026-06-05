#!/usr/bin/env node
'use strict';

/**
 * Clodey server — runs detached in the background, writes mascot via CONOUT$.
 * Start with: node scripts/clodey.js serve   (returns immediately)
 * Stop with:  node scripts/clodey.js stop
 */

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const PORT_FILE    = path.join(CLAUDE_DIR, 'clodey-port');
const PID_FILE     = path.join(CLAUDE_DIR, 'clodey-server.pid');
const DEFAULT_PORT = 49152;

const { transition, readState } = require('./state-machine');
const { render }                = require('./mascot');
const rateFetcher               = require('./rate-fetcher');
const { getTokens }             = require('./token-reader');

const MASCOT_LINES = 11;
const MASCOT_COLS  = 24;
const REFRESH_MS   = 10 * 60 * 1000;

// ── Open the real console (works even as a detached background process) ────────

function openConsole() {
  try {
    if (process.stdout.isTTY) return process.stdout;
    const ttyPath = process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
    const fd = fs.openSync(ttyPath, 'w');
    const tty = require('tty');
    return new tty.WriteStream(fd);
  } catch (_) {
    return null;
  }
}

const out = openConsole();
if (!out) {
  process.stderr.write('[clodey] no console available — cannot render\n');
  process.exit(1);
}

// Save dimensions so hooks can read them
fs.writeFileSync(CLAUDE_DIR + '/clodey-cols', String(out.columns || 80));
fs.writeFileSync(CLAUDE_DIR + '/clodey-rows', String(out.rows    || 24));

// ── Rendering ─────────────────────────────────────────────────────────────────

function setScrollRegion() {
  const rows     = out.rows || 24;
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

let frame = 0, blinkCycle = 0, bubbleExp = 0, lastState = null;

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
    // After every Claude response — refresh in background, don't block
    rateFetcher.run(true).catch(() => {}).then(() => getTokens(transcriptPath));
  } else if (tokenAge() > REFRESH_MS) {
    await rateFetcher.run(true).catch(() => {});
  }

  const tokens = getTokens(transcriptPath);
  transition(signal, tokens.pct);
  bubbleExp = Date.now() + 2500;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => { try { resolve(JSON.parse(data.replace(/^﻿/, ''))); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.method === 'POST' && req.url === '/hook') {
    const body = await readBody(req);
    await handleEvent(body.signal || 'idle', body.transcript_path || null).catch(() => {});
    res.writeHead(200); res.end('ok'); return;
  }
  res.writeHead(404); res.end();
});

function listen(port) {
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(PORT_FILE, String(port));
    fs.writeFileSync(PID_FILE,  String(process.pid));
    setScrollRegion();
    tick();
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && port < DEFAULT_PORT + 10) listen(port + 1);
    else process.exit(1);
  });
}

listen(DEFAULT_PORT);

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup() {
  clearInterval(animInterval);
  server.close();
  try { fs.unlinkSync(PORT_FILE); } catch (_) {}
  try { fs.unlinkSync(PID_FILE);  } catch (_) {}
  out.write('\x1b[r');
  clearMascot();
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT',  cleanup);

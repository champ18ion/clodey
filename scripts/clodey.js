#!/usr/bin/env node
'use strict';

const fs     = require('fs');
const os     = require('os');
const http   = require('http');
const path   = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, 'clodey-state.json');
const PORT_FILE  = path.join(CLAUDE_DIR, 'clodey-port');

const { getTokens }             = require('./token-reader');
const { transition, readState } = require('./state-machine');
const { render }                = require('./mascot');
const rateFetcher               = require('./rate-fetcher');

const MASCOT_LINES = 11;
const MASCOT_COLS  = 24;

// ── Server comms ──────────────────────────────────────────────────────────────

function getPort() {
  try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10); }
  catch (_) { return null; }
}

function postToServer(port, signal, transcriptPath) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ signal, transcript_path: transcriptPath || null });
    const req  = http.request(
      { hostname: '127.0.0.1', port, path: '/hook', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve); // server not running — silent
    req.setTimeout(1000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

function serverRunning(port) {
  return new Promise(resolve => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
      res => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
    req.end();
  });
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

// ── Hook: called by every Claude Code hook event ──────────────────────────────

async function hookRender(signal) {
  const payload        = await readStdin();
  const transcriptPath = payload && payload.transcript_path ? payload.transcript_path : null;

  const port = getPort();
  if (port && await serverRunning(port)) {
    // Server is running — let it handle token refresh, transition, and rendering
    await postToServer(port, signal, transcriptPath);
  } else {
    // Fallback: update state file directly (no rendering)
    const tokens = getTokens(transcriptPath);
    transition(signal, tokens.pct);
  }
}

// ── Daemon mode (fallback for non-VS Code terminals) ──────────────────────────

function runDaemon() {
  const out = process.stdout;
  if (!out.isTTY) { console.error('daemon needs a TTY — run in a real terminal'); process.exit(1); }

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
  if (t.windowLabel)             console.log(`│ Window      : ${t.windowLabel.padEnd(22)} │`);
  if (t.sessionDeltaPct != null) console.log(`│ This session: ${String('+' + t.sessionDeltaPct + '%').padEnd(22)} │`);
  if (resetLine)                 console.log(`│ Resets      : ${resetLine.padEnd(22)} │`);
  console.log(`│ Mascot      : ${mascot.padEnd(22)} │`);
  const port = getPort();
  console.log(`│ Server      : ${port ? 'running :' + port : 'not running — run server.js'}`.padEnd(38) + ' │');
  console.log('└──────────────────────────────────────┘');
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const [,, cmd, signal] = process.argv;

if      (cmd === 'daemon')                  runDaemon();
else if (cmd === 'state' && signal != null) hookRender(signal);
else if (cmd === 'start')                   hookRender('start');
else if (cmd === 'status')                  statusCommand();
else { console.error('Usage: clodey.js <server|daemon|state <signal>|status>'); process.exit(1); }

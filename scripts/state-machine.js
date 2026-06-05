const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = path.join(os.homedir(), '.claude', 'clodey-state.json');

const STATES = ['idle', 'thinking', 'tool_run', 'success', 'fail', 'permission', 'warning', 'panic', 'reset'];

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  try {
    const current = readState();
    current.mascotState = state;
    current.updatedAt = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(current, null, 2));
  } catch (_) {}
}

function resolve(signal, pct) {
  // Priority: panic > warning (when not tool-related) > permission > thinking > success > fail > reset > idle
  if (pct >= 95) return 'panic';

  if (signal === 'permission') return 'permission';
  if (signal === 'thinking') {
    if (pct >= 80) return 'warning';
    return 'thinking';
  }
  if (signal === 'tool_run') return 'tool_run';
  if (signal === '0') return 'success';
  if (signal === 'start') return 'reset';
  if (signal === 'idle') {
    if (pct >= 80) return 'warning';
    return 'idle';
  }

  const exitCode = parseInt(signal, 10);
  if (!isNaN(exitCode) && exitCode !== 0) return 'fail';

  if (pct >= 80) return 'warning';
  return 'idle';
}

function transition(signal, pct) {
  const state = resolve(signal, pct);
  writeState(state);
  return state;
}

module.exports = { transition, readState, writeState, STATES };

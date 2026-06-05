'use strict';

// Clodey compact pixel-art renderer
// Sprite: 16×12 pixels rendered with single half-block chars.
// Mascot is smaller, cleaner, more compact, but widget width stays stable.

const RESET = '\x1b[0m';
const SPRITE_W = 16;
const SPRITE_H = 12;
const WIDGET_W = 24; // keeps old terminal box stable
const EMPTY = '.';

function hex(h) {
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function toHex(n) {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');
}

function darken(h, factor) {
  const [r, g, b] = hex(h);
  return `#${toHex(r * factor)}${toHex(g * factor)}${toHex(b * factor)}`;
}

const fg = h => {
  const [r, g, b] = hex(h);
  return `\x1b[38;2;${r};${g};${b}m`;
};

const bg = h => {
  const [r, g, b] = hex(h);
  return `\x1b[48;2;${r};${g};${b}m`;
};

const C = {
  B0: '#CC785C',
  B1: '#D4824A',
  B2: '#993C1D',
  B3: '#7B2D0E',

  EAR: '#A95843',
  BELLY: '#F2B68D',
  BLACK: '#141414',
  WHITE: '#FFFFFF',
  GOLD: '#FFD12E',
  RED: '#FF5C45',
  BLUE: '#65A7FF',
  GREEN: '#61DF6B',
  DUST: '#BCA894',
  TOOL: '#B8BCC7',
  TOOL_DARK: '#6E7582',
  METER_DIM: '#555555',
};

function bodyCol(pct) {
  if (pct >= 95) return C.B3;
  if (pct >= 80) return C.B2;
  if (pct >= 50) return C.B1;
  return C.B0;
}

function colorOf(ch, pct) {
  const body = bodyCol(pct);

  switch (ch) {
    case EMPTY: return null;
    case 'B': return body;
    case 'D': return darken(body, 0.58);
    case 'E': return C.EAR;
    case 'M': return C.BELLY;
    case 'K': return C.BLACK;
    case 'W': return C.WHITE;
    case 'Y': return C.GOLD;
    case 'R': return C.RED;
    case 'U': return C.BLUE;
    case 'G': return C.GREEN;
    case 'A': return C.DUST;
    case 'T': return C.TOOL;
    case 't': return C.TOOL_DARK;
    default: return null;
  }
}

const BASE = [
  '...YY......YY...',
  '..YEE......EEY..',
  '..EBBBBBBBBBBE..',
  '.EBBBBBBBBBBBBE.',
  '.BBBWKBBBBKWBBB.',
  '.BBBBBBBBBBBBBB.',
  '.BBBMMMKKMMMBBB.',
  '.BBBMMMWWMMMBBB.',
  '..BBMMMMMMMMBB..',
  '...BBBDDDDBBB...',
  '...DDB....BDD...',
  '....D......D....',
];

function cloneBase() {
  return BASE.map(row =>
    row.padEnd(SPRITE_W, EMPTY).slice(0, SPRITE_W).split('')
  );
}

function set(g, r, c, ch) {
  if (r >= 0 && r < SPRITE_H && c >= 0 && c < SPRITE_W) {
    g[r][c] = ch;
  }
}

function fill(g, r, c1, c2, ch) {
  for (let c = c1; c <= c2; c++) set(g, r, c, ch);
}

function shiftCols(g, dc) {
  return g.map(row => {
    const next = Array(SPRITE_W).fill(EMPTY);

    for (let c = 0; c < SPRITE_W; c++) {
      const nc = c + dc;
      if (nc >= 0 && nc < SPRITE_W) next[nc] = row[c];
    }

    return next;
  });
}

function setEyes(g, type) {
  for (const c of [3, 4, 5, 6, 9, 10, 11, 12]) set(g, 4, c, 'B');
  for (const c of [4, 5, 10, 11]) set(g, 5, c, 'B');

  if (type === 'open') {
    set(g, 4, 4, 'W');
    set(g, 4, 5, 'K');
    set(g, 4, 10, 'K');
    set(g, 4, 11, 'W');
  }

  if (type === 'blink') {
    fill(g, 5, 4, 5, 'K');
    fill(g, 5, 10, 11, 'K');
  }

  if (type === 'happy') {
    fill(g, 4, 4, 5, 'K');
    fill(g, 4, 10, 11, 'K');
  }

  if (type === 'thinking') {
    set(g, 4, 5, 'K');
    set(g, 4, 10, 'K');
    set(g, 5, 11, 'D');
    set(g, 6, 11, 'D');
  }

  if (type === 'stern') {
    set(g, 4, 4, 'K');
    set(g, 4, 6, 'K');
    set(g, 4, 9, 'K');
    set(g, 4, 11, 'K');
  }

  if (type === 'panic') {
    set(g, 4, 3, 'W');
    set(g, 4, 4, 'K');
    set(g, 4, 5, 'W');
    set(g, 4, 10, 'W');
    set(g, 4, 11, 'K');
    set(g, 4, 12, 'W');
  }
}

function setMouth(g, type) {
  fill(g, 6, 5, 10, 'M');
  fill(g, 7, 5, 10, 'M');
  fill(g, 8, 5, 10, 'M');

  if (type === 'smile') {
    fill(g, 6, 6, 9, 'K');
    set(g, 7, 7, 'W');
    set(g, 7, 8, 'W');
  }

  if (type === 'neutral') {
    fill(g, 6, 6, 9, 'K');
  }

  if (type === 'frown') {
    fill(g, 6, 7, 8, 'K');
    set(g, 7, 6, 'K');
    set(g, 7, 9, 'K');
  }

  if (type === 'open') {
    fill(g, 6, 6, 9, 'K');
    set(g, 7, 6, 'K');
    set(g, 7, 9, 'K');
    set(g, 7, 7, 'W');
    set(g, 7, 8, 'W');
    set(g, 8, 7, 'R');
    set(g, 8, 8, 'R');
  }
}

function addSparkles(g, ch = 'Y') {
  set(g, 0, 0, ch);
  set(g, 1, 15, ch);
  set(g, 3, 15, ch);
  set(g, 9, 1, ch);
}

function addWarningMark(g) {
  set(g, 0, 14, 'R');
  set(g, 1, 14, 'R');
  set(g, 2, 14, 'R');
  set(g, 4, 14, 'R');
}

function addSweat(g) {
  set(g, 1, 1, 'U');
  set(g, 2, 0, 'U');
  set(g, 3, 1, 'U');
}

function addTool(g, frame) {
  set(g, 3, 15, 'T');
  set(g, 4, 14, 'T');
  set(g, 4, 15, 't');
  set(g, 5, 15, 'T');
  set(g, 6, 14, 't');

  set(g, 6, 0, 'A');
  set(g, 8, 1, 'A');
  set(g, 9, 0, 'A');

  if (frame % 2) {
    set(g, 10, 3, EMPTY);
    set(g, 11, 4, 'D');
    set(g, 10, 11, 'D');
    set(g, 11, 11, EMPTY);
  }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(s) {
  return stripAnsi(s).length;
}

function centerLine(s, width = WIDGET_W) {
  const len = visibleLength(s);
  if (len >= width) return s;

  const left = Math.floor((width - len) / 2);
  const right = width - len - left;

  return ' '.repeat(left) + s + ' '.repeat(right);
}

function buildGrid(state = 'idle', frame = 0, pct = 0) {
  let g = cloneBase();

  setEyes(g, 'open');
  setMouth(g, 'smile');

  switch (state) {
    case 'idle':
      if (frame === 2) setEyes(g, 'blink');
      break;

    case 'thinking':
      setEyes(g, 'thinking');
      setMouth(g, 'neutral');
      break;

    case 'tool_run':
      addTool(g, frame);
      break;

    case 'success':
      setEyes(g, 'happy');
      setMouth(g, 'open');
      addSparkles(g, 'Y');
      break;

    case 'fail':
      setEyes(g, 'stern');
      setMouth(g, 'frown');
      if (frame === 1) g = shiftCols(g, -1);
      break;

    case 'permission':
      setEyes(g, 'thinking');
      setMouth(g, 'neutral');
      set(g, 0, 6, 'K');
      set(g, 1, 6, 'K');
      set(g, 2, 6, 'K');
      set(g, 4, 6, 'K');
      break;

    case 'warning':
      setEyes(g, 'stern');
      setMouth(g, 'frown');
      addWarningMark(g);
      break;

    case 'panic':
      setEyes(g, 'panic');
      setMouth(g, 'open');
      addSweat(g);
      if (frame === 1) g = shiftCols(g, 1);
      break;

    case 'reset':
      setEyes(g, 'happy');
      setMouth(g, 'smile');
      addSparkles(g, 'G');
      break;

    default:
      break;
  }

  return g;
}

function renderCell(top, bot, pct) {
  const topCol = colorOf(top, pct);
  const botCol = colorOf(bot, pct);

  if (!topCol && !botCol) return ' ';
  if (topCol && botCol && topCol === botCol) return fg(topCol) + '█' + RESET;
  if (topCol && botCol) return fg(topCol) + bg(botCol) + '▀' + RESET;
  if (topCol) return fg(topCol) + '▀' + RESET;

  return fg(botCol) + '▄' + RESET;
}

function renderGrid(grid, pct) {
  const out = [];

  for (let r = 0; r < SPRITE_H; r += 2) {
    let line = '';

    for (let c = 0; c < SPRITE_W; c++) {
      line += renderCell(
        grid[r]?.[c] || EMPTY,
        grid[r + 1]?.[c] || EMPTY,
        pct
      );
    }

    out.push(line);
  }

  return out;
}

function renderMeter(pct, minsLeft) {
  const BAR_W = 8;
  const safePct = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.max(
    0,
    Math.min(BAR_W, Math.round((safePct / 100) * BAR_W))
  );

  const mCol =
    safePct >= 80 ? C.RED :
    safePct >= 50 ? '#FFAA33' :
    '#55CC77';

  let label = ` ${safePct}%`;

  if (minsLeft != null) {
    const h = Math.floor(minsLeft / 60);
    const m = String(minsLeft % 60).padStart(2, '0');
    label += ` ↺${h}:${m}`;
  }

  return (
    fg(mCol) + '▕' + '█'.repeat(filled) + RESET +
    fg(C.METER_DIM) + '░'.repeat(BAR_W - filled) + RESET +
    fg(mCol) + '▏' + RESET +
    label
  );
}

const BUBBLES = {
  idle: 'ready ✦',
  thinking: 'hmm...',
  tool_run: 'on it!',
  success: 'done! ✓',
  fail: 'oof...',
  permission: 'approve?',
  warning: 'getting full',
  panic: 'almost out!!',
  reset: 'fresh start!',
};

function makeBubble(text) {
  const inner = ` ${text} `;
  const w = inner.length;
  const stem = Math.floor(w / 2);

  return [
    '╭' + '─'.repeat(w) + '╮',
    '│' + inner + '│',
    '╰' + '─'.repeat(stem) + '┬' + '─'.repeat(w - stem - 1) + '╯',
    ' '.repeat(stem + 1) + '│',
  ];
}

function render(state, frame = 0, pct = 0, minsLeft = null, showBubble = true) {
  const grid = buildGrid(state, frame, pct);
  const body = renderGrid(grid, pct).map(line => centerLine(line));
  const meter = centerLine(renderMeter(pct, minsLeft));
  const lines = [];

  if (showBubble) {
    const bubble = makeBubble(BUBBLES[state] || state);
    for (const line of bubble) lines.push(centerLine(line));
  } else {
    for (let i = 0; i < 4; i++) {
      lines.push(' '.repeat(WIDGET_W));
    }
  }

  lines.push(...body);
  lines.push(meter);

  return lines;
}

module.exports = {
  render,
  BUBBLES,
  bodyCol,
};
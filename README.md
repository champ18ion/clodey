# clodey

Floating pixel-art mascot for Claude Code. Reacts in real time to your session state and token usage.

```
  ╭──────────╮
  │ ready ✦  │
  ╰────┬─────╯
       │
  ░░████████░░
  ░██▓▓▓▓▓▓██░
  ██▓▓▓▓▓▓▓███
  ██▓░▓▓░▓▓▓██   ← Clodey
  ██▓▒▒▒▒▒▓▓██
  ░████████░░░
  ░░░██░░██░░░
  ▕████░░░░░░▏ 26% ↺4:07
```

## Install

```
/plugin marketplace add champ18ion/clodey
/plugin install clodey@clodey
```

## Usage

Clodey runs as a live mascot in a side terminal window. Open a second terminal and run:

```bash
node scripts/clodey.js daemon
```

Keep that window visible alongside your Claude Code terminal. The mascot reacts automatically as Claude works — no extra setup needed. Hooks fire from within Claude Code, update the shared state file, and the daemon renders the changes instantly.

For a quick status check without the daemon, run inside Claude Code:

```
! node scripts/clodey.js status
```

Or use the skill: `/clodey-status`

## States

| State | Trigger | Says |
|---|---|---|
| `idle` | Waiting for input | "ready ✦" |
| `thinking` | PreToolUse fires | "hmm..." |
| `success` | Tool exit 0 | "done! ✓" |
| `fail` | Tool non-zero exit | "oof..." |
| `permission` | Permission prompt | "approve?" |
| `warning` | tokens > 80% | "getting full" |
| `panic` | tokens > 95% | "almost out!!" |
| `reset` | Session starts | "fresh start!" |

## Token tracking

Clodey reads `anthropic-ratelimit-unified-*` response headers — the same source as the Claude.ai web UI usage bar. It shows:

- **Plan usage %** — your 5-hour or 7-day window utilization
- **This session +%** — how much of the limit was used since this session started
- **Resets in** — countdown to window reset

Token data refreshes automatically every 10 minutes via hooks. Between refreshes, the daemon shows the last known value.

## Known limitations

- The pixel mascot requires a dedicated terminal with truecolor ANSI support and ≥ 80 columns. Claude Code's subprocess context cannot access the console directly (Windows limitation), so the daemon must run in a separate window.
- Token tracking is single-machine only.

## License

MIT

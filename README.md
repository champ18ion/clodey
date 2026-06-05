# clodey

Floating pixel-art mascot for Claude Code. Reacts in real time to your session state and token usage.

```
  ╭──────────╮
  │ ready ✦  │
  ╰────┬─────╯
       │
  ░░████████░░
  ░██░░░░░░██░
  ██░░░░░░░███
  ██░▓░░▓░░░██   ← Clodey
  ██░░░░░░░░██
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

Start the Clodey server **before** launching Claude Code in the same terminal:

```bash
node ~/.claude/plugins/clodey/scripts/server.js
```

That's it. The server locks the bottom rows of your terminal, renders the mascot, and listens for hook events. Then start Claude Code in the same terminal — the mascot appears automatically and reacts as Claude works.

**Check status anytime:**
```
! node ~/.claude/plugins/clodey/scripts/clodey.js status
```

Or use the skill: `/clodey-status`

**Without the server** (fallback): Clodey still tracks state in `~/.claude/clodey-state.json`. Run the daemon in a side terminal to see it:
```bash
node ~/.claude/plugins/clodey/scripts/clodey.js daemon
```

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

Clodey reads `anthropic-ratelimit-unified-*` headers — the same source as the Claude.ai web UI usage bar:

- **Plan usage %** — 5-hour or 7-day window utilization
- **This session +%** — usage added since this session started  
- **Resets in** — countdown to window reset

Tokens refresh every 10 minutes automatically.

## How it works

Claude Code spawns hooks as pipe subprocesses with no console handle — they can't render to your terminal directly. Clodey's server runs **in your terminal** with real TTY access. Hooks fire → POST event to `localhost:49152` → server renders mascot in the protected scroll zone. Zero extra windows.

## License

MIT

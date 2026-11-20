# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, `stalled`, or `running`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
pi install git:github.com/E-JM/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)
- [herdr](https://herdr.dev)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
herdr                 # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm|herdr` to force a specific backend.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, tmux, herdr). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. On herdr and tmux, the main agent's pane keeps a fixed share of the tab width on the left (default 40%, tunable with `PI_SUBAGENT_HERDR_PARENT_RATIO` / `PI_SUBAGENT_TMUX_PARENT_RATIO`), and every subagent gets a pane to the right. Each split is labeled with the subagent name, and herdr detects the child agent and shows its live status. Because herdr's `pane read` cannot see the transcript of fullscreen (alt-screen) background panes, Pi-backed subagents on herdr launch with `--tui-mode regular` so their output stays readable for completion detection. Note: the `interactive` option controls parent status notifications, not terminal focus.

#### Pane layouts (herdr & tmux)

Two layouts control how subagent panes fill the space to the right of the main agent:

- **`columns`** (default) — every subagent gets a full-height column; new subagents split the rightmost subagent pane, and all columns are rebalanced to equal width whenever one spawns or closes.
- **`tiled`** — subagents fill a block grid (1×1 → 1×2 → 2×2 → 2×3 → 3×3 → 3×4 …). Each new subagent is carved out of the pane covering the next grid cell, and the grid is rebalanced so cells stay as equal as the layout allows.

Switch layouts with the **`/subagent-layout`** command: with no arguments it opens an interactive picker (current choice preselected, Esc cancels), or pass `columns` / `tiled` explicitly — both offer argument completion in the editor. The choice persists across restarts and applies to newly spawned subagents; existing panes keep their geometry until the next spawn or close. You can also set the default with the `PI_SUBAGENT_LAYOUT=columns|tiled` environment variable — a persisted `/subagent-layout` choice wins over the env var.

cmux, zellij, and WezTerm keep their own layout behavior regardless of this setting.

## What's Included

### Extensions

**Subagents** — 5 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagent_message`   | Message a live subagent (typed into its pane) or resume an ended session (async)            |
| `subagent_close`     | Close a running subagent's pane and finish its session                                      |
| `subagents_list`     | List available agent definitions                                                            |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Haiku                  | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sonnet                 | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Opus (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sonnet                 | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### Waiting-delivery for autonomous subagents

Autonomous (non-interactive) Pi-backed subagents keep their pane alive after a run finishes. These spawns are told to simply end their turn with a summary (delivery is automatic), and if a child still sits idle in its `waiting`/`done` phase for `completion.steerDebounceMs` (default 3s) without exiting — e.g. an agent that ignores those instructions or was interrupted mid-flow — the parent steers the run's closing message back instead of waiting forever for process exit:

> Sub-agent "Worker" finished its run (2m 14s) — pane kept alive for follow-ups.

The parent can then keep the conversation going live with `subagent_message` (the message is typed straight into the child's pane) and finish with `subagent_close` when done. After `completion.idleCloseMs` (default 10 minutes, `0` disables) of delivered-and-idle time, the pane is closed automatically. Each idle episode steers at most once; a follow-up message starts a new episode whose result is delivered when the child goes idle again.

Auto-exit agents are unaffected: they exit within ~1s of finishing, so the normal exit path always wins. Interactive spawns (planner, `/iterate` forks) never enter this lane — the user drives those panes directly.

### In-progress status updates

The widget tracks each Pi-backed sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy
- `running` — fallback for backends without child snapshots (e.g. Claude)

These labels are no longer derived from session-file growth. Session JSONL is still used for transcript, resume, lineage, and result extraction, but Pi-backed liveness now comes from a small activity snapshot written by the child extension. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and child snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

Status display and completion delivery are controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  },
  "completion": {
    "steerDebounceMs": 3000,
    "idleCloseMs": 600000
  }
}
```

- `status.enabled` — show the live status widget and steer `stalled`/`recovered` transitions.
- `completion.steerDebounceMs` — how long an autonomous subagent must sit idle after finishing a run before its closing message is steered to the parent (default `3000`, minimum `1`). There is no disable switch for the lane itself — spawns that should never be waiting-delivered should be interactive (default for user-driven agents) or auto-exit.
- `completion.idleCloseMs` — how long a delivered run may stay idle before its pane is closed automatically (default `600000` = 10 minutes; `0` disables idle auto-close). Applies only to autonomous spawns whose result was already delivered.

Completion supervision runs even with the status widget disabled. `config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | —              | Override agent's default model                                                                    |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately moves the child back to `waiting`, and stale pre-interrupt snapshots are ignored. If the child starts work later, newer snapshots return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session. Interrupted runs are excluded from waiting-delivery and idle auto-close — the pane stays alive for the user.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## Messaging a subagent (live or ended)

`subagent_message` is the single entry point for follow-ups:

```typescript
// Live subagent — the message is typed into its pane, like a user typing.
// Works while the child is mid-run too (pi queues input); no busy-gating.
subagent_message({ name: "Scout", message: "Also check the auth middleware" });
subagent_message({ id: "abcd1234", message: "Focus on the failing test" });

// Ended session — resumes it in a new pane with the message as follow-up
// (fire-and-forget: the result arrives later as a steer message).
subagent_message({
  sessionFile: "/home/…/sessions/…/2026-…jsonl",
  message: "One more pass on the edge cases",
});
```

**`subagent_message` parameters:**
- `message` (required): The message to deliver
- `name` (optional): Display name of a live subagent (also used as tab label on resume)
- `id` (optional): Live subagent id (from the spawn tool result details)
- `sessionFile` (optional): Session `.jsonl` path — **required when the target is not live**. Found in the result steer message details / the `Session:` line.
- `autoExit` (optional, resume path only): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` for an interactive handoff.

When a live name matches multiple running subagents, the tool returns an ambiguity error listing the candidates.

### Closing a subagent

Use `subagent_close` to close a live pane and finish its session — e.g. after following up on a waiting-delivery result, or to clean up a subagent that is no longer needed:

```typescript
subagent_close({ name: "Scout" });
subagent_close({ id: "abcd1234" });
```

If the run's result was not already delivered (waiting-delivery lane), it still arrives as an automatic steer message when the pane closes.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_message` (with `sessionFile`).

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_message` resume parameters:**
- `sessionFile` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (required): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_message` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`. Autonomous non-auto-exit spawns (no `auto-exit`, `interactive: false`) get a third variant: end your turn with a summary — the waiting-delivery lane picks it up automatically, so they are told NOT to call `subagent_done`.
- **Credential fallback**: if the agent's model resolves to a provider with no configured credentials on the spawning machine (e.g. a hardcoded `anthropic/*` model without an Anthropic login), the launch falls back to the parent session's current model and the spawn result carries a `modelWarning` — instead of spawning a child that dies at startup with "No API key found". The agent's `thinking` level is dropped on fallback (it may not be valid on the parent's model). Claude-backed launches are exempt (the claude CLI manages its own auth).

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet. Bare spawns with no agent defs (e.g. `/iterate` with `fork: true`) are treated as interactive.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagent_message`, `subagent_close`, `subagents_list`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+Shift+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+Shift+J)              ← collapsed
[scout] — 12 available  (Ctrl+Shift+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)
  - [herdr](https://herdr.dev)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
herdr                 # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm, herdr
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---
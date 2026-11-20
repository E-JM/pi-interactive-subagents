import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import {
  DynamicBorder,
  getSelectListTheme,
  keyHint,
} from "@mariozechner/pi-coding-agent";
import {
  Box,
  Container,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import {
  type ActivityReadResult,
  getSubagentActivityFile,
  readSubagentActivityFile,
  type SubagentActivityState,
} from "./activity.ts";
import {
  closeSurface,
  createSurface,
  getMuxBackend,
  getSubagentLayoutMode,
  isMuxAvailable,
  muxSetupHint,
  pollForExit,
  readScreen,
  renameCurrentTab,
  renameWorkspace,
  type SubagentLayoutMode,
  sendCommand,
  sendEscape,
  sendLongCommand,
  setSubagentLayoutMode,
  shellEscape,
} from "./cmux.ts";
import {
  findLastAssistantIndex,
  findLastAssistantMessage,
  getNewEntries,
  type SeededSubagentSessionMode,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  loadStatusConfig,
  observeStatus,
  type StatusActivityPhase,
  type StatusSnapshot,
  type StatusSnapshotState,
  type SubagentStatusState,
} from "./status.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: closures from the previous module load keep running, so
// clear its timers and abort its poll loops (otherwise /reload leaves
// duplicate intervals and pollers behind).
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

/** Symbol-keyed store for state that must survive /reload. */
const globalStore = globalThis as Record<symbol, unknown>;

{
  const prevInterval = globalStore[WIDGET_INTERVAL_KEY] as
    | ReturnType<typeof setInterval>
    | undefined;
  if (prevInterval) {
    clearInterval(prevInterval);
    globalStore[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = globalStore[STATUS_INTERVAL_KEY] as
    | ReturnType<typeof setInterval>
    | undefined;
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    globalStore[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = globalStore[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  globalStore[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return (globalStore[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Appended to system prompt (role instructions)",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (overrides agent default)" }),
  ),
  skills: Type.Optional(
    Type.String({
      description: "Comma-separated skills (overrides agent default)",
    }),
  ),
  tools: Type.Optional(
    Type.String({
      description: "Comma-separated tools (overrides agent default)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The copied transcript file is returned as `claudeSessionId` in the subagent result details. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagent_message",
  "subagent_close",
  "subagents_list",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/**
 * Filesystem-safe name fragment for generated artifacts: lowercase,
 * hyphen-separated, stripped of special characters, with a fallback when the
 * result would be empty.
 */
function safeFileName(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

/** Timestamp fragment safe for file names, e.g. `2026-01-02T03-04-05`. */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(
  value: string | undefined,
): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills:
      getFrontmatterValue(frontmatter, "skill") ??
      getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "spawning"),
    ),
    autoExit: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "auto-exit"),
    ),
    interactive: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, "interactive"),
    ),
    sessionMode: parseSessionMode(
      getFrontmatterValue(frontmatter, "session-mode"),
    ),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(
        frontmatter,
        "disable-model-invocation",
      )?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) =>
      entry.endsWith(".md"),
    )) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
} {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd
    ? join(effectiveCwd, ".pi", "agent")
    : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

/**
 * Decide the --model string for a subagent launch when the agent's model may
 * be unusable in this environment.
 *
 * Agent definitions hardcode model ids (e.g. anthropic/claude-sonnet-4-6)
 * that can lack credentials on the spawning machine — the child pi dies at
 * startup with "No API key found for anthropic" and the run is
 * dead-on-arrival. When the requested provider has no configured auth, fall
 * back to the parent session's model and return a warning, instead of
 * spawning a subagent that can never produce a result.
 *
 * The credential probe is injected so the decision stays unit-testable.
 * Thinking suffixes are dropped on fallback: the agent's tuned level may not
 * be valid on the parent's model.
 */
export interface ModelFallbackDecision {
  model?: string;
  warning?: string;
  /** Whether the agent's `thinking` frontmatter may be appended (true unless
   * we fell back to a model whose thinking levels are unknown). */
  applyThinking: boolean;
}

export function resolveModelWithFallback(params: {
  requestedModel?: string;
  hasAuth: (provider: string, modelId: string) => boolean;
  parentModel?: string;
}): ModelFallbackDecision {
  const requested = params.requestedModel?.trim();
  if (!requested) return { applyThinking: true };
  const slash = requested.indexOf("/");
  if (slash <= 0) return { model: requested, applyThinking: true };
  const provider = requested.slice(0, slash);
  const rest = requested.slice(slash + 1);
  const colon = rest.indexOf(":");
  const modelId = colon === -1 ? rest : rest.slice(0, colon);
  if (params.hasAuth(provider, modelId)) {
    return { model: requested, applyThinking: true };
  }
  const fallback = params.parentModel?.trim();
  if (!fallback) {
    return {
      model: requested,
      applyThinking: true,
      warning:
        `Agent model "${requested}" has no configured credentials in this ` +
        `environment and no parent model is available to fall back to — the ` +
        `subagent may fail to start. Log in to the provider or override the model.`,
    };
  }
  return {
    model: fallback,
    applyThinking: false,
    warning:
      `Agent model "${requested}" has no configured credentials in this ` +
      `environment; falling back to the parent session model "${fallback}". ` +
      `Log in to the provider or configure models.json to use the agent's model.`,
  };
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: SeededSubagentSessionMode | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Human-readable message for an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();
const completionConfig = statusConfig.completion;

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText
      ? ` ${snapshot.activeDurationText}`
      : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText
      ? ` ${snapshot.waitingDurationText}`
      : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText
    ? ` ${snapshot.snapshotProblemText}`
    : "";
  return ` stalled${detail}${duration} `;
}

/**
 * Label lines shared between the subagent_result producers and the collapsing
 * renderer (which strips them off to display a clean summary). Both sides
 * derive from these helpers so the wording can never drift apart.
 */
function resultLabelCompleted(name: string, elapsedText: string): string {
  return `Sub-agent "${name}" completed (${elapsedText}).`;
}

function resultLabelFailedExit(name: string, exitCode: number): string {
  return `Sub-agent "${name}" failed (exit code ${exitCode}).`;
}

function resultLabelWaiting(name: string, elapsedText: string): string {
  return `Sub-agent "${name}" finished its run (${elapsedText}) — pane kept alive for follow-ups.`;
}

function resultLabelProviderError(name: string, elapsedText: string): string {
  return `Sub-agent "${name}" failed after ${elapsedText} (provider/agent error — auto-retry exhausted).`;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted: surface the provider/network failure instead of
    // silently treating the run as completed.
    return (
      `${resultLabelProviderError(name, formatElapsed(result.elapsed))}\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `${resultLabelFailedExit(name, result.exitCode)}\n\n${result.summary}${sessionRef}`
    : `${resultLabelCompleted(name, formatElapsed(result.elapsed))}\n\n${result.summary}${sessionRef}`;
}

/**
 * Steer a finished watcher result to the parent. Shared by the launch and
 * resume paths: pings always steer (new information); a result already
 * steered by the waiting-delivery lane for this episode is dropped;
 * everything else is rendered by resolveResultPresentation.
 *
 * `summary` overrides the watcher's summary — the resume path re-extracts it
 * from entries added since the resume, because the watcher only saw the
 * pre-existing session content.
 */
function deliverWatchResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: SubagentResult,
  opts: { summary?: string } = {},
): void {
  updateWidget();

  // A raced caller_ping must always reach the parent, even when the closing
  // text was already delivered (a ping is new information).
  if (result.ping) {
    const sessionFile = result.sessionFile ?? running.sessionFile;
    const sessionRef = `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}`;
    pi.sendMessage(
      {
        customType: "subagent_ping",
        content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
        display: true,
        details: {
          name: result.ping.name,
          message: result.ping.message,
          agent: running.agent,
          sessionFile,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return;
  }

  // Result already reached the parent via the waiting-delivery lane for this
  // episode — widget removal is enough.
  if (running.exitSteerSuppressed) return;

  const presentation = resolveResultPresentation(
    {
      ...result,
      summary: opts.summary ?? result.summary,
      sessionFile: result.sessionFile ?? running.sessionFile,
    },
    running.name,
  );

  pi.sendMessage(
    {
      customType: "subagent_result",
      content: presentation,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile ?? running.sessionFile,
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        ...(result.claudeSessionId
          ? { claudeSessionId: result.claudeSessionId }
          : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Steer a watcher failure (thrown by watchSubagent) to the parent. */
function deliverWatchError(
  pi: ExtensionAPI,
  running: RunningSubagent,
  err: unknown,
): void {
  updateWidget();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${running.name}" error: ${errorMessage(err)}`,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        error: errorMessage(err),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Filename (not a bare session id) of the copied Claude transcript under CLAUDE_SESSIONS_DIR. */
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  statusState: SubagentStatusState;
  /** Set when the launch fell back from the agent's model (no credentials). */
  modelWarning?: string;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Set once subagent_interrupt successfully delivered Escape to the pane. */
  interruptRequested?: boolean;
  /**
   * Set when pollForExit resolved: the process is exiting and results must no
   * longer be delivered via the waiting lane.
   */
  completing?: boolean;
  /**
   * Set when the result already reached the parent via the waiting-delivery
   * lane, so the pending watchSubagent completion must not steer a duplicate.
   */
  exitSteerSuppressed?: boolean;
  /** Waiting-delivery latch: closing message steered for the current episode. */
  waitingDelivered?: boolean;
  /** waitingSinceMs captured when the closing message was steered. */
  deliveredWaitingSince?: number | null;
  /** lastActivitySequence captured when the closing message was steered. */
  deliveredSequence?: number | null;
  /**
   * Index of the last assistant session entry at delivery time. A
   * re-delivery requires a NEW assistant message — session growth from user
   * entries alone (an injected or typed message waiting for the child's
   * turn) must never re-steer the old closing text.
   */
  deliveredAssistantIndex?: number;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let supervisionInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left is truncated first when both need space; right is truncated only when
 * it alone exceeds the line width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // Prefer a compact right chunk over overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`
    .slice(0, inner)
    .padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      globalStore[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui, _theme) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(
            Array.from(runningSubagents.values()),
            width,
          );
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Control tools the child needs to report back to the parent. Always added to
 * the child --tools allowlist even when the definition restricts tools.
 */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator =
    params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(
  running: RunningSubagent,
  observedAt = Date.now(),
) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  if (read.ok) {
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      },
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: read.reason,
      snapshotError: read.error,
    },
    observedAt,
  );
}

/**
 * Sanitize a message for typing into a live subagent pane: collapse all
 * whitespace runs containing newlines into single spaces (pane send is
 * line-oriented), trim, and hard-cap at 4000 chars.
 */
export function sanitizeInjectedMessage(message: string): string {
  const collapsed = message.replace(/\s*\n\s*/g, " ").trim();
  const MAX_INJECTED_MESSAGE_LENGTH = 4000;
  if (collapsed.length <= MAX_INJECTED_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_INJECTED_MESSAGE_LENGTH)}…[truncated]`;
}

/**
 * Decide whether an idle, finished autonomous subagent run should have its
 * closing message steered back to the parent right now (waiting-delivery
 * lane), without waiting for the child process to exit.
 *
 * Pure so the episode/latch rules stay unit-testable:
 * - only autonomous Pi-backed runs with a live activity snapshot qualify;
 * - the phase must be `waiting` or `done` and idle for at least
 *   `steerDebounceMs`;
 * - a delivered run is only delivered again when a NEW assistant message
 *   exists (index guard) — same-episode repeats and user-entry-only growth
 *   (an injected or typed message waiting for the child's turn) never
 *   re-steer the old closing text.
 */
export function shouldDeliverWaitingResult(
  params: {
    interactive: boolean;
    interruptRequested?: boolean;
    completing?: boolean;
    cli?: string;
    snapshotState: StatusSnapshotState;
    phase: StatusActivityPhase | null;
    waitingSinceMs: number | null;
    lastActivityAtMs: number | null;
    waitingDelivered?: boolean;
    lastAssistantIndex: number;
    deliveredAssistantIndex?: number;
  },
  config: { steerDebounceMs: number },
  now: number,
): { deliver: true; idleMs: number } | { deliver: false } {
  if (params.cli === "claude") return { deliver: false };
  if (params.interactive) return { deliver: false };
  if (params.interruptRequested) return { deliver: false };
  if (params.completing) return { deliver: false };
  if (params.snapshotState !== "present") return { deliver: false };
  if (params.phase !== "waiting" && params.phase !== "done") {
    return { deliver: false };
  }

  const referenceMs = params.waitingSinceMs ?? params.lastActivityAtMs;
  if (referenceMs == null) return { deliver: false };
  const idleMs = Math.max(0, now - referenceMs);
  if (idleMs < config.steerDebounceMs) return { deliver: false };

  if (params.waitingDelivered) {
    // The index guard subsumes the same-episode latch: a re-delivery needs a
    // new assistant entry, which only a genuinely new run produces. Growth
    // from user entries alone must not re-steer the previous closing text.
    if (params.lastAssistantIndex <= (params.deliveredAssistantIndex ?? -1)) {
      return { deliver: false };
    }
  }

  return { deliver: true, idleMs };
}

/**
 * Decide whether a delivered, still-idle autonomous subagent run should be
 * closed (pane kept alive long enough — close it). Pure/unit-testable:
 * requires the waiting-delivery lane to have fired for the SAME idle episode
 * (`deliveredWaitingSince === waitingSinceMs`) and never fires for
 * interactive or interrupted runs. `idleCloseMs: 0` disables auto-close.
 */
export function shouldIdleClose(
  params: {
    interactive: boolean;
    interruptRequested?: boolean;
    waitingDelivered?: boolean;
    idleMs: number;
    deliveredWaitingSince?: number | null;
    waitingSinceMs: number | null;
  },
  config: { idleCloseMs: number },
): boolean {
  if (config.idleCloseMs <= 0) return false;
  if (params.interactive) return false;
  if (params.interruptRequested) return false;
  if (!params.waitingDelivered) return false;
  if (params.deliveredWaitingSince !== params.waitingSinceMs) return false;
  return params.idleMs >= config.idleCloseMs;
}

/**
 * Match a live subagent by id or exact display name — no no-match error:
 * the subagent_message resume path falls through to a resume when nothing
 * matches. `ambiguous` carries the ready-to-use ambiguity error text.
 */
function matchLiveTarget(
  id?: string,
  name?: string,
): { running: RunningSubagent | null } | { ambiguous: string } {
  const requestedId = id?.trim();
  if (requestedId) {
    return { running: runningSubagents.get(requestedId) ?? null };
  }

  const requestedName = name?.trim();
  if (!requestedName) return { running: null };

  const matches = Array.from(runningSubagents.values()).filter(
    (candidate) => candidate.name === requestedName,
  );
  if (matches.length <= 1) return { running: matches[0] ?? null };

  const candidates = matches
    .map((candidate) => `${candidate.name} [${candidate.id}]`)
    .join(", ");
  return {
    ambiguous: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
  };
}

function resolveRunningTarget(params: {
  id?: string;
  name?: string;
}): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim();
  const requestedName = params.name?.trim();
  if (!requestedId && !requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const match = matchLiveTarget(requestedId, requestedName);
  if ("ambiguous" in match) return { error: match.ambiguous };
  if (match.running) return { running: match.running };

  return requestedId
    ? { error: `No running subagent with id "${requestedId}".` }
    : { error: `No running subagent named "${requestedName}".` };
}

/** One-line summary of currently running subagents, for tool error results. */
function formatRunningSubagents(): string {
  const entries = Array.from(runningSubagents.values());
  if (entries.length === 0) return "No subagents are currently running.";
  return entries
    .map((running) => {
      const cliTag = running.cli === "claude" ? " (claude)" : "";
      return `• ${running.name} [${running.id}]${cliTag}`;
    })
    .join("\n");
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${errorMessage(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveRunningTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
        },
      ],
      details: {
        error: "claude interrupt unsupported",
        id: running.id,
        name: running.name,
      },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: {
        error: interruption.error,
        id: running.id,
        name: running.name,
      },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  // Interrupted runs never enter the waiting-delivery or idle-close lanes —
  // the user took over the pane (documented "pane stays alive" semantics).
  running.interruptRequested = true;
  updateWidget();

  return {
    content: [
      {
        type: "text" as const,
        text: `Interrupt requested for subagent "${running.name}".`,
      },
    ],
    details: {
      id: running.id,
      name: running.name,
      status: "interrupt_requested",
    },
  };
}

/**
 * Close a running subagent's pane and finish its session.
 *
 * Pi-backed runs: write the `.exit` sidecar (with the close reason) so
 * pollForExit finishes normally on its next tick, then close the pane.
 * Claude-backed runs: touch the sentinel file (empty summary) so the plugin
 * sentinel path in pollForExit fires, then close the pane.
 *
 * When the waiting-delivery lane already steered this episode's result to the
 * parent, mark the run exitSteerSuppressed so the pending watchSubagent
 * completion does not steer a duplicate result.
 */
function closeRunningSubagent(running: RunningSubagent, reason: string): void {
  // Stop the waiting lane immediately: the watcher finishes via the sidecar
  // within one poll tick, but a supervision tick landing in that window must
  // not deliver (or close) again.
  running.completing = true;
  // Refresh the snapshot so the suppression decision below uses the latest
  // episode state, not one that is up to a supervision tick stale.
  observeRunningSubagent(running);
  if (
    running.waitingDelivered === true &&
    running.deliveredWaitingSince === running.statusState.waitingSinceMs
  ) {
    running.exitSteerSuppressed = true;
  }

  if (running.cli === "claude") {
    if (running.sentinelFile) {
      try {
        writeFileSync(running.sentinelFile, "");
      } catch {
        // Best effort — the screen sentinel may still fire in pollForExit.
      }
    }
  } else {
    try {
      writeFileSync(
        `${running.sessionFile}.exit`,
        JSON.stringify({ type: "done", reason }),
      );
    } catch {
      // Best effort — the screen sentinel may still fire in pollForExit.
    }
  }

  // Pane may already be gone; pollForExit still observes the sidecar.
  closeSurfaceSafe(running.surface);
}

/**
 * Waiting-delivery + idle auto-close supervision for one running subagent.
 * Called from the 1s supervision interval for every running entry, independent
 * of the status widget config.
 */
function superviseRunCompletion(
  pi: ExtensionAPI,
  running: RunningSubagent,
  now: number,
): void {
  if (running.cli === "claude") return;
  if (running.interactive) return;
  if (running.interruptRequested) return;
  if (running.completing) return;

  const state = running.statusState;
  // Only terminal phases can deliver; skip the session-file read while the
  // child is active/starting.
  if (state.phase !== "waiting" && state.phase !== "done") return;
  const referenceMs = state.waitingSinceMs ?? state.lastActivityAtMs;
  if (referenceMs == null) return;
  const idleMs = Math.max(0, now - referenceMs);

  const maybeIdleClose = () => {
    if (
      !running.exitSteerSuppressed &&
      shouldIdleClose(
        {
          interactive: running.interactive,
          interruptRequested: running.interruptRequested,
          waitingDelivered: running.waitingDelivered,
          idleMs,
          deliveredWaitingSince: running.deliveredWaitingSince,
          waitingSinceMs: state.waitingSinceMs,
        },
        { idleCloseMs: completionConfig.idleCloseMs },
      )
    ) {
      closeRunningSubagent(running, "idle-close");
    }
  };

  // Perf: a delivered run with no new activity since its delivery snapshot
  // cannot deliver anything new (the index guard would block it) — skip the
  // session-file read. Only idle-close remains, computed from snapshot state.
  if (
    running.waitingDelivered === true &&
    state.lastActivitySequence != null &&
    state.lastActivitySequence === running.deliveredSequence
  ) {
    maybeIdleClose();
    return;
  }

  // Read the session file once per candidate tick: the last assistant entry
  // index feeds the growth guard and its text becomes the closing summary.
  // Unreadable file → skip this tick.
  let summary: string;
  let lastAssistantIndex: number;
  try {
    const entries = getNewEntries(running.sessionFile, 0);
    lastAssistantIndex = findLastAssistantIndex(entries);
    summary =
      findLastAssistantMessage(entries) ??
      "(finished without a closing message)";
  } catch {
    return;
  }

  const decision = shouldDeliverWaitingResult(
    {
      interactive: running.interactive,
      interruptRequested: running.interruptRequested,
      completing: running.completing,
      cli: running.cli,
      snapshotState: state.snapshotState,
      phase: state.phase,
      waitingSinceMs: state.waitingSinceMs,
      lastActivityAtMs: state.lastActivityAtMs,
      waitingDelivered: running.waitingDelivered,
      lastAssistantIndex,
      deliveredAssistantIndex: running.deliveredAssistantIndex,
    },
    { steerDebounceMs: completionConfig.steerDebounceMs },
    now,
  );

  if (decision.deliver) {
    const elapsed = Math.floor((now - running.startTime) / 1000);
    pi.sendMessage(
      {
        customType: "subagent_result",
        content:
          `${resultLabelWaiting(running.name, formatElapsed(elapsed))}\n\n` +
          `${summary}\n\n` +
          `Session: ${running.sessionFile}\n` +
          `Reply live with subagent_message (name: "${running.name}"); close with subagent_close when done.`,
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          deliveredVia: "waiting",
          sessionFile: running.sessionFile,
          elapsed,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );

    running.waitingDelivered = true;
    running.deliveredWaitingSince = state.waitingSinceMs;
    running.deliveredSequence = state.lastActivitySequence;
    running.deliveredAssistantIndex = lastAssistantIndex;
    // The closing message reached the parent: if the exit lane fires later
    // for this same content (manual pane quit, slow exit), it must not steer
    // a duplicate. A live subagent_message follow-up re-arms the exit lane.
    running.exitSteerSuppressed = true;
  }

  maybeIdleClose();
}

/**
 * 1s supervision loop for all running subagents: status-widget refresh and
 * stalled/recovered steering when the widget is enabled, plus waiting-delivery
 * and idle auto-close completion supervision always (they run even when the
 * status widget config is disabled).
 */
function startSupervisionLoop(pi: ExtensionAPI) {
  if (supervisionInterval) return;

  supervisionInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (supervisionInterval) {
        clearInterval(supervisionInterval);
        supervisionInterval = null;
        globalStore[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(
        running.statusState,
        now,
      );
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents don't wake the parent on stalled/recovered
      // transitions — the user is already in the pane; widget still updates.
      if (transition && !running.interactive && statusConfig.enabled) {
        transitionLines.push(
          formatTransitionLine(running.name, snapshot, transition),
        );
      }

      // Waiting-delivery + idle auto-close run regardless of the status
      // widget config — they are completion delivery, not widget sugar.
      superviseRunCompletion(pi, running, now);
    }

    if (shouldRefreshWidget && statusConfig.enabled) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(
            transitionLines,
            statusConfig.lineLimit,
          ),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  globalStore[STATUS_INTERVAL_KEY] = supervisionInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

// Tool descriptions, shared verbatim between `description` (tooltip) and
// `promptSnippet` (system prompt) so the two never drift apart. Kept short:
// they are injected into every session's prompt.
const SUBAGENT_DESCRIPTION =
  "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
  "Fire-and-forget: returns immediately with only an acknowledgement; the result " +
  "arrives later as an automatic steer message that starts a new turn. " +
  "Never poll, sleep/wait, or assume/fabricate results — the harness handles delivery. " +
  "After spawning, end your turn or do other independent work (parallel spawns are fine).";

const SUBAGENT_INTERRUPT_DESCRIPTION =
  "Send Escape to the active turn of a running Pi-backed subagent. " +
  "The child pane, session, and watcher stay alive; this only acknowledges the request.";

const SUBAGENTS_LIST_DESCRIPTION =
  "List available subagent definitions from project .pi/agents/ and global " +
  "~/.pi/agent/agents/. Project-local agents override global ones with the same name.";

const SUBAGENT_MESSAGE_DESCRIPTION =
  "Send a message to a sub-agent. If it is live (match by name or id), the " +
  "message is typed into its pane and the sub-agent replies from its own turn — " +
  "pane and watcher stay alive. If the session has ended, pass sessionFile to " +
  "resume it in a new pane with the message as follow-up. Fire-and-forget: " +
  "returns immediately; results arrive later as automatic steer messages. " +
  "Never poll or assume results — end your turn or do other independent work.";

const SUBAGENT_CLOSE_DESCRIPTION =
  "Close a running subagent's pane and finish its session — e.g. after " +
  "following up via subagent_message, or when a waiting subagent is no longer " +
  "needed. If the result was not already delivered, it arrives as an automatic " +
  "steer message.";

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  parseAgentDefinition,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  resolveModelWithFallback,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  resolveRunningTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  closeRunningSubagent,
  superviseRunCompletion,
  sanitizeInjectedMessage,
  shouldDeliverWaitingResult,
  shouldIdleClose,
  runningSubagents,
  formatElapsed,
};

/**
 * Loose view of the `details` payloads this extension attaches to custom
 * messages and tool results. The pi API types them only as opaque records,
 * so renderers narrow them through this interface.
 */
interface SubagentDetailsPayload {
  name?: string;
  id?: string;
  agent?: string;
  status?: string;
  error?: string;
  exitCode?: number;
  elapsed?: number;
  errorMessage?: string;
  sessionFile?: string;
  message?: string;
  agents?: Array<{
    name: string;
    source?: AgentSource;
    description?: string;
    model?: string;
  }>;
  lines?: string[];
  overflow?: number;
}

function detailsOf(value: unknown): SubagentDetailsPayload {
  return (
    typeof value === "object" && value !== null ? value : {}
  ) as SubagentDetailsPayload;
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  globalStore[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: Static<typeof SubagentParams>,
  ctx: {
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
    cwd: string;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const requestedModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  // Credential fallback: the agent's hardcoded model may be unusable here.
  // Claude-backed launches manage their own auth (claude CLI login), so only
  // Pi-backed launches get the fallback. A failing probe must never block a
  // launch — treat it as "auth unknown" and keep the requested model.
  const modelDecision =
    agentDefs?.cli === "claude"
      ? { model: requestedModel, applyThinking: true }
      : resolveModelWithFallback({
          requestedModel,
          hasAuth: (provider, modelId) => {
            try {
              const found = ctx.modelRegistry.find(provider, modelId);
              return found ? ctx.modelRegistry.hasConfiguredAuth(found) : false;
            } catch {
              return true;
            }
          },
          parentModel: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : undefined,
        });
  const effectiveModel = modelDecision.model;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );

  const { effectiveCwd, localAgentDir, effectiveAgentDir } =
    resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(
    targetCwdForSession,
    effectiveAgentDir,
  );

  // Timestamp + unique suffix so simultaneous launches never race on the
  // session file.
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, getShellReadyDelayMs()),
    );
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Fork mode inherits the conversation; blank-session modes get wrapper
  // instructions and artifact-backed handoff.
  //
  // The completion instruction must match the delivery lane that will carry
  // the result: auto-exit agents close themselves; interactive spawns are
  // user-driven in their pane and signal hand-back via subagent_done;
  // autonomous kept-open spawns are delivered by the waiting lane, so they
  // must end their turn with a summary instead of closing themselves.
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : effectiveInteractive
      ? "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time."
      : "Complete your task. When finished, end your turn with a clear summary — it is delivered to the parent session automatically. Do NOT call subagent_done; that would close this session prematurely.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : effectiveInteractive
      ? "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished."
      : "Your FINAL assistant message is steered to the parent as the run result — make it a complete, self-contained summary.";
  const denySet = resolveDenyTools(agentDefs);
  // NOTE: unlike tools/model/skills above, the agent-file body wins over an
  // explicit systemPrompt here. The Claude path below resolves the same two
  // inputs in reverse (params over defaults) — keep the difference in mind
  // when changing either.
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock =
    identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    // Params-over-defaults convention — opposite of the pi path above, where
    // the agent-file body wins.
    const sp = params.systemPrompt ?? agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--resume", shellEscape(params.resumeSessionId));
    }

    // For resumed sessions the task doubles as the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptFile = join(
      artifactDir,
      "subagent-scripts",
      `${safeFileName(params.name, "subagent")}-${id}.sh`,
    );

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    return running;
  }

  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  // herdr's `pane read` can't see alt-screen panes, which breaks
  // pollForExit's crash detection, so force regular mode there.
  if (getMuxBackend() === "herdr") {
    parts.push("--tui-mode", "regular");
  }

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model =
      effectiveThinking && modelDecision.applyThinking
        ? `${effectiveModel}:${effectiveThinking}`
        : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  // Pi auto-detects file paths in --system-prompt/--append-system-prompt, so
  // pass the identity as a file to dodge shell escaping of multiline content.
  if (identityInSystemPrompt && identity) {
    const flag =
      systemPromptMode === "replace"
        ? "--system-prompt"
        : "--append-system-prompt";
    const syspromptPath = join(
      artifactDir,
      `context/${safeFileName(params.name, "subagent")}-sysprompt-${fileTimestamp()}.md`,
    );
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    parts.push("--tools", shellEscape(toolAllowlist));
  }

  // Build env prefix: denied tools + subagent identity + config dir propagation
  const envParts: string[] = [];

  // Prefer the target cwd's own .pi/agent/ as config root when present.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(
      `PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`,
    );
  }

  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = `${envParts.join(" ")} `;

  // Fork mode gets the task as a direct arg; blank-session modes use
  // artifact-backed handoff so instructions arrive as the first message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const artifactName = `context/${safeFileName(params.name, "subagent")}-${fileTimestamp()}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // cd prefix — effectiveCwd was resolved above so placement, env, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptFile = join(
    artifactDir,
    "subagent-scripts",
    `${safeFileName(params.name, "subagent")}-${id}.sh`,
  );
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    modelWarning: modelDecision.warning,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  return running;
}

/** Local copy of Claude Code transcripts, exposed as `claudeSessionId` in results. */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi",
  "agent",
  "sessions",
  "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    // The sentinel writer (plugin/hooks/on-stop.sh) always records the
    // Claude Code transcript path in a `.transcript` sidecar so the watcher
    // can copy the session file into CLAUDE_SESSIONS_DIR.
    const transcriptFile = `${sentinelFile}.transcript`;
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename =
      transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Close a pane, tolerating surfaces that are already gone (e.g. closed via
 * subagent_close or idle auto-close moments before the watcher finished).
 */
function closeSurfaceSafe(surface: string): void {
  try {
    closeSurface(surface);
  } catch {
    // Pane already closed.
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(
      surface,
      AbortSignal.any([signal, getModuleAbortSignal()]),
      {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        onTick() {
          observeRunningSubagent(running);
        },
      },
    );

    // Synchronously block the waiting-delivery lane before the next 1s
    // supervision tick can observe a mid-completion state.
    running.completing = true;

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        // Pane may already be gone (closed via subagent_close) — fall through
        // to the placeholder summary instead of failing the result.
        try {
          summary = readScreen(surface, 200)
            .replace(/__SUBAGENT_DONE_\d+__/, "")
            .trimEnd();
        } catch {}
      }

      if (!summary) {
        summary =
          result.exitCode !== 0
            ? `Claude Code exited with code ${result.exitCode}`
            : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try {
          unlinkSync(running.sentinelFile);
        } catch {}
        try {
          unlinkSync(`${running.sentinelFile}.transcript`);
        } catch {}
      }

      closeSurfaceSafe(surface);
      runningSubagents.delete(running.id);

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    // Best-effort cleanup of a possibly-unconsumed `.exit` sidecar (e.g.
    // written by closeRunningSubagent moments before pollForExit's fast path
    // ran) so a later resume never sees a stale exit signal.
    try {
      unlinkSync(`${sessionFile}.exit`);
    } catch {}

    closeSurfaceSafe(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err) {
    const message = errorMessage(err);
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${message}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
    };
  }
}

const SUBAGENT_LAYOUT_ITEMS: SelectItem[] = [
  {
    value: "columns",
    label: "columns",
    description: "Full-height columns of equal width",
  },
  {
    value: "tiled",
    label: "tiled",
    description: "Block grid: 1×1 → 2×2 → 2×3 → 3×3 …",
  },
];

/**
 * Interactive layout picker, mirroring the built-in /thinking selector:
 * bordered SelectList, current mode preselected, Esc cancels.
 */
async function selectSubagentLayout(
  ui: ExtensionUIContext,
  current: SubagentLayoutMode,
): Promise<SubagentLayoutMode | undefined> {
  return ui.custom<SubagentLayoutMode | undefined>(
    (_tui, _theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder());
      const list = new SelectList(
        SUBAGENT_LAYOUT_ITEMS,
        SUBAGENT_LAYOUT_ITEMS.length,
        getSelectListTheme(),
      );
      const currentIndex = SUBAGENT_LAYOUT_ITEMS.findIndex(
        (item) => item.value === current,
      );
      if (currentIndex !== -1) list.setSelectedIndex(currentIndex);
      list.onSelect = (item) => {
        if (item.value === "columns" || item.value === "tiled")
          done(item.value);
      };
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new DynamicBorder());
      return {
        render: (width: number) => container.render(width),
        handleInput: (data: string) => list.handleInput(data),
        invalidate: () => list.invalidate(),
      };
    },
  );
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      globalStore[WIDGET_INTERVAL_KEY] = null;
    }
    if (supervisionInterval) {
      clearInterval(supervisionInterval);
      supervisionInterval = null;
      globalStore[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = globalStore[POLL_ABORT_KEY] as
      | AbortController
      | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: SUBAGENT_DESCRIPTION,
      promptSnippet: SUBAGENT_DESCRIPTION,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startSupervisionLoop(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => deliverWatchResult(pi, running, result))
          .catch((err) => deliverWatchError(pi, running, err));

        // Fire-and-forget: the watcher's .then() steers the result later.
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.` +
                (running.modelWarning ? `\n\n⚠️ ${running.modelWarning}` : ""),
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
            ...(running.modelWarning
              ? { modelWarning: running.modelWarning }
              : {}),
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : "(unnamed)";
        const task =
          typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = `▸ ${theme.fg("toolTitle", theme.bold(name))}${agent}${cwdHint}`;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine =
            task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview =
            firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
          if (preview) {
            text += `\n${theme.fg("toolOutput", preview)}`;
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text =
          typeof result.content[0]?.text === "string"
            ? result.content[0].text
            : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description: SUBAGENT_INTERRUPT_DESCRIPTION,
      promptSnippet: SUBAGENT_INTERRUPT_DESCRIPTION,
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Exact running subagent id" }),
        ),
        name: Type.Optional(
          Type.String({ description: "Exact running subagent display name" }),
        ),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg(
                "toolTitle",
                theme.bold(details.name ?? details.id ?? "subagent"),
              ) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text =
          typeof result.content[0]?.text === "string"
            ? result.content[0].text
            : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description: SUBAGENTS_LIST_DESCRIPTION,
      promptSnippet: SUBAGENTS_LIST_DESCRIPTION,
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter(
          (agent) => !agent.disableModelInvocation,
        );

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const agents = details.agents ?? [];
        if (agents.length === 0) {
          return new Text(
            theme.fg("dim", "No subagent definitions found."),
            0,
            0,
          );
        }
        const lines = agents.map((a) => {
          const badge =
            a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description
            ? theme.fg("dim", ` — ${a.description}`)
            : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  if (shouldRegister("subagent_message"))
    pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description: SUBAGENT_MESSAGE_DESCRIPTION,
      promptSnippet: SUBAGENT_MESSAGE_DESCRIPTION,
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "Display name of a live subagent (also used as tab label on resume)",
          }),
        ),
        id: Type.Optional(
          Type.String({
            description: "Live subagent id (from spawn tool result details)",
          }),
        ),
        sessionFile: Type.Optional(
          Type.String({
            description:
              "Session .jsonl path. REQUIRED when the target is not live — resumes that session in a new pane. Found in the result steer message details / the `Session:` line.",
          }),
        ),
        message: Type.String({
          description: "The message to deliver to the sub-agent",
        }),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Resume path only: whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const target =
          args.name ?? args.id ?? (args.sessionFile ? "Resume" : "(unknown)");
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(target)) +
          theme.fg("dim", " — message");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "subagent";

        if (details.status === "delivered_live") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — message delivered"),
            0,
            0,
          );
        }

        if (details.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text =
          typeof result.content[0]?.text === "string"
            ? result.content[0].text
            : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // LIVE path: id or name matches a running subagent — type the message
        // into its pane. pi queues typed input while the child is running,
        // exactly like a user typing, so there is no busy-gating on phase.
        // No match falls through to the resume path below.
        const match = matchLiveTarget(params.id, params.name);
        if ("ambiguous" in match) {
          return {
            content: [{ type: "text", text: match.ambiguous }],
            details: {
              error: "ambiguous name",
              name: params.name?.trim(),
            },
          };
        }
        const live = match.running;

        if (live) {
          const sanitized = sanitizeInjectedMessage(params.message);
          try {
            sendCommand(live.surface, sanitized);
          } catch (error) {
            const text = `Failed to deliver message to subagent "${live.name}": ${errorMessage(error)}`;
            return {
              content: [{ type: "text", text }],
              details: { error: text, id: live.id, name: live.name },
            };
          }
          // Keep the waiting-delivery latch armed — the reply (a new idle
          // episode with a new assistant message) is delivered through the
          // index growth guard. Only re-arm the exit lane: the injected
          // follow-up means the pane's eventual exit must steer again.
          live.exitSteerSuppressed = false;
          return {
            content: [
              {
                type: "text",
                text: `Message delivered to live subagent "${live.name}" (pane ${live.surface}).`,
              },
            ],
            details: {
              status: "delivered_live",
              id: live.id,
              name: live.name,
            },
          };
        }

        // RESUME path: the target is not live. A sessionFile is required to
        // reopen an ended session in a new pane with the message as follow-up.
        if (!params.sessionFile) {
          const text =
            "No live subagent matched. To message a RUNNING subagent, pass its id or exact display name. " +
            "To resume an ENDED subagent session, pass sessionFile (found in the result steer message details / the `Session:` line)." +
            `\n\n${formatRunningSubagents()}`;
          return {
            content: [{ type: "text", text }],
            details: { error: "no target" },
          };
        }

        const sessionPath = params.sessionFile;
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior({
          autoExit: params.autoExit,
        });
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(sessionPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: session file not found: ${sessionPath}`,
              },
            ],
            details: { error: "session not found", sessionFile: sessionPath },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(sessionPath, 0).length;

        const surface = createSurface(name);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, getShellReadyDelayMs()),
        );

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(sessionPath)];

        // Keep resumed panes readable on herdr (see launchSubagent).
        if (getMuxBackend() === "herdr") {
          parts.push("--tui-mode", "regular");
        }

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          sessionId,
        );
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        const resumeMsgFile = join(
          artifactDir,
          "subagent-resume",
          `${safeFileName(name, "resume")}-${fileTimestamp()}.md`,
        );
        mkdirSync(dirname(resumeMsgFile), { recursive: true });
        writeFileSync(resumeMsgFile, params.message, "utf8");
        parts.push(shellEscape(`@${resumeMsgFile}`));

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(
            `PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`,
          );
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(
          `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
        );
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = `${resumeEnvParts.join(" ")} `;

        const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${safeFileName(name, "resume")}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            `# Message file: ${resumeMsgFile}`,
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startSupervisionLoop(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            // Re-extract the summary from entries added since the resume —
            // the watcher only saw the session's pre-existing content.
            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary =
              findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            deliverWatchResult(pi, running, result, { summary });
          })
          .catch((err) => deliverWatchError(pi, running, err));

        return {
          content: [
            {
              type: "text",
              text: `Session "${name}" resumed with the message.`,
            },
          ],
          details: {
            id,
            name,
            sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  if (shouldRegister("subagent_close"))
    pi.registerTool({
      name: "subagent_close",
      label: "Close Subagent",
      description: SUBAGENT_CLOSE_DESCRIPTION,
      promptSnippet: SUBAGENT_CLOSE_DESCRIPTION,
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Exact running subagent id" }),
        ),
        name: Type.Optional(
          Type.String({ description: "Exact running subagent display name" }),
        ),
      }),

      async execute(_toolCallId, params) {
        const resolved = resolveRunningTarget(params);
        if ("error" in resolved) {
          const text = `${resolved.error}\n\n${formatRunningSubagents()}`;
          return {
            content: [{ type: "text", text }],
            details: { error: resolved.error },
          };
        }

        const running = resolved.running;
        closeRunningSubagent(running, "closed-by-parent");

        return {
          content: [
            { type: "text", text: `Closing subagent "${running.name}".` },
          ],
          details: { status: "closing", id: running.id, name: running.name },
        };
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — close"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "closing") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg(
                "toolTitle",
                theme.bold(details.name ?? details.id ?? "subagent"),
              ) +
              theme.fg("dim", " — closing"),
            0,
            0,
          );
        }

        const text =
          typeof result.content[0]?.text === "string"
            ? result.content[0].text
            : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description:
      "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in .pi/agents/, ~/.pi/agent/agents/, or the bundled agents directory`,
          "error",
        );
        return;
      }

      const taskText =
        task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent-layout command — pick subagent pane layout (herdr/tmux)
  pi.registerCommand("subagent-layout", {
    description: "Subagent pane layout: columns ↔ tiled grid (herdr/tmux)",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const items = SUBAGENT_LAYOUT_ITEMS.filter((item) =>
        item.value.startsWith(prefix),
      );
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "columns" && arg !== "tiled") {
        ctx.ui.notify("Usage: /subagent-layout [columns|tiled]", "warning");
        return;
      }
      const current = getSubagentLayoutMode();
      const next =
        arg === "columns" || arg === "tiled"
          ? arg
          : await selectSubagentLayout(ctx.ui, current);
      if (!next) return; // picker canceled
      setSubagentLayoutMode(next);
      const backend = getMuxBackend();
      const note =
        backend === "herdr" || backend === "tmux"
          ? ""
          : " (note: this multiplexer uses its own layout)";
      ctx.ui.notify(
        `Subagent layout: ${next}${note} — applies to newly spawned subagents`,
        "info",
      );
    },
  });

  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    if (message.details == null) return undefined;
    const details = detailsOf(message.details);

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorText =
          typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorText;
        const elapsed =
          details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorText
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent
          ? theme.fg("dim", ` (${details.agent})`)
          : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent =
          typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display).
        // The label lines come from the resultLabel* helpers above.
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(
            /\n\nSession: .+\nReply live with subagent_message[^\n]*$/,
            "",
          )
          .replace(`${resultLabelCompleted(name, elapsed)}\n\n`, "")
          .replace(`${resultLabelFailedExit(name, exitCode)}\n\n`, "")
          .replace(`${resultLabelWaiting(name, elapsed)}\n\n`, "")
          .replace(`${resultLabelProviderError(name, elapsed)}\n\n`, "");

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
            contentLines.push(
              theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
            );
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(
                theme.fg("muted", `… ${totalLines - 5} more lines`),
              );
            }
          }
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = detailsOf(message.details);
    const lines = Array.isArray(details.lines) ? details.lines : [];
    const overflow =
      typeof details.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) =>
            theme.fg("dim", truncateToWidth(line, lineWidth)),
          ),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        const box = new Box(1, 1, (text: string) =>
          theme.bg("customMessageBg", text),
        );
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    if (message.details == null) return undefined;
    const details = detailsOf(message.details);

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent
          ? theme.fg("dim", ` (${details.agent})`)
          : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
          }
        } else {
          const preview = (details.message ?? "")
            .split("\n")[0]
            .slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      if (isMuxAvailable()) {
        try {
          const label = task.length > 40 ? `${task.slice(0, 40)}...` : task;
          renameWorkspace(`🎯 ${label}`);
          renameCurrentTab(`🎯 Plan: ${label}`);
        } catch {
          // non-critical -- do not block the plan
        }
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}

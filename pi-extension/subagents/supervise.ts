// Watching, supervision loop, result delivery, and closing for running
// subagents.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type ActivityReadResult,
  readSubagentActivityFile,
  type SubagentActivityState,
} from "./activity.ts";
import { closeSurface, readScreen } from "./cmux.ts";
import { pollForExit } from "./exit-poll.ts";
import {
  findLastAssistantIndex,
  findLastAssistantMessage,
  getNewEntries,
} from "./session.ts";
import {
  clearStoredInterval,
  completionConfig,
  getModuleAbortSignal,
  getStoredInterval,
  globalStore,
  runningSubagents,
  STATUS_INTERVAL_KEY,
  statusConfig,
  type RunningSubagent,
  type SubagentResult,
} from "./state.ts";
import {
  advanceStatusState,
  capStatusLines,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  type StatusActivityPhase,
  type StatusSnapshotState,
} from "./status.ts";
import {
  resultLabelCompleted,
  resultLabelFailedExit,
  resultLabelProviderError,
  resultLabelWaiting,
  startWidgetRefresh,
  updateWidget,
} from "./ui.ts";
import { elapsedSeconds, errorMessage, formatElapsed } from "./util.ts";

export function resolveResultPresentation(
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
export function deliverWatchResult(
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
export function deliverWatchError(
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

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function observeRunningSubagent(
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
export function closeRunningSubagent(
  running: RunningSubagent,
  reason: string,
): void {
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
/**
 * Idle ms since the run started waiting, or null when this tick cannot
 * evaluate completion at all (wrong kind of subagent, run still active, no
 * time reference).
 */
function completionIdleMs(
  running: RunningSubagent,
  state: RunningSubagent["statusState"],
  now: number,
): number | null {
  if (running.cli === "claude") return null;
  if (running.interactive) return null;
  if (running.interruptRequested) return null;
  if (running.completing) return null;

  // Only terminal phases can deliver; skip the session-file read while the
  // child is active/starting.
  if (state.phase !== "waiting" && state.phase !== "done") return null;
  const referenceMs = state.waitingSinceMs ?? state.lastActivityAtMs;
  if (referenceMs == null) return null;
  return Math.max(0, now - referenceMs);
}

/** Close the pane when the waiting run has idled past the idle-close window. */
function idleCloseIfDue(running: RunningSubagent, idleMs: number): void {
  if (
    !running.exitSteerSuppressed &&
    shouldIdleClose(
      {
        interactive: running.interactive,
        interruptRequested: running.interruptRequested,
        waitingDelivered: running.waitingDelivered,
        idleMs,
        deliveredWaitingSince: running.deliveredWaitingSince,
        waitingSinceMs: running.statusState.waitingSinceMs,
      },
      { idleCloseMs: completionConfig.idleCloseMs },
    )
  ) {
    closeRunningSubagent(running, "idle-close");
  }
}

/**
 * Last assistant message + its entry index from the session file, or null
 * when the file is unreadable this tick.
 */
function readCompletionSummary(
  sessionFile: string,
): { summary: string; lastAssistantIndex: number } | null {
  try {
    const entries = getNewEntries(sessionFile, 0);
    return {
      lastAssistantIndex: findLastAssistantIndex(entries),
      summary:
        findLastAssistantMessage(entries) ??
        "(finished without a closing message)",
    };
  } catch {
    return null;
  }
}

/** Steer the waiting result message to the parent and record the delivery snapshot. */
function deliverWaitingResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  summary: string,
  lastAssistantIndex: number,
  now: number,
): void {
  const state = running.statusState;
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

export function superviseRunCompletion(
  pi: ExtensionAPI,
  running: RunningSubagent,
  now: number,
): void {
  const state = running.statusState;
  const idleMs = completionIdleMs(running, state, now);
  if (idleMs == null) return;

  // Perf: a delivered run with no new activity since its delivery snapshot
  // cannot deliver anything new (the index guard would block it) — skip the
  // session-file read. Only idle-close remains, computed from snapshot state.
  if (
    running.waitingDelivered === true &&
    state.lastActivitySequence != null &&
    state.lastActivitySequence === running.deliveredSequence
  ) {
    idleCloseIfDue(running, idleMs);
    return;
  }

  // Read the session file once per candidate tick: the last assistant entry
  // index feeds the growth guard and its text becomes the closing summary.
  const read = readCompletionSummary(running.sessionFile);
  if (!read) return;

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
      lastAssistantIndex: read.lastAssistantIndex,
      deliveredAssistantIndex: running.deliveredAssistantIndex,
    },
    { steerDebounceMs: completionConfig.steerDebounceMs },
    now,
  );

  if (decision.deliver) {
    deliverWaitingResult(
      pi,
      running,
      read.summary,
      read.lastAssistantIndex,
      now,
    );
  }

  idleCloseIfDue(running, idleMs);
}

/**
 * 1s supervision loop for all running subagents: status-widget refresh and
 * stalled/recovered steering when the widget is enabled, plus waiting-delivery
 * and idle auto-close completion supervision always (they run even when the
 * status widget config is disabled).
 */
export function startSupervisionLoop(pi: ExtensionAPI) {
  if (getStoredInterval(STATUS_INTERVAL_KEY)) return;

  globalStore[STATUS_INTERVAL_KEY] = setInterval(() => {
    if (runningSubagents.size === 0) {
      clearStoredInterval(STATUS_INTERVAL_KEY);
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
}

/**
 * Register a fresh run and pair it with its background watcher: starts the
 * widget + supervision loops, attaches a dedicated abort controller, and
 * fire-and-forgets the watch pipeline that steers the result back.
 */
export function startWatchPipeline(
  pi: ExtensionAPI,
  running: RunningSubagent,
  onResult?: (result: SubagentResult) => void,
): void {
  // Separate AbortController for the watcher — the calling tool's own signal
  // completes as soon as the tool returns.
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;
  startWidgetRefresh();
  startSupervisionLoop(pi);
  watchSubagent(running, watcherAbort.signal)
    .then((result) =>
      onResult ? onResult(result) : deliverWatchResult(pi, running, result),
    )
    .catch((err) => deliverWatchError(pi, running, err));
}

/** Exit summary when no assistant message carried the result. */
export function exitSummaryFallback(
  result: Pick<SubagentResult, "exitCode" | "errorMessage">,
  subject = "Sub-agent",
  withoutSuffix = "output",
): string {
  if (result.errorMessage) {
    return `Subagent error: ${result.errorMessage}`;
  }
  if (result.exitCode !== 0) {
    return `${subject} exited with code ${result.exitCode}`;
  }
  return `${subject} exited without ${withoutSuffix}`;
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
export async function watchSubagent(
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

    const elapsed = elapsedSeconds(startTime);

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
    const allEntries = existsSync(sessionFile)
      ? getNewEntries(sessionFile, 0)
      : [];
    const summary =
      findLastAssistantMessage(allEntries) ?? exitSummaryFallback(result);

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
        elapsed: elapsedSeconds(startTime),
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${message}`,
      exitCode: 1,
      elapsed: elapsedSeconds(startTime),
    };
  }
}

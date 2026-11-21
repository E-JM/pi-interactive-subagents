// The five subagent tools: target resolution, interrupt, and registration.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { getSubagentActivityFile } from "./activity.ts";
import { discoverAgentDefinitions } from "./agents.ts";
import {
  createSurface,
  getMuxBackend,
  isMuxAvailable,
  sendCommand,
  sendEscape,
  shellEscape,
} from "./cmux.ts";
import {
  buildPiInvocation,
  buildSubagentEnvPrefix,
  createRunningSubagent,
  launchSubagent,
  resolveResumeLaunchBehavior,
  sendLaunchScript,
  SubagentParams,
} from "./launch.ts";
import { runningSubagents, type RunningSubagent } from "./state.ts";
import { forceStatusAfterInterrupt } from "./status.ts";
import {
  closeRunningSubagent,
  deliverWatchResult,
  exitSummaryFallback,
  observeRunningSubagent,
  sanitizeInjectedMessage,
  startWatchPipeline,
} from "./supervise.ts";
import {
  detailsOf,
  renderResultFallback,
  renderTargetCall,
  targetCallText,
  updateWidget,
} from "./ui.ts";
import {
  errorMessage,
  getArtifactDir,
  getShellReadyDelayMs,
  muxUnavailableResult,
  randomHex,
  safeFileName,
  fileTimestamp,
} from "./util.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";

/**
 * Match a live subagent by id or exact display name — no no-match error:
 * the subagent_message resume path falls through to a resume when nothing
 * matches. `ambiguous` carries the ready-to-use ambiguity error text.
 */
export function matchLiveTarget(
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

export function resolveRunningTarget(params: {
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
export function formatRunningSubagents(): string {
  const entries = Array.from(runningSubagents.values());
  if (entries.length === 0) return "No subagents are currently running.";
  return entries
    .map((running) => {
      const cliTag = running.cli === "claude" ? " (claude)" : "";
      return `• ${running.name} [${running.id}]${cliTag}`;
    })
    .join("\n");
}

export function requestSubagentInterrupt(
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

export function handleSubagentInterrupt(
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

export function registerSubagentSpawnTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
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

        // Fire-and-forget: the watcher's .then() steers the result later.
        startWatchPipeline(pi, running);
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
          return targetCallText(name, theme, "started");
        }

        // Fallback (shouldn't happen)
        return renderResultFallback(result, theme);
      },
    });
}

export function registerSubagentInterruptTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
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
        return renderTargetCall(args, theme, "interrupt turn");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "interrupt_requested") {
          return targetCallText(
            details.name ?? details.id ?? "subagent",
            theme,
            "interrupt requested",
          );
        }

        return renderResultFallback(result, theme);
      },
    });
}

export function registerSubagentsListTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
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
}

export function registerSubagentMessageTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
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
        return targetCallText(target, theme, "message");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        const name = details.name ?? "subagent";

        if (details.status === "delivered_live") {
          return targetCallText(name, theme, "message delivered");
        }

        if (details.status === "started") {
          return targetCallText(name, theme, "resumed");
        }

        // Fallback
        return renderResultFallback(result, theme);
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
        const id = randomHex(8);

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

        const command = buildPiInvocation({
          sessionFile: sessionPath,
          envPrefix: buildSubagentEnvPrefix({
            name,
            sessionFile: sessionPath,
            id,
            activityFile,
            autoExit,
            agentConfigDir: process.env.PI_CODING_AGENT_DIR,
          }),
          escapedArgs: [shellEscape(`@${resumeMsgFile}`)],
        });

        const launchScriptFile = sendLaunchScript(surface, command, {
          artifactDir,
          fileBase: `${safeFileName(name, "resume")}-resume-${Date.now()}`,
          preambleLines: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            `# Message file: ${resumeMsgFile}`,
          ],
        });

        // Register as a running subagent for widget tracking, then watch it.
        const running = createRunningSubagent({
          id,
          name,
          task: params.message,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          source: "pi",
        });
        runningSubagents.set(id, running);

        startWatchPipeline(pi, running, (result) => {
          // Re-extract the summary from entries added since the resume —
          // the watcher only saw the session's pre-existing content.
          const allEntries = getNewEntries(sessionPath, entryCountBefore);
          const summary =
            findLastAssistantMessage(allEntries) ??
            exitSummaryFallback(result, "Resumed session", "new output");
          deliverWatchResult(pi, running, result, { summary });
        });

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
}

export function registerSubagentCloseTool(
  pi: ExtensionAPI,
  shouldRegister: (name: string) => boolean,
): void {
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
        return renderTargetCall(args, theme, "close");
      },

      renderResult(result, _opts, theme) {
        const details = detailsOf(result.details);
        if (details.status === "closing") {
          return targetCallText(
            details.name ?? details.id ?? "subagent",
            theme,
            "closing",
          );
        }

        return renderResultFallback(result, theme);
      },
    });
}

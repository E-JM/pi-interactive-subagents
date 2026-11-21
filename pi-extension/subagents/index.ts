// Composition root for the subagents extension: wires the register* functions
// from the focused modules into the pi extension lifecycle.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  discoverAgentDefinitions,
  loadAgentDefaults,
  parseAgentDefinition,
  resolveDenyTools,
} from "./agents.ts";
import {
  buildClaudeCommand,
  buildPiInvocation,
  buildPiPromptArgs,
  buildSubagentEnvPrefix,
  buildSubagentToolAllowlist,
  composeFullTask,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveModelWithFallback,
  resolveResumeLaunchBehavior,
} from "./launch.ts";
import {
  clearStoredInterval,
  globalStore,
  POLL_ABORT_KEY,
  runningSubagents,
  setLatestContext,
  STATUS_INTERVAL_KEY,
  WIDGET_INTERVAL_KEY,
} from "./state.ts";
import {
  closeRunningSubagent,
  exitSummaryFallback,
  resolveResultPresentation,
  sanitizeInjectedMessage,
  shouldDeliverWaitingResult,
  shouldIdleClose,
  superviseRunCompletion,
} from "./supervise.ts";
import {
  handleSubagentInterrupt,
  registerSubagentCloseTool,
  registerSubagentInterruptTool,
  registerSubagentMessageTool,
  registerSubagentsListTool,
  registerSubagentSpawnTool,
  requestSubagentInterrupt,
  resolveRunningTarget,
} from "./tools.ts";
import { registerSubagentCommands } from "./commands.ts";
import {
  borderLine,
  registerSubagentMessageRenderers,
  renderSubagentWidgetLines,
} from "./ui.ts";
import { getShellReadyDelayMs } from "./util.ts";

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
  buildSubagentEnvPrefix,
  buildPiInvocation,
  buildClaudeCommand,
  exitSummaryFallback,
  composeFullTask,
};

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    setLatestContext(ctx);
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    clearStoredInterval(WIDGET_INTERVAL_KEY);
    clearStoredInterval(STATUS_INTERVAL_KEY);
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

  registerSubagentSpawnTool(pi, shouldRegister);
  registerSubagentInterruptTool(pi, shouldRegister);
  registerSubagentsListTool(pi, shouldRegister);
  registerSubagentMessageTool(pi, shouldRegister);
  registerSubagentCloseTool(pi, shouldRegister);
  registerSubagentCommands(pi);
  registerSubagentMessageRenderers(pi);
}

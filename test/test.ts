import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@mariozechner/pi-tui";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  __pollForExitTest__,
  canSplitZellijPane,
  getSubagentLayoutMode,
  gridDimsForCount,
  isCmuxAvailable,
  isHerdrAvailable,
  isWezTermAvailable,
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  parseHerdrLayout,
  parseHerdrPaneId,
  parseTmuxPaneGeometry,
  planGridTargets,
  planHerdrGridRebalance,
  planHerdrRebalance,
  planTmuxGridRebalance,
  planTmuxRebalance,
  rightmostAnchor,
  predictZellijSplitDirection,
  selectTiledGridAnchor,
  selectZellijPlacement,
  selectZellijStackPlacement,
  setHerdrSubagentPaneList,
  setSubagentLayoutMode,
  setTmuxSubagentPaneList,
  shellEscape,
} from "../pi-extension/subagents/cmux.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  appendBranchSummary,
  copySessionFile,
  findLastAssistantMessage,
  getLeafId,
  getNewEntries,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  loadStatusConfig,
  observeStatus,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import subagentDoneExtension, {
  findLatestAssistantError,
  shouldAutoExitOnAgentEnd,
} from "../pi-extension/subagents/subagent-done.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  writeFileSync(file, content);
  return file;
}

async function withTempDir<T>(run: (dir: string) => T | Promise<T>) {
  const dir = createTestDir();
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const eventHandlers = new Map<
    string,
    Array<(event: any, ctx: any) => void>
  >();
  const registeredShortcuts: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    eventHandlers,
    registeredShortcuts,
    emit(event: string, payload?: any, ctx?: any) {
      for (const handler of eventHandlers.get(event) ?? [])
        handler(payload, ctx);
    },
    api: {
      on(name: string, handler: (event: any, ctx: any) => void) {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut(name: string, shortcut: any) {
        registeredShortcuts.push({ name, ...shortcut });
      },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

// Extension registration and mux detection consult these env vars; a stray
// export (e.g. PI_DENY_TOOLS in reviewer sessions) silently disables tools
// and breaks unrelated tests. Snapshot-and-clear once for the whole file;
// tests that need specific values set and restore their own.
const GATED_ENV_KEYS = [
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_MUX",
  "CMUX_SOCKET_PATH",
  "PI_SUBAGENT_AGENT",
];
const gatedEnvSaved = new Map(GATED_ENV_KEYS.map((k) => [k, process.env[k]]));
before(() => {
  for (const key of GATED_ENV_KEYS) delete process.env[key];
});
after(() => {
  for (const key of GATED_ENV_KEYS) restoreEnvVar(key, gatedEnvSaved.get(key));
});

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}\n`,
  );
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(
        findLastAssistantMessage([msg] as any[]),
        "Here is partial output.",
      );
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const id = appendBranchSummary(
        file,
        "user-001",
        "asst-001",
        "The plan was created.",
      );

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [
        SESSION_HEADER,
        MODEL_CHANGE,
        USER_MSG,
        ASSISTANT_MSG,
      ]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(
        entries.some(
          (entry) =>
            entry.type === "session" && entry.parentSession !== parentFile,
        ),
        false,
      );
      assert.equal(
        entries.some((entry) => entry.type === "message"),
        false,
      );
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        `${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG]
          .map((e) => JSON.stringify(e))
          .join("\n")}\n`,
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") +
          "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
      completion: { steerDebounceMs: 3_000, idleCloseMs: 600_000 },
    });
  });

  it("defaults the completion section when it is absent", () => {
    const config = parseStatusConfig({ status: { enabled: true } });

    assert.deepEqual(config.completion, {
      steerDebounceMs: 3_000,
      idleCloseMs: 600_000,
    });
  });

  it("parses explicit completion values", () => {
    const config = parseStatusConfig({
      status: { enabled: true },
      completion: { steerDebounceMs: 1_500, idleCloseMs: 0 },
    });

    assert.deepEqual(config.completion, {
      steerDebounceMs: 1_500,
      idleCloseMs: 0,
    });
  });

  it("rejects invalid completion values", () => {
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { steerDebounceMs: "soon" },
        }),
      /completion\.steerDebounceMs must be an integer >= 1/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { steerDebounceMs: 0 },
        }),
      /completion\.steerDebounceMs must be an integer >= 1/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { steerDebounceMs: -5 },
        }),
      /completion\.steerDebounceMs must be an integer >= 1/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { steerDebounceMs: 1.5 },
        }),
      /completion\.steerDebounceMs must be an integer >= 1/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { idleCloseMs: -1 },
        }),
      /completion\.idleCloseMs must be an integer >= 0/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { idleCloseMs: true },
        }),
      /completion\.idleCloseMs must be an integer >= 0/,
    );
  });

  it("rejects unknown completion keys and non-object sections", () => {
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true },
          completion: { steerDebounceMs: 1_000, cadenceMs: 60 },
        }),
      /completion has unsupported key\(s\): cadenceMs/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true }, completion: 5 }),
      /completion must be an object/,
    );
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(
      new URL("../config.json.example", import.meta.url),
    );
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
      completion: { steerDebounceMs: 3_000, idleCloseMs: 600_000 },
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
        completion: { steerDebounceMs: 3_000, idleCloseMs: 600_000 },
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () =>
        parseStatusConfig({
          status: { enabled: true, defaultCadenceSeconds: 60 },
        }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () =>
          loadStatusConfig(
            join(dir, "config.json"),
            join(dir, "config.json.example"),
          ),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        `${JSON.stringify({ status: { enabled: true } }, null, 2)}\n`,
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
        latestEvent: "tool_execution_start",
      },
      5_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "3m");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_000,
    );

    const snapshot = classifyStatus(state, 240_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "3m");
  });

  it("uses elapsed-only fallback for claude-backed subagents", () => {
    const state = createStatusState({ source: "claude", startTimeMs: 0 });
    const snapshot = classifyStatus(state, 125_000);

    assert.equal(snapshot.kind, "running");
    assert.equal(snapshot.elapsedText, "2m");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(
      advanced.nextState,
      {
        snapshot: "present",
        updatedAt: 96_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 96_000,
        latestEvent: "agent_end",
      },
      96_000,
    );
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 5_000,
      },
      5_000,
    );
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 10_000,
        activityLabel: "bash",
      },
      10_000,
    );

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 3,
        phase: "waiting",
        waitingSince: 10_000,
        latestEvent: "agent_end",
      },
      10_001,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 2,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      11_000,
    );

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(
      state,
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      21_000,
    );
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(
      stale,
      {
        snapshot: "present",
        updatedAt: 20_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 20_000,
        activityLabel: "bash",
      },
      22_000,
    );
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(
      sameTimestamp,
      {
        snapshot: "present",
        sequence: 2,
        updatedAt: 25_000,
        phase: "active",
        active: true,
        activeScope: "streaming",
        activeSince: 25_000,
        activityLabel: "streaming",
      },
      25_000,
    );
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(
      longName,
      classifyStatus(stalledState, 240_000),
    );
    const recovered = formatTransitionLine(
      longName,
      classifyStatus(activeState, 300_000),
      "recovered",
    );

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(
      line.length <= 120,
      `expected bounded line length, got ${line.length}`,
    );
    assert.ok(
      recovered.length <= 120,
      `expected bounded line length, got ${recovered.length}`,
    );
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 180_000,
        sequence: 1,
        phase: "waiting",
        waitingSince: 180_000,
      },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine(
      "Worker",
      classifyStatus(waitingState, 300_000),
    );
    const recoveredLine = formatTransitionLine(
      "Worker",
      classifyStatus(activeState, 420_000),
      "recovered",
    );
    const lines = [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
      "Reviewer running 4m.",
      "Planner running 6m.",
    ];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 5m, waiting 2m.");
    assert.equal(
      recoveredLine,
      "Worker running 7m, recovered; active (bash 1s).",
    );
    assert.deepEqual(capped.visibleLines, [
      waitingLine,
      recoveredLine,
      "Scout running 2m.",
    ]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults(
        "interactive-true-test-agent",
      );
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults(
        "interactive-false-test-agent",
      );
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true },
      ),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: false },
      ),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled scout/worker/reviewer agents resolve as non-interactive; planner resolves as interactive", () => {
    for (const name of ["scout", "worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      );
    }

    const planner = testApi.loadAgentDefaults("planner");
    assert.ok(planner, "expected bundled planner to be discoverable");
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "planner", task: "" },
        planner,
      ),
      true,
      "planner should resolve as interactive (no auto-exit)",
    );
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null),
      "standalone",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T" },
        { sessionMode: "lineage-only" },
      ),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null),
      {
        sessionMode: "standalone",
        seededSessionMode: null,
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T" },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T" },
        { sessionMode: "fork" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review,lint",
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: undefined,
        taskDelivery: "artifact",
        taskArg: "@artifact.md",
      }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({
        effectiveSkills: "review",
        taskDelivery: "direct",
        taskArg: "do the task",
      }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find(
        (tool) => tool.name === "subagents_list",
      );
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(
        agents.some(
          (agent: any) => agent.name === "visible-discovery-test-agent",
        ),
      );
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find(
        (tool) => tool.name === "subagents_list",
      );
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(
        agents.some(
          (agent: any) => agent.name === "hidden-discovery-test-agent",
        ),
        false,
      );
      assert.doesNotMatch(
        result.content[0].text,
        /hidden-discovery-test-agent/,
      );

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(
      async ({ projectAgentsDir, globalAgentsDir }) => {
        writeAgentFile(
          globalAgentsDir,
          "shadowed-discovery-test-agent",
          [
            "name: shadowed-discovery-test-agent",
            "description: Global visible agent",
            "model: anthropic/test-global",
          ].join("\n"),
          "You are the global visible agent.",
        );
        writeAgentFile(
          projectAgentsDir,
          "shadowed-discovery-test-agent",
          [
            "name: shadowed-discovery-test-agent",
            "description: Project hidden agent",
            "model: anthropic/test-project",
            "disable-model-invocation: true",
          ].join("\n"),
          "You are the project hidden agent.",
        );

        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);

        const tool = registeredTools.find(
          (tool) => tool.name === "subagents_list",
        );
        assert.ok(tool, "expected subagents_list to be registered");

        const result = await tool.execute();
        const agents = result.details?.agents ?? [];

        assert.equal(
          agents.some(
            (agent: any) => agent.name === "shadowed-discovery-test-agent",
          ),
          false,
        );
        assert.doesNotMatch(
          result.content[0].text,
          /shadowed-discovery-test-agent/,
        );

        const loaded = testApi.loadAgentDefaults(
          "shadowed-discovery-test-agent",
        );
        assert.ok(
          loaded,
          "expected project override to remain directly loadable",
        );
        assert.equal(loaded.model, "anthropic/test-project");
        assert.equal(loaded.body, "You are the project hidden agent.");
        assert.equal(loaded.disableModelInvocation, true);
      },
    );
  });
});
describe("parseAgentDefinition (system-prompt-mode)", () => {
  // Regression guard for the systemPromptMode feature: these exercise the
  // REAL frontmatter parser (the old test/system-prompt-mode.test.ts tested
  // a drifted local copy and was never wired into a test runner).
  const testApi = (subagentsModule as any).__test__;
  const parse = (content: string) =>
    testApi.parseAgentDefinition(content, "fallback-name");

  it("parses system-prompt: replace and extracts the body", () => {
    const parsed = parse(
      [
        "---",
        "model: anthropic/claude-sonnet-4-20250514",
        "system-prompt: replace",
        "auto-exit: true",
        "---",
        "",
        "You are a specialized agent.",
      ].join("\n"),
    );
    assert.equal(parsed?.systemPromptMode, "replace");
    assert.equal(parsed?.body, "You are a specialized agent.");
    assert.equal(parsed?.autoExit, true);
  });

  it("parses system-prompt: append", () => {
    const parsed = parse(
      "---\nsystem-prompt: append\n---\n\nYou are an appended identity.",
    );
    assert.equal(parsed?.systemPromptMode, "append");
    assert.equal(parsed?.body, "You are an appended identity.");
  });

  it("leaves systemPromptMode undefined when the field is absent", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---\n\nDefault body.");
    assert.equal(parsed?.systemPromptMode, undefined);
    assert.equal(parsed?.body, "Default body.");
  });

  it("ignores an invalid system-prompt value", () => {
    const parsed = parse("---\nsystem-prompt: foobar\n---\n\nBody here.");
    assert.equal(parsed?.systemPromptMode, undefined);
  });

  it("falls back to the provided name when frontmatter has none", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---\n\nBody.");
    assert.equal(parsed?.name, "fallback-name");
  });

  it("returns null for content without frontmatter", () => {
    assert.equal(parse("just a body, no frontmatter"), null);
  });

  it("omits body when the file is frontmatter-only", () => {
    const parsed = parse("---\nmodel: anthropic/x\n---");
    assert.equal(parsed?.body, undefined);
  });
});

describe("subagent-done.ts", () => {
  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(messages), false);
    });

    it("exits when the turn produced no assistant message", () => {
      assert.equal(
        shouldAutoExitOnAgentEnd([{ role: "user", content: [] }]),
        true,
      );
      assert.equal(shouldAutoExitOnAgentEnd(undefined), true);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "529 overloaded",
        },
      ];
      assert.equal(shouldAutoExitOnAgentEnd(messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        },
        { role: "toolResult", content: [] },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded",
        },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info?.stopReason, "error");
      assert.match(info?.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("subagent-done.ts extension bootstrap", () => {
  const envKeys = [
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_DENY_TOOLS",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_ID",
    "PI_SUBAGENT_ACTIVITY_FILE",
    "PI_SUBAGENT_SESSION",
  ];
  let savedEnv: Record<string, string | undefined>;
  before(() => {
    savedEnv = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
  });
  after(() => {
    for (const key of envKeys) restoreEnvVar(key, savedEnv[key]);
  });

  function bootstrap(env: Record<string, string> = {}) {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, env);
    const mock = createMockExtensionApi();
    subagentDoneExtension(mock.api);
    return mock;
  }

  function makeCtx(dir: string, env: Record<string, string> = {}) {
    const setWidgetCalls: Array<{ key: string; factory: any }> = [];
    let shutdowns = 0;
    const sessionFile = join(dir, "session.jsonl");
    const ctx = {
      ui: {
        setWidget: (key: string, factory: any) =>
          setWidgetCalls.push({ key, factory }),
      },
      shutdown: () => {
        shutdowns++;
      },
      sessionFile,
      env,
    };
    return { ctx, setWidgetCalls, shutdowns: () => shutdowns, sessionFile };
  }

  const theme = {
    bg: (_key: string, text: string) => text,
    fg: (_key: string, text: string) => text,
    bold: (text: string) => text,
  };

  it("registers lifecycle handlers, both exit tools, and the ctrl+j shortcut", () => {
    const mock = bootstrap();
    for (const event of [
      "session_start",
      "input",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "before_provider_request",
      "after_provider_response",
      "message_update",
      "tool_execution_start",
      "tool_call",
      "tool_execution_update",
      "tool_result",
      "tool_execution_end",
      "session_shutdown",
    ]) {
      assert.ok(mock.eventHandlers.has(event), `missing handler for ${event}`);
    }
    assert.deepEqual(mock.registeredTools.map((t) => t.name).sort(), [
      "caller_ping",
      "subagent_done",
    ]);
    assert.equal(mock.registeredShortcuts[0]?.name, "ctrl+j");
  });

  it("session_start renders the identity widget", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_NAME: "worker" });
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      assert.equal(setWidgetCalls.length, 1);
      assert.equal(setWidgetCalls[0].key, "subagent-tools");
      const box = setWidgetCalls[0].factory(null, theme);
      assert.ok(Array.isArray(box.render(60)));
    });
  });

  it("ctrl+j toggles the widget between collapsed and expanded", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_NAME: "worker" });
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      const collapsed = setWidgetCalls[0]
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(collapsed, /Ctrl\+J to expand/);
      mock.registeredShortcuts[0].handler(ctx);
      const expanded = setWidgetCalls[1]
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(expanded, /Ctrl\+J to collapse/);
      assert.match(expanded, /0 available/);
      mock.registeredShortcuts[0].handler(ctx);
      assert.match(
        setWidgetCalls[2].factory(null, theme).render(60).join("\n"),
        /Ctrl\+J to expand/,
      );
    });
  });

  it("widget lists available and denied tools", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_DENY_TOOLS: "write, edit" });
      mock.api.getAllTools = () => [{ name: "read" }, { name: "write" }];
      const { ctx, setWidgetCalls } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      const collapsed = setWidgetCalls[0]
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(collapsed, /2 tools/);
      assert.match(collapsed, /2 denied/);
      mock.registeredShortcuts[0].handler(ctx);
      const expanded = setWidgetCalls[1]
        .factory(null, theme)
        .render(60)
        .join("\n");
      assert.match(expanded, /read/);
      assert.match(expanded, /denied: write, edit/);
    });
  });

  it("lifecycle events reach the activity recorder file the parent reads", () => {
    withTempDir((dir) => {
      const activityFile = join(dir, "activity.json");
      const mock = bootstrap({
        PI_SUBAGENT_ID: "child-1",
        PI_SUBAGENT_ACTIVITY_FILE: activityFile,
      });
      const { ctx } = makeCtx(dir);
      mock.emit("session_start", {}, ctx);
      mock.emit("input");
      mock.emit("before_agent_start");
      mock.emit("agent_start");
      mock.emit("turn_start", { turnIndex: 0 });
      mock.emit("before_provider_request");
      mock.emit("after_provider_response");
      mock.emit("message_update", { assistantMessageEvent: { type: "text" } });
      mock.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_call", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_execution_update", {
        toolCallId: "t1",
        toolName: "read",
      });
      mock.emit("tool_result", { toolCallId: "t1", toolName: "read" });
      mock.emit("tool_execution_end", { toolCallId: "t1", toolName: "read" });
      mock.emit("turn_end", { turnIndex: 0 });
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      mock.emit("session_shutdown");
      const activity = readSubagentActivityFile(activityFile);
      assert.ok(activity, "activity file was written");
    });
  });

  it("agent_end shuts down an auto-exit subagent after a normal turn", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_AUTO_EXIT: "1" });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.ok(!existsSync(`${sessionFile}.exit`));
    });
  });

  it("agent_end keeps an aborted auto-exit subagent alive", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_AUTO_EXIT: "1" });
      const { ctx, shutdowns } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "aborted" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0);
    });
  });

  it("agent_end ignores autoExit when the parent did not opt in", () => {
    withTempDir((dir) => {
      const mock = bootstrap({});
      const { ctx, shutdowns } = makeCtx(dir);
      mock.emit(
        "agent_end",
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      assert.equal(shutdowns(), 0);
    });
  });

  it("agent_end writes an error sidecar when the turn ended with stopReason=error", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_AUTO_EXIT: "1" });
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      mock.emit(
        "agent_end",
        {
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "529 overloaded",
            },
          ],
        },
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "error",
          errorMessage: "529 overloaded",
          stopReason: "error",
        },
      );
    });
  });

  it("agent_end still shuts down when the error sidecar path is unwritable", () => {
    withTempDir((dir) => {
      const mock = bootstrap({ PI_SUBAGENT_AUTO_EXIT: "1" });
      const { ctx, shutdowns } = makeCtx(dir);
      process.env.PI_SUBAGENT_SESSION = join(
        dir,
        "missing-dir",
        "session.jsonl",
      );
      mock.emit(
        "agent_end",
        {
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "529 overloaded",
            },
          ],
        },
        ctx,
      );
      assert.equal(
        shutdowns(),
        1,
        "shutdown must not be blocked by a failed sidecar write",
      );
    });
  });

  it("caller_ping throws outside a subagent context", async () => {
    const mock = bootstrap({});
    const tool = mock.registeredTools.find((t) => t.name === "caller_ping");
    await assert.rejects(
      () =>
        tool.execute(
          "id",
          { message: "help" },
          undefined,
          undefined,
          {} as any,
        ),
      /PI_SUBAGENT_SESSION/,
    );
  });

  it("caller_ping writes a ping sidecar, shuts down, and confirms", async () => {
    await withTempDir(async (dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const tool = mock.registeredTools.find((t) => t.name === "caller_ping");
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      const result = await tool.execute(
        "id",
        { message: "need a decision" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        {
          type: "ping",
          name: "subagent",
          message: "need a decision",
        },
      );
      assert.match(result.content[0].text, /Ping sent/);
    });
  });

  it("subagent_done writes a done sidecar and shuts down", async () => {
    await withTempDir(async (dir) => {
      const mock = bootstrap({
        PI_SUBAGENT_SESSION: join(dir, "session.jsonl"),
      });
      const tool = mock.registeredTools.find((t) => t.name === "subagent_done");
      const { ctx, shutdowns, sessionFile } = makeCtx(dir);
      const result = await tool.execute("id", {}, undefined, undefined, ctx);
      assert.equal(shutdowns(), 1);
      assert.deepEqual(
        JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
        { type: "done" },
      );
      assert.match(result.content[0].text, /Shutting down/);
    });
  });

  it("subagent_done still shuts down without a session sidecar path", async () => {
    const mock = bootstrap({});
    const tool = mock.registeredTools.find((t) => t.name === "subagent_done");
    const { ctx, shutdowns } = makeCtx("/nonexistent");
    const result = await tool.execute("id", {}, undefined, undefined, ctx);
    assert.equal(shutdowns(), 1);
    assert.match(result.content[0].text, /Shutting down/);
  });
});

describe("cmux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "ping",
        name: "Worker",
        message: "need help",
      }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), {
      reason: "done",
      exitCode: 0,
    });
  });
});
describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } =
      createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find(
      (command) => command.name === "iterate",
    );
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent lifecycle tools", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_message"), true);
    assert.equal(denied.has("subagent_close"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find(
      (tool) => tool.name === "subagent",
    );
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_message with a resume autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const messageTool = registeredTools.find(
      (tool) => tool.name === "subagent_message",
    );
    assert.ok(messageTool, "expected subagent_message tool to be registered");

    const autoExitSchema = messageTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);

    const messageSchema = messageTool.parameters.properties.message;
    assert.equal(messageSchema.type, "string");
  });

  it("registers subagent_close for live subagents", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const closeTool = registeredTools.find(
      (tool) => tool.name === "subagent_close",
    );
    assert.ok(closeTool, "expected subagent_close tool to be registered");
    assert.ok(closeTool.parameters.properties.name);
    assert.ok(closeTool.parameters.properties.id);
  });
});

describe("tool execute error paths", () => {
  const theme = {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  };

  function boot() {
    const mock = createMockExtensionApi();
    (subagentsModule as any).default(mock.api);
    return mock;
  }

  async function executeTool(
    name: string,
    params: object,
    env?: Record<string, string>,
  ) {
    const saved = new Map(
      Object.keys(env ?? {}).map((k) => [k, process.env[k]]),
    );
    try {
      Object.assign(process.env, env);
      const mock = boot();
      const tool = mock.registeredTools.find((t) => t.name === name);
      assert.ok(tool, `expected ${name} tool to be registered`);
      return await tool.execute("test-id", params, undefined, undefined, {});
    } finally {
      for (const [k, v] of saved) restoreEnvVar(k, v);
    }
  }

  it("subagent blocks self-spawning of the current agent", async () => {
    const result = await executeTool(
      "subagent",
      { agent: "planner", task: "plan more" },
      { PI_SUBAGENT_AGENT: "planner" },
    );
    assert.equal(result.details.error, "self-spawn blocked");
    assert.match(result.content[0].text, /do not start another planner/);
  });

  it("subagent reports a missing multiplexer instead of launching", async () => {
    const result = await executeTool(
      "subagent",
      { task: "do work" },
      { PI_SUBAGENT_MUX: "cmux" }, // cmux pinned, no CMUX_SOCKET_PATH -> unavailable
    );
    assert.equal(result.details.error, "mux not available");
    assert.match(
      result.content[0].text,
      /Subagents require a supported terminal multiplexer/,
    );
  });

  it("subagent_message reports how to target a live or ended subagent", async () => {
    const result = await executeTool("subagent_message", { message: "hello" });
    assert.equal(result.details.error, "no target");
    assert.match(result.content[0].text, /No live subagent matched/);
    assert.match(result.content[0].text, /sessionFile/);
  });

  it("subagent_interrupt demands a target", async () => {
    const result = await executeTool("subagent_interrupt", {});
    assert.match(
      result.content[0].text,
      /Provide a running subagent id or exact display name/,
    );
  });

  it("subagent_interrupt reports an unknown id", async () => {
    const result = await executeTool("subagent_interrupt", { id: "nope" });
    assert.match(result.content[0].text, /No running subagent with id "nope"/);
  });

  it("subagent_close reports an unknown name", async () => {
    const result = await executeTool("subagent_close", { name: "ghost" });
    assert.match(result.content[0].text, /No running subagent named "ghost"/);
  });

  it("subagent_result renderer shows the summary and live-reply hint", () => {
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e) => e.name === "subagent_result",
    );
    assert.ok(entry, "expected subagent_result renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_result",
          content:
            'Sub-agent "worker" completed (42s).\n\nAll done.\n\n' +
            "Session: /tmp/session.jsonl\n" +
            "Resume: pi --session /tmp/session.jsonl",
          details: {
            name: "worker",
            task: "write tests",
            elapsed: 42,
            sessionFile: "/tmp/session.jsonl",
            deliveredVia: "waiting",
          },
        },
        { expanded: true },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /worker/);
    assert.match(rendered, /completed \(42s\)/);
    assert.match(rendered, /All done\./);
    assert.doesNotMatch(rendered, /Resume: pi --session/);
  });

  it("subagent_ping renderer shows the ping question", () => {
    const mock = boot();
    const entry = mock.registeredMessageRenderers.find(
      (e) => e.name === "subagent_ping",
    );
    assert.ok(entry, "expected subagent_ping renderer");
    const rendered = entry
      .renderer(
        {
          customType: "subagent_ping",
          details: { name: "scout", message: "Which API should I use?" },
        },
        { expanded: true },
        theme,
      )
      .render(80)
      .join("\n");
    assert.match(rendered, /scout/);
    assert.match(rendered, /Which API should I use\?/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({
          runningChildId: `child-${index}`,
          ...overrides,
        });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(
      registeredTools.some((tool) => tool.name === "subagent_interrupt"),
      true,
    );
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set(
        "a1",
        makeRunning({
          id: "a1",
          name: "Worker",
          surface: "a1",
          sessionFile: "a1.jsonl",
        }),
      );
      runningMap.set(
        "b2",
        makeRunning({
          id: "b2",
          name: "Worker",
          surface: "b2",
          sessionFile: "b2.jsonl",
        }),
      );
      runningMap.set(
        "c3",
        makeRunning({
          id: "c3",
          name: "Scout",
          surface: "c3",
          sessionFile: "c3.jsonl",
        }),
      );

      const byId = testApi.resolveRunningTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveRunningTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
          throw new Error("mux write failed");
        }),
      );

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(
        classifyStatus(runningMap.get("a1").statusState, 20_000).kind,
        "active",
      );
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(
      running,
      (surface: string) => {
        sentSurface = surface;
      },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        runningMap.set(
          "a1",
          makeRunning({
            activityFile,
            statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
          }),
        );

        withMockedNow(20_000, () =>
          testApi.handleSubagentInterrupt(
            { name: "Worker" },
            (surface: string) => {
              sentSurface = surface;
            },
          ),
        );

        assert.equal(sentSurface, "pane-1");
        const state = runningMap.get("a1").statusState;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivityAtMs, 20_000);
        assert.equal(state.lastActivitySequence, 7);
        assert.equal(state.localOverrideSequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () =>
        testApi.handleSubagentInterrupt(
          { name: "Worker" },
          (surface: string) => {
            sentSurface = surface;
          },
        ),
      );

      assert.equal(sentSurface, "pane-1");
      assert.equal(
        result.content[0].text,
        'Interrupt requested for subagent "Worker".',
      );
      assert.deepEqual(result.details, {
        id: "a1",
        name: "Worker",
        status: "interrupt_requested",
      });
      const snapshot = classifyStatus(runningMap.get("a1").statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
      assert.equal(runningMap.get("a1").interruptRequested, true);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape again for repeated interrupt requests", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });
      testApi.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
        surfaces.push(surface);
      });

      assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
      assert.equal(runningMap.has("a1"), true);
    } finally {
      runningMap.clear();
    }
  });

  it("rejects Claude-backed interrupt requests before delivery", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let delivered = false;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ cli: "claude" }));

      const result = testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        delivered = true;
      });

      assert.equal(delivered, false);
      assert.match(
        result.content[0].text,
        /currently supported only for Pi-backed subagents/i,
      );
      assert.deepEqual(result.details, {
        error: "claude interrupt unsupported",
        id: "a1",
        name: "Worker",
      });
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(
      presentation,
      /Error: Anthropic 529 Overloaded after 3 retries/,
    );
    assert.match(presentation, /subagent_message/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(
      rendererEntry,
      "expected subagent_status renderer to be registered",
    );

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(
        output,
        new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find(
      (entry) => entry.name === "subagent_status",
    );
    assert.ok(
      rendererEntry,
      "expected subagent_status renderer to be registered",
    );

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: ["Worker running 5m, active (bash 2m)."],
          overflow: 0,
        },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime: 1_000_000 - 13_000,
            sessionFile: "sess1",
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 13_000,
            }),
          },
          {
            id: "a2",
            name: "B",
            task: "",
            surface: "s2",
            startTime: 1_000_000 - 21_000,
            sessionFile: "sess2",
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 21_000,
            }),
          },
          {
            id: "a3",
            name: "C",
            task: "",
            surface: "s3",
            startTime: 1_000_000 - 27_000,
            sessionFile: "sess3",
            statusState: createStatusState({
              source: "pi",
              startTimeMs: 1_000_000 - 27_000,
            }),
          },
        ],
        16,
      );

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            surface: "s1",
            startTime,
            sessionFile: "sess1",
            statusState: createStatusState({
              source: "pi",
              startTimeMs: startTime,
            }),
          },
        ],
        width,
      );

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("parseCmuxFocusedSnapshot", () => {
    it("parses focused surface and pane refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshot({
          focused: { surface_ref: "surface:3", pane_ref: "pane:2" },
        }),
        { surfaceRef: "surface:3", paneRef: "pane:2" },
      );
    });

    it("does not fall back to caller refs", () => {
      assert.equal(
        parseCmuxFocusedSnapshot({
          caller: { surface_ref: "surface:1", pane_ref: "pane:1" },
        }),
        null,
      );
    });

    it("returns null for malformed values", () => {
      assert.equal(parseCmuxFocusedSnapshot(null), null);
      assert.equal(parseCmuxFocusedSnapshot({ focused: {} }), null);
    });
  });

  describe("parseCmuxJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxJson("not json"), null);
    });

    it("parses valid JSON text", () => {
      assert.deepEqual(parseCmuxJson('{"ok":true}'), { ok: true });
    });
  });

  describe("parseCmuxFocusedSnapshotFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxFocusedSnapshotFromJson("not json"), null);
    });

    it("returns null when focused is absent or not an object", () => {
      assert.equal(
        parseCmuxFocusedSnapshotFromJson(
          '{"focused":null,"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}',
        ),
        null,
      );
      assert.equal(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}',
        ),
        null,
      );
    });

    it("parses focused refs without falling back to caller refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"},"focused":{"surface_ref":"surface:2","pane_ref":"pane:3"}}',
        ),
        { surfaceRef: "surface:2", paneRef: "pane:3" },
      );
    });
  });

  describe("parseCmuxPaneRefForSurface", () => {
    it("parses top-level pane refs for a surface", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { surface_ref: "surface:7", pane_ref: "pane:4" },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("parses caller pane refs for identify --surface output", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { caller: { surface_ref: "surface:7", pane_ref: "pane:4" } },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("returns null when the surface does not match", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { surface_ref: "surface:8", pane_ref: "pane:4" },
          "surface:7",
        ),
        null,
      );
    });
  });

  describe("parseCmuxPaneRefForSurfaceFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson("not json", "surface:7"),
        null,
      );
    });

    it("parses caller refs from cmux identify --surface JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson(
          '{"caller":{"surface_ref":"surface:7","pane_ref":"pane:4"}}',
          "surface:7",
        ),
        "pane:4",
      );
    });
  });

  describe("zellij placement", () => {
    const pane = (overrides: any) => ({
      id: 1,
      is_plugin: false,
      is_floating: false,
      is_selectable: true,
      exited: false,
      pane_rows: 20,
      pane_columns: 80,
      tab_id: 1,
      ...overrides,
    });

    it("matches Zellij direction and minimum split rules", () => {
      assert.equal(
        predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 11 })),
        "right",
      );
      assert.equal(
        predictZellijSplitDirection(pane({ pane_rows: 11, pane_columns: 5 })),
        "down",
      );
      assert.equal(
        predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 10 })),
        null,
      );
      assert.equal(
        predictZellijSplitDirection(pane({ pane_rows: 4, pane_columns: 80 })),
        null,
      );

      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 11 })),
        true,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 11, pane_columns: 5 })),
        true,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 10 })),
        false,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 4, pane_columns: 80 })),
        false,
      );

      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 100 }), 80, 20),
        false,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 45, pane_columns: 100 }), 80, 20),
        true,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 170 }), 80, 20),
        true,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 47 }), 50, 10),
        false,
      );
      assert.equal(
        canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 77 }), 50, 10),
        true,
      );
    });

    it("uses tab-scoped split only when all Zellij split candidates are safe", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 40, pane_columns: 120 }),
          pane({ id: 11, tab_id: 1, pane_rows: 120, pane_columns: 100 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "split",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
        splitDirection: "down",
      });
    });

    it("stacks when any Zellij split candidate would fall below Pi's configured minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 100, pane_columns: 47 }),
          pane({ id: 11, tab_id: 1, pane_rows: 31, pane_columns: 77 }),
        ],
        10,
        50,
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("stacks when Zellij would split a pane below Pi's usable minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 20, pane_columns: 20 }),
          pane({ id: 11, tab_id: 1, pane_rows: 18, pane_columns: 60 }),
          pane({ id: 12, tab_id: 1, pane_rows: 10, pane_columns: 70 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("never chooses the parent pane as the stack target", () => {
      const plan = selectZellijStackPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 }),
          pane({ id: 11, tab_id: 1, pane_rows: 10, pane_columns: 20 }),
          pane({ id: 12, tab_id: 1, pane_rows: 8, pane_columns: 30 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 12,
        targetPaneId: 12,
        tabId: 1,
      });
    });

    it("does not stack when the only usable pane is the parent", () => {
      const plan = selectZellijStackPlacement(
        [pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 })],
        10,
      );

      assert.equal(plan, null);
    });

    it("stacks on the largest usable non-parent pane when none can split", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 6, pane_columns: 8 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("ignores floating, plugin, exited, unselectable, and other-tab panes", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({
            id: 11,
            tab_id: 1,
            pane_rows: 60,
            pane_columns: 200,
            is_floating: true,
          }),
          pane({
            id: 12,
            tab_id: 1,
            pane_rows: 60,
            pane_columns: 200,
            is_plugin: true,
          }),
          pane({
            id: 13,
            tab_id: 1,
            pane_rows: 60,
            pane_columns: 200,
            exited: true,
          }),
          pane({
            id: 14,
            tab_id: 1,
            pane_rows: 60,
            pane_columns: 200,
            is_selectable: false,
          }),
          pane({ id: 15, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.equal(plan, null);
    });

    it("returns null when the parent pane cannot be found", () => {
      assert.equal(selectZellijPlacement([pane({ id: 10 })], 99), null);
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isWezTermAvailable", () => {
    it("returns boolean based on WEZTERM_UNIX_SOCKET", () => {
      const result = isWezTermAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isHerdrAvailable", () => {
    it("returns boolean based on herdr env markers", () => {
      const result = isHerdrAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("parseHerdrPaneId", () => {
    it("extracts pane ids from pane split output", () => {
      const output = JSON.stringify({
        id: "cli:pane:split",
        result: {
          pane: { pane_id: "w1:pB", tab_id: "w1:t1" },
          type: "pane_info",
        },
      });
      assert.equal(parseHerdrPaneId(output, "pane split"), "w1:pB");
    });

    it("extracts pane ids from tab create output", () => {
      const output = JSON.stringify({
        id: "cli:tab:create",
        result: {
          root_pane: { pane_id: "w2:p1", tab_id: "w2:t1" },
          tab: { tab_id: "w2:t1" },
          type: "tab_created",
        },
      });
      assert.equal(parseHerdrPaneId(output, "tab create"), "w2:p1");
    });

    it("throws on malformed output", () => {
      assert.throws(
        () => parseHerdrPaneId("not json", "pane split"),
        /Unexpected herdr/,
      );
      assert.throws(
        () =>
          parseHerdrPaneId(
            JSON.stringify({ result: { pane: {} } }),
            "pane split",
          ),
        /Unexpected herdr/,
      );
      assert.throws(
        () => parseHerdrPaneId("", "tab create"),
        /Unexpected herdr/,
      );
    });
  });

  describe("herdr balanced layout", () => {
    const PARENT = "w1:p1";
    const C1 = "w1:p2";
    const C2 = "w1:p3";
    const C3 = "w1:p4";

    interface FixtureSplit {
      id: string;
      direction: "right" | "down";
      ratio: number;
      rect: { x: number; y: number; width: number; height: number };
    }

    /** Layout shaped like `herdr pane layout` output for a right-nested split row. */
    function makeLayout(
      totalWidth: number,
      panes: Array<{
        pane_id: string;
        x: number;
        width: number;
        height?: number;
        y?: number;
      }>,
      splits: FixtureSplit[] = [],
    ) {
      return parseHerdrLayout(
        JSON.stringify({
          id: "cli:pane:layout",
          result: {
            type: "pane_layout",
            layout: {
              area: { x: 0, y: 0, width: totalWidth, height: 50 },
              panes: panes.map((p) => ({
                pane_id: p.pane_id,
                rect: {
                  x: p.x,
                  y: p.y ?? 0,
                  width: p.width,
                  height: p.height ?? 50,
                },
              })),
              splits,
              tab_id: "w1:t1",
              zoomed: false,
            },
          },
        }),
      );
    }

    /**
     * Apply planned ops to a split-tree model and return each pane's final
     * width. Verifies the plan converges: herdr moves one divider per op, so
     * we adjust the matched split's ratio (innermost split containing the
     * anchor pane on the operated side), then propagate widths top-down.
     */
    function simulateFinalWidths(
      layout: NonNullable<ReturnType<typeof parseHerdrLayout>>,
      ops: ReturnType<typeof planHerdrRebalance>,
    ): Map<string, number> {
      const ratios = new Map(layout.splits.map((s) => [s.id, s.ratio]));
      const sides = new Map<string, { left: string[]; right: string[] }>();
      for (const s of layout.splits) {
        const divX = s.rect.x + s.rect.width * s.ratio;
        sides.set(s.id, {
          left: layout.panes
            .filter(
              (p) =>
                p.rect.x >= s.rect.x - 1.5 &&
                p.rect.x + p.rect.width <= divX + 1.5 &&
                p.rect.y >= s.rect.y - 1.5 &&
                p.rect.y + p.rect.height <= s.rect.y + s.rect.height + 1.5,
            )
            .map((p) => p.pane_id),
          right: layout.panes
            .filter(
              (p) =>
                p.rect.x >= divX - 1.5 &&
                p.rect.x + p.rect.width <= s.rect.x + s.rect.width + 1.5 &&
                p.rect.y >= s.rect.y - 1.5 &&
                p.rect.y + p.rect.height <= s.rect.y + s.rect.height + 1.5,
            )
            .map((p) => p.pane_id),
        });
      }
      for (const op of ops) {
        let best: (typeof layout.splits)[number] | null = null;
        let bestArea = Infinity;
        for (const s of layout.splits) {
          const side = sides.get(s.id)!;
          const onSide =
            op.direction === "right"
              ? side.left.includes(op.paneId)
              : side.right.includes(op.paneId);
          if (!onSide) continue;
          const area = s.rect.width * s.rect.height;
          if (area < bestArea) {
            best = s;
            bestArea = area;
          }
        }
        assert.ok(best, `no split matched op ${JSON.stringify(op)}`);
        const cur = ratios.get(best?.id)!;
        ratios.set(
          best?.id,
          op.direction === "right" ? cur + op.amount : cur - op.amount,
        );
      }
      const widths = new Map<string, number>();
      for (const leaf of layout.panes) {
        const chain = layout.splits
          .filter(
            (s) =>
              leaf.rect.x >= s.rect.x - 1.5 &&
              leaf.rect.x + leaf.rect.width <= s.rect.x + s.rect.width + 1.5 &&
              leaf.rect.y >= s.rect.y - 1.5 &&
              leaf.rect.y + leaf.rect.height <= s.rect.y + s.rect.height + 1.5,
          )
          .sort(
            (a, b) =>
              b.rect.width * b.rect.height - a.rect.width * a.rect.height,
          );
        let width = layout.area.width;
        for (const s of chain) {
          const ratio = ratios.get(s.id)!;
          const center = leaf.rect.x + leaf.rect.width / 2;
          const divX = s.rect.x + s.rect.width * s.ratio;
          width *= center <= divX ? ratio : 1 - ratio;
        }
        widths.set(leaf.pane_id, width);
      }
      return widths;
    }

    it("parses herdr pane layout output", () => {
      const layout = makeLayout(393, [{ pane_id: PARENT, x: 0, width: 393 }]);
      assert.ok(layout);
      assert.equal(layout.area.width, 393);
      assert.equal(layout.panes.length, 1);
      assert.equal(layout.panes[0].pane_id, PARENT);
    });

    it("returns null for malformed layout output", () => {
      assert.equal(parseHerdrLayout("not json"), null);
      assert.equal(parseHerdrLayout(JSON.stringify({ result: {} })), null);
    });

    it("grows the parent into its region share after the first spawn", () => {
      // Right after the first spawn the parent holds half the group region;
      // rebalancing moves it to the configured 0.4 share.
      setHerdrSubagentPaneList([C1]);
      const layout = makeLayout(
        393,
        [
          { pane_id: PARENT, x: 0, width: 197 },
          { pane_id: C1, x: 197, width: 196 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 197 / 393,
            rect: { x: 0, y: 0, width: 393, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      // Root split's left subtree is just the parent (0.501 of the tab);
      // shrink it to 0.4 by moving the divider left, anchored on C1.
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, C1);
      assert.equal(ops[0].direction, "left");
      assert.ok(Math.abs(ops[0].amount - (197 / 393 - 0.4)) < 1e-9);
    });

    it("balances an unbalanced inner divider via the left neighbor", () => {
      setHerdrSubagentPaneList([C1, C2]);
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 100 },
          { pane_id: C2, x: 260, width: 140 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 100 / 240,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      // Cell 1 holds 100/240 of the region but should hold 1/2 — grow it by
      // moving its own right divider (direction right, anchored on C1).
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, C1);
      assert.equal(ops[0].direction, "right");
      assert.ok(Math.abs(ops[0].amount - (1 / 2 - 100 / 240)) < 0.005);
    });

    it("emits no ops when the layout is already balanced", () => {
      setHerdrSubagentPaneList([C1, C2]);
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 120 },
          { pane_id: C2, x: 280, width: 120 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.5,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("leaves legacy degenerate layouts untouched (coincident dividers)", () => {
      // Reproduces the old "split the parent every time" mess: nested splits
      // put p7's right edge against BOTH the inner split (SC) and the root
      // divider at x=157. Resizing p7 is ambiguous - herdr could move either
      // divider - so the planner must bail rather than guess and possibly
      // shrink the parent. New code never creates this shape.
      setHerdrSubagentPaneList([
        "w1:p5",
        "w1:p6",
        "w1:p7",
        "w1:p2",
        "w1:p3",
        "w1:p4",
      ]);
      const leaves = [
        { pane_id: PARENT, x: 0, width: 140 },
        { pane_id: "w1:p5", x: 140, width: 5 },
        { pane_id: "w1:p6", x: 145, width: 6 },
        { pane_id: "w1:p7", x: 151, width: 6 },
        { pane_id: "w1:p2", x: 157, width: 165 },
        { pane_id: "w1:p3", x: 322, width: 36 },
        { pane_id: "w1:p4", x: 358, width: 35 },
      ];
      const layout = makeLayout(393, leaves, [
        {
          id: "root",
          direction: "right",
          ratio: 157 / 393,
          rect: { x: 0, y: 0, width: 393, height: 50 },
        },
        {
          id: "A",
          direction: "right",
          ratio: 140 / 157,
          rect: { x: 0, y: 0, width: 157, height: 50 },
        },
        {
          id: "SA",
          direction: "right",
          ratio: 5 / 17,
          rect: { x: 140, y: 0, width: 17, height: 50 },
        },
        {
          id: "SB",
          direction: "right",
          ratio: 6 / 12,
          rect: { x: 145, y: 0, width: 12, height: 50 },
        },
        {
          id: "SC",
          direction: "right",
          ratio: 6 / 242,
          rect: { x: 151, y: 0, width: 242, height: 50 },
        },
        {
          id: "B1",
          direction: "right",
          ratio: 165 / 236,
          rect: { x: 157, y: 0, width: 236, height: 50 },
        },
        {
          id: "B2",
          direction: "right",
          ratio: 36 / 71,
          rect: { x: 322, y: 0, width: 71, height: 50 },
        },
      ]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("balances a clean four-cell tree of nested splits", () => {
      // The shape this extension actually produces: root [parent | row] with
      // row cells nested right. Targets: parent 40%, four equal cells.
      setHerdrSubagentPaneList([C1, C2, C3, "w1:p6"]);
      const leaves = [
        { pane_id: PARENT, x: 0, width: 98 },
        { pane_id: C1, x: 98, width: 98 },
        { pane_id: C2, x: 196, width: 98 },
        { pane_id: C3, x: 294, width: 49 },
        { pane_id: "w1:p6", x: 343, width: 50 },
      ];
      const layout = makeLayout(393, leaves, [
        {
          id: "root",
          direction: "right",
          ratio: 98 / 393,
          rect: { x: 0, y: 0, width: 393, height: 50 },
        },
        {
          id: "s1",
          direction: "right",
          ratio: 98 / 295,
          rect: { x: 98, y: 0, width: 295, height: 50 },
        },
        {
          id: "s2",
          direction: "right",
          ratio: 98 / 197,
          rect: { x: 196, y: 0, width: 197, height: 50 },
        },
        {
          id: "s3",
          direction: "right",
          ratio: 49 / 99,
          rect: { x: 294, y: 0, width: 99, height: 50 },
        },
      ]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.ok(ops.length > 0);
      const widths = simulateFinalWidths(layout!, ops);
      const parentTarget = 0.4 * 393;
      assert.ok(
        Math.abs(widths.get(PARENT)! - parentTarget) < 1.5,
        `parent ${widths.get(PARENT)}`,
      );
      const cellTarget = (393 - parentTarget) / 4;
      for (const cell of [C1, C2, C3, "w1:p6"]) {
        assert.ok(
          Math.abs(widths.get(cell)! - cellTarget) < 1.5,
          `cell ${cell} = ${widths.get(cell)}, want ~${cellTarget}`,
        );
      }
    });

    it("freezes panes that are not column cells (partial height)", () => {
      // A user-made stacked log pane below the first cell must keep its width
      // and its down-split untouched.
      setHerdrSubagentPaneList([C1]);
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 160 },
          { pane_id: C1, x: 160, width: 120, height: 30 },
          { pane_id: "w1:log", x: 160, y: 30, width: 120, height: 20 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "down",
            ratio: 0.6,
            rect: { x: 160, y: 0, width: 240, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("bails out when balanced cells cannot fit", () => {
      // Parent 300 + a frozen stacked pane of 236 columns leaves nothing to
      // balance into (remaining = 400 - 160 - 236 = 4).
      setHerdrSubagentPaneList([C1, C2]);
      const layout = makeLayout(
        400,
        [
          { pane_id: PARENT, x: 0, width: 300 },
          { pane_id: C1, x: 300, width: 50, height: 30 },
          { pane_id: C2, x: 350, width: 50, height: 30 },
          { pane_id: "w1:log", x: 300, y: 30, width: 236, height: 20 },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.75,
            rect: { x: 0, y: 0, width: 400, height: 50 },
          },
          {
            id: "s1",
            direction: "down",
            ratio: 0.6,
            rect: { x: 300, y: 0, width: 100, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("returns no ops when the parent pane is missing from the layout", () => {
      const layout = makeLayout(400, [{ pane_id: C1, x: 0, width: 400 }]);
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("shared tab, parent on the left: never touches the foreign pane", () => {
      // Two agents share the tab: [parent 134][foreign 134]. After the first
      // spawn the group region is just the parent's own panel — the foreign
      // agent pane must keep its width.
      setHerdrSubagentPaneList([C1]);
      const layout = makeLayout(
        268,
        [
          { pane_id: PARENT, x: 0, width: 67 },
          { pane_id: C1, x: 67, width: 67 },
          { pane_id: "w1:foreign", x: 134, width: 134 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      // One op inside the group's own split subtree: parent to 0.4 of 134.
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, C1);
      assert.equal(ops[0].direction, "left");
      assert.ok(Math.abs(ops[0].amount - (0.5 - 0.4)) < 1e-9);
      const widths = simulateFinalWidths(layout!, ops);
      assert.equal(widths.get("w1:foreign"), 134);
      assert.ok(Math.abs(widths.get(PARENT)! - 0.4 * 134) < 1.5);
      assert.ok(Math.abs(widths.get(C1)! - 0.6 * 134) < 1.5);
    });

    it("shared tab, parent on the right: never touches the foreign pane", () => {
      setHerdrSubagentPaneList([C1]);
      const layout = makeLayout(
        268,
        [
          { pane_id: "w1:foreign", x: 0, width: 134 },
          { pane_id: PARENT, x: 134, width: 67 },
          { pane_id: C1, x: 201, width: 67 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 134, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      // The root divider (foreign pane | group) must not move — only the
      // group's inner split is rebalanced.
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, C1);
      assert.equal(ops[0].direction, "left");
      assert.ok(Math.abs(ops[0].amount - (0.5 - 0.4)) < 1e-9);
      const widths = simulateFinalWidths(layout!, ops);
      assert.equal(widths.get("w1:foreign"), 134);
      assert.ok(Math.abs(widths.get(PARENT)! - 0.4 * 134) < 1.5);
      assert.ok(Math.abs(widths.get(C1)! - 0.6 * 134) < 1.5);
    });

    it("shared tab: untracked pane right of the parent is not a cell", () => {
      // Without tracking, a foreign pane right of the parent used to be
      // treated as a subagent column and split/resized. Now cells are
      // tracked-only, so nothing balances and nothing is touched.
      setHerdrSubagentPaneList([]);
      const layout = makeLayout(
        268,
        [
          { pane_id: PARENT, x: 0, width: 67 },
          { pane_id: C1, x: 67, width: 67 },
          { pane_id: "w1:foreign", x: 134, width: 134 },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "inner",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
        ],
      );
      const ops = planHerdrRebalance(layout!, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });
  });

  describe("tmux balanced layout", () => {
    const PARENT = "%0";
    const C1 = "%1";
    const C2 = "%2";

    function makePanes(
      windowWidth: number,
      panes: Array<{
        paneId: string;
        left: number;
        width: number;
        height?: number;
        top?: number;
      }>,
      windowHeight = 50,
    ) {
      return panes.map((p) => ({
        paneId: p.paneId,
        left: p.left,
        top: p.top ?? 0,
        width: p.width,
        height: p.height ?? windowHeight,
        windowWidth,
        windowHeight,
      }));
    }

    it("parses tmux list-panes geometry output", () => {
      const output = "%0|0|0|80|50|200|50\n%1|80|0|120|50|200|50\n";
      const panes = parseTmuxPaneGeometry(output);
      assert.equal(panes.length, 2);
      assert.deepEqual(panes[0], {
        paneId: "%0",
        left: 0,
        top: 0,
        width: 80,
        height: 50,
        windowWidth: 200,
        windowHeight: 50,
      });
    });

    it("skips malformed and non-pane lines", () => {
      const panes = parseTmuxPaneGeometry(
        "garbage\n\n%1|80|0|120|50|200|50\nwindow|1|2|3|4|5|5",
      );
      assert.equal(panes.length, 1);
      assert.equal(panes[0].paneId, "%1");
    });

    it("plans parent and equal cell widths from absolute geometry", () => {
      setTmuxSubagentPaneList([C1, C2]);
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: C2, left: 150, width: 50 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 80 },
        { paneId: C1, width: 60 },
        { paneId: C2, width: 60 },
      ]);
    });

    it("emits no ops when already balanced", () => {
      setTmuxSubagentPaneList([C1, C2]);
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: C1, left: 80, width: 60 },
        { paneId: C2, left: 140, width: 60 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("only balances tracked full-height panes right of the parent", () => {
      setTmuxSubagentPaneList([C1, "partial"]);
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: "partial", left: 150, width: 50, height: 30 },
      ]);
      // The partial-height tracked pane is not a column cell, so C1 absorbs
      // the remaining width; untracked panes inside the region bail instead.
      const ops = planTmuxRebalance(panes, PARENT, 0.4);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 80 },
        { paneId: C1, width: 120 },
      ]);
    });

    it("bails when an untracked pane sits inside the region", () => {
      // A user-made pane inside the group region: absolute-width resizes
      // cannot leave room for it, so nothing is balanced.
      setTmuxSubagentPaneList([C1]);
      const panes = makePanes(200, [
        { paneId: PARENT, left: 0, width: 100 },
        { paneId: C1, left: 100, width: 50 },
        { paneId: "lefty", left: 0, width: 100, height: 49 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4);
      assert.equal(ops.length, 0);
    });

    it("shared tab: never touches the foreign pane", () => {
      // Two agents share the window: [parent 67][sub 67][foreign 134]. The
      // group region is the parent's own panel — the foreign pane keeps its
      // width and the parent moves to 0.4 of the region.
      setTmuxSubagentPaneList([C1]);
      const panes = makePanes(268, [
        { paneId: PARENT, left: 0, width: 67 },
        { paneId: C1, left: 67, width: 67 },
        { paneId: "%foreign", left: 134, width: 134 },
      ]);
      const ops = planTmuxRebalance(panes, PARENT, 0.4);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 54 },
        { paneId: C1, width: 80 },
      ]);
    });

    it("bails out when cells cannot fit", () => {
      // Parent target 18 of 20 leaves 2 columns for two cells — fewer than
      // the two columns per cell the planner requires.
      setTmuxSubagentPaneList([C1, C2]);
      const panes = makePanes(20, [
        { paneId: PARENT, left: 0, width: 18 },
        { paneId: C1, left: 18, width: 1 },
        { paneId: C2, left: 19, width: 1 },
      ]);
      assert.equal(planTmuxRebalance(panes, PARENT, 0.9).length, 0);
    });

    it("returns no ops when the parent pane is missing", () => {
      const panes = makePanes(200, [{ paneId: C1, left: 0, width: 200 }]);
      assert.equal(planTmuxRebalance(panes, PARENT, 0.4).length, 0);
    });
  });
});

describe("cmux.ts rightmostAnchor", () => {
  // Full-height column-shaped panes of the columns-mode layout.
  const rect = (x: number, y = 0) => ({ x, y, width: 67, height: 50 });

  it("picks the rightmost tracked pane at or right of the parent's edge", () => {
    const placed = [
      { paneId: "%1", rect: rect(67) },
      { paneId: "%2", rect: rect(134) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
  });

  it("prefers the bottommost pane, then the rightmost, on ties", () => {
    // Columns-mode panes are full-height (same y), so the y tie-break only
    // decides odd layouts: the anchor is max y, then max x.
    const placed = [
      { paneId: "%1", rect: rect(67, 0) },
      { paneId: "%2", rect: rect(134, 25) },
      { paneId: "%3", rect: rect(134, 0) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
  });

  it("ignores tracked panes left of the parent's right edge", () => {
    const placed = [
      { paneId: "%1", rect: rect(0) },
      { paneId: "%2", rect: rect(67) },
    ];
    assert.equal(rightmostAnchor(placed, 67), "%2");
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(0) }], 67), null);
  });

  it("accepts a pane flush against the parent within 1 cell", () => {
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(66) }], 67), "%1");
    assert.equal(rightmostAnchor([{ paneId: "%1", rect: rect(65) }], 67), null);
  });

  it("returns null when nothing is placed", () => {
    assert.equal(rightmostAnchor([], 67), null);
  });
});

describe("tiled grid layout", () => {
  describe("gridDimsForCount", () => {
    it("picks ceil(sqrt(n)) columns and fills row-major", () => {
      assert.deepEqual(gridDimsForCount(1), { cols: 1, rows: 1 });
      assert.deepEqual(gridDimsForCount(2), { cols: 2, rows: 1 });
      assert.deepEqual(gridDimsForCount(3), { cols: 2, rows: 2 });
      assert.deepEqual(gridDimsForCount(4), { cols: 2, rows: 2 });
      assert.deepEqual(gridDimsForCount(5), { cols: 3, rows: 2 });
      assert.deepEqual(gridDimsForCount(6), { cols: 3, rows: 2 });
      assert.deepEqual(gridDimsForCount(7), { cols: 3, rows: 3 });
      assert.deepEqual(gridDimsForCount(9), { cols: 3, rows: 3 });
    });

    it("clamps degenerate inputs", () => {
      assert.deepEqual(gridDimsForCount(0), { cols: 1, rows: 1 });
      assert.deepEqual(gridDimsForCount(-3), { cols: 1, rows: 1 });
    });
  });

  describe("planGridTargets", () => {
    it("assigns the parent a left strip and equal row-major cells", () => {
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.parentRect, {
        x: 0,
        y: 0,
        width: 80,
        height: 50,
      });
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 140,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%4"), {
        x: 140,
        y: 25,
        width: 60,
        height: 25,
      });
    });

    it("returns null with no panes", () => {
      assert.equal(
        planGridTargets([], { x: 0, y: 0, width: 200, height: 50 }, 0.4),
        null,
      );
    });

    it("returns null when cells would be too small", () => {
      assert.equal(
        planGridTargets(
          ["%1", "%2", "%3", "%4"],
          { x: 0, y: 0, width: 30, height: 10 },
          0.4,
        ),
        null,
      );
    });

    it("absorbs the unclaimed cell below when the grid just grew a row", () => {
      // 3 panes in a 2×2 grid: pane 2 (top-right) stretches over the empty
      // bottom-right cell; pane 3 keeps a single bottom-left cell.
      const targets = planGridTargets(
        ["%1", "%2", "%3"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 60,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 140,
        y: 0,
        width: 60,
        height: 50,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 60,
        height: 25,
      });
    });

    it("absorbs the unclaimed cell beside when the grid just grew a column", () => {
      // 5 panes in a 2×3 grid: pane 4 (bottom-middle) stretches over the empty
      // bottom-right cell; panes 1–3 and 5 keep single cells.
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4", "%5"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      assert.deepEqual(targets.cells.get("%1"), {
        x: 80,
        y: 0,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%2"), {
        x: 120,
        y: 0,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%3"), {
        x: 80,
        y: 25,
        width: 40,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%4"), {
        x: 120,
        y: 25,
        width: 80,
        height: 25,
      });
      assert.deepEqual(targets.cells.get("%5"), {
        x: 160,
        y: 0,
        width: 40,
        height: 25,
      });
    });

    it("keeps every pane in the cell it was spawned into as the grid grows", () => {
      // 6 panes exactly fill the 2×3 grid; all cells are single-cell.
      const targets = planGridTargets(
        ["%1", "%2", "%3", "%4", "%5", "%6"],
        { x: 0, y: 0, width: 200, height: 50 },
        0.4,
      );
      assert.ok(targets);
      const paneIds = ["%1", "%2", "%3", "%4", "%5", "%6"];
      const expected = [
        { x: 80, y: 0, width: 40, height: 25 },
        { x: 120, y: 0, width: 40, height: 25 },
        { x: 80, y: 25, width: 40, height: 25 },
        { x: 120, y: 25, width: 40, height: 25 },
        { x: 160, y: 0, width: 40, height: 25 },
        { x: 160, y: 25, width: 40, height: 25 },
      ];
      for (const [i, paneId] of paneIds.entries()) {
        assert.deepEqual(targets.cells.get(paneId), expected[i], paneId);
      }
    });
  });

  describe("selectTiledGridAnchor", () => {
    // Region right of a 0.4 parent in a 200×50 tab: x 80..200, full height.
    const REGION = { x: 80, y: 0, width: 120, height: 50 };

    it("returns null when nothing is placed yet or count is not growing", () => {
      assert.equal(selectTiledGridAnchor([], REGION, 1), null);
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.equal(selectTiledGridAnchor(placed, REGION, 1), null);
    });

    it("returns null when the region is too small for the grid", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.equal(
        selectTiledGridAnchor(
          placed,
          { x: 80, y: 0, width: 30, height: 50 },
          9,
        ),
        null,
      );
    });

    it("splits the lone full pane right for subagent 2", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 2), {
        anchorPaneId: "%1",
        direction: "right",
      });
    });

    it("splits down for subagent 3 (start of the second row)", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 120, height: 50 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 3), {
        anchorPaneId: "%1",
        direction: "down",
      });
    });

    it("completes the 2×2 grid for subagent 4 via a down split", () => {
      // After 3 panes: top-left, bottom-left, and a full-height right column.
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 60, height: 25 } },
        { paneId: "%2", rect: { x: 140, y: 0, width: 60, height: 50 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 60, height: 25 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 4), {
        anchorPaneId: "%2",
        direction: "down",
      });
    });

    it("grows a third column for subagent 5 on a full 2×2 grid", () => {
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 60, height: 25 } },
        { paneId: "%2", rect: { x: 140, y: 0, width: 60, height: 25 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 60, height: 25 } },
        { paneId: "%4", rect: { x: 140, y: 25, width: 60, height: 25 } },
      ];
      // Growth spawn: pane 5 claims the new column's top cell, carved out of
      // the pane beside the region's right edge (%2).
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 5), {
        anchorPaneId: "%2",
        direction: "right",
      });
    });

    it("fills the new column's bottom cell for subagent 6", () => {
      // After 5 panes: the bottom-right pane stretches across two cells.
      const placed = [
        { paneId: "%1", rect: { x: 80, y: 0, width: 40, height: 25 } },
        { paneId: "%2", rect: { x: 120, y: 0, width: 40, height: 25 } },
        { paneId: "%5", rect: { x: 160, y: 0, width: 40, height: 25 } },
        { paneId: "%3", rect: { x: 80, y: 25, width: 40, height: 25 } },
        { paneId: "%4", rect: { x: 120, y: 25, width: 80, height: 25 } },
      ];
      assert.deepEqual(selectTiledGridAnchor(placed, REGION, 6), {
        anchorPaneId: "%4",
        direction: "right",
      });
    });
  });

  describe("planHerdrGridRebalance", () => {
    const PARENT = "%0";

    function makeGridLayout(
      panes: Array<{
        pane_id: string;
        rect: { x: number; y: number; width: number; height: number };
      }>,
      splits: Array<{
        id: string;
        direction: "right" | "down";
        ratio: number;
        rect: { x: number; y: number; width: number; height: number };
      }>,
      areaWidth = 200,
    ) {
      return {
        area: { x: 0, y: 0, width: areaWidth, height: 50 },
        panes,
        splits,
        tab_id: "w1:t1",
        zoomed: false,
      } as any;
    }

    function quadrantLayout(ratioColSplit: number) {
      // 2×2 grid: parent | col A (S1 over S3) | col B (S2 over S4)
      const colARight = 80 + 120 * ratioColSplit;
      return makeGridLayout(
        [
          { pane_id: PARENT, rect: { x: 0, y: 0, width: 80, height: 50 } },
          {
            pane_id: "%1",
            rect: { x: 80, y: 0, width: colARight - 80, height: 25 },
          },
          {
            pane_id: "%3",
            rect: { x: 80, y: 25, width: colARight - 80, height: 25 },
          },
          {
            pane_id: "%2",
            rect: { x: colARight, y: 0, width: 200 - colARight, height: 25 },
          },
          {
            pane_id: "%4",
            rect: { x: colARight, y: 25, width: 200 - colARight, height: 25 },
          },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 200, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: ratioColSplit,
            rect: { x: 80, y: 0, width: 120, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.5,
            rect: { x: 80, y: 0, width: colARight - 80, height: 50 },
          },
          {
            id: "s3",
            direction: "down",
            ratio: 0.5,
            rect: { x: colARight, y: 0, width: 200 - colARight, height: 50 },
          },
        ],
      );
    }

    it("emits no ops when the 2×2 grid is already balanced", () => {
      const layout = quadrantLayout(0.5);
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 0);
    });

    it("evens out unbalanced columns without touching a correct parent strip", () => {
      // Column split at 0.6: left column too wide (72), right too narrow (48);
      // parent is already at its 0.4 target, so no parent op is emitted.
      const layout = quadrantLayout(0.6);
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, "%2");
      assert.equal(ops[0].direction, "left");
      assert.ok(Math.abs(ops[0].amount - 0.1) < 1e-9);
    });

    it("emits a vertical up op for an unbalanced row divider", () => {
      // Masonry after 3 spawns: S1a over S3 on the left, full-height S2 right.
      // Parent strip and column split are already at target; only the row
      // divider (ratio 0.6, y=30) needs to move to 0.5 (y=25).
      const layout = makeGridLayout(
        [
          { pane_id: PARENT, rect: { x: 0, y: 0, width: 80, height: 50 } },
          { pane_id: "%1", rect: { x: 80, y: 0, width: 60, height: 30 } },
          { pane_id: "%3", rect: { x: 80, y: 30, width: 60, height: 20 } },
          { pane_id: "%2", rect: { x: 140, y: 0, width: 60, height: 50 } },
        ],
        [
          {
            id: "s0",
            direction: "right",
            ratio: 0.4,
            rect: { x: 0, y: 0, width: 200, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.5,
            rect: { x: 80, y: 0, width: 120, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.6,
            rect: { x: 80, y: 0, width: 60, height: 50 },
          },
        ],
      );
      const ops = planHerdrGridRebalance(
        layout,
        PARENT,
        ["%1", "%2", "%3"],
        0.4,
      );
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, "%3");
      assert.equal(ops[0].direction, "up");
      assert.ok(Math.abs(ops[0].amount - 0.1) < 1e-9);
    });

    it("freezes untracked panes and returns no ops for an empty grid", () => {
      const layout = quadrantLayout(0.5);
      assert.equal(planHerdrGridRebalance(layout, PARENT, [], 0.4).length, 0);
    });

    it("shared tab: grid ops stay inside the group region", () => {
      // Two agents share the tab: foreign pane [0..134], group grid packed
      // into the parent's own panel [134..268]. The root split (foreign |.
      // group) is outside the region and must never be walked.
      const layout = makeGridLayout(
        [
          {
            pane_id: "w1:foreign",
            rect: { x: 0, y: 0, width: 134, height: 50 },
          },
          { pane_id: PARENT, rect: { x: 134, y: 0, width: 54, height: 50 } },
          { pane_id: "%1", rect: { x: 188, y: 0, width: 48, height: 25 } },
          { pane_id: "%3", rect: { x: 188, y: 25, width: 48, height: 25 } },
          { pane_id: "%2", rect: { x: 236, y: 0, width: 32, height: 25 } },
          { pane_id: "%4", rect: { x: 236, y: 25, width: 32, height: 25 } },
        ],
        [
          {
            id: "root",
            direction: "right",
            ratio: 0.5,
            rect: { x: 0, y: 0, width: 268, height: 50 },
          },
          {
            id: "s0",
            direction: "right",
            ratio: 54 / 134,
            rect: { x: 134, y: 0, width: 134, height: 50 },
          },
          {
            id: "s1",
            direction: "right",
            ratio: 0.6,
            rect: { x: 188, y: 0, width: 80, height: 50 },
          },
          {
            id: "s2",
            direction: "down",
            ratio: 0.5,
            rect: { x: 188, y: 0, width: 48, height: 50 },
          },
          {
            id: "s3",
            direction: "down",
            ratio: 0.5,
            rect: { x: 236, y: 0, width: 32, height: 50 },
          },
        ],
        268,
      );
      const ops = planHerdrGridRebalance(
        layout as any,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      // Only the group's column divider moves; the root split (and with it
      // the foreign pane) is untouched.
      assert.equal(ops.length, 1);
      assert.equal(ops[0].paneId, "%2");
      assert.equal(ops[0].direction, "left");
      assert.ok(Math.abs(ops[0].amount - 0.1) < 1e-9);
    });
  });

  describe("planTmuxGridRebalance", () => {
    const PARENT = "%0";

    function makePanes2D(
      windowWidth: number,
      windowHeight: number,
      panes: Array<{
        paneId: string;
        left: number;
        top?: number;
        width: number;
        height?: number;
      }>,
    ) {
      return panes.map((p) => ({
        paneId: p.paneId,
        left: p.left,
        top: p.top ?? 0,
        width: p.width,
        height: p.height ?? windowHeight,
        windowWidth,
        windowHeight,
      }));
    }

    it("emits no ops when the 2×2 grid is already balanced", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 60, height: 25 },
        { paneId: "%2", left: 140, width: 60, height: 25 },
        { paneId: "%3", left: 80, top: 25, width: 60, height: 25 },
        { paneId: "%4", left: 140, top: 25, width: 60, height: 25 },
      ]);
      const ops = planTmuxGridRebalance(
        panes,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.equal(ops.length, 0);
    });

    it("plans width and height ops toward equal cells", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 70, height: 30 },
        { paneId: "%2", left: 150, width: 50, height: 30 },
        { paneId: "%3", left: 80, top: 30, width: 70, height: 20 },
        { paneId: "%4", left: 150, top: 30, width: 50, height: 20 },
      ]);
      const ops = planTmuxGridRebalance(
        panes,
        PARENT,
        ["%1", "%2", "%3", "%4"],
        0.4,
      );
      assert.deepEqual(ops, [
        { paneId: "%1", width: 60, height: 25 },
        { paneId: "%2", width: 60, height: 25 },
        { paneId: "%3", width: 60, height: 25 },
        { paneId: "%4", width: 60, height: 25 },
      ]);
    });

    it("skips the masonry pane that runs to the region's bottom edge", () => {
      // 3 panes: two stacked on the left, one full-height on the right — the
      // tall pane's height target would shrink it toward the window edge.
      const panes = makePanes2D(200, 50, [
        { paneId: PARENT, left: 0, width: 80 },
        { paneId: "%1", left: 80, width: 60, height: 25 },
        { paneId: "%2", left: 140, width: 60 },
        { paneId: "%3", left: 80, top: 25, width: 60, height: 25 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1", "%2", "%3"], 0.4);
      assert.equal(ops.length, 0);
    });

    it("shared tab: rebalances inside the region and leaves foreign panes alone", () => {
      // Two agents share the window: [parent 96][sub 72][foreign 72]. The
      // foreign pane used to bail the whole rebalance; now the group only
      // claims its own panel [0..168] and %9 is not ours to care about.
      const panes = makePanes2D(240, 50, [
        { paneId: PARENT, left: 0, width: 96 },
        { paneId: "%1", left: 96, width: 72 },
        { paneId: "%9", left: 168, width: 72 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4);
      assert.deepEqual(ops, [
        { paneId: PARENT, width: 67 },
        { paneId: "%1", width: 101, height: undefined },
      ]);
    });

    it("bails when an unmanaged pane sits inside the region", () => {
      // A user-made pane inside the group region — resizing around it would
      // wreck the layout, so no ops are emitted.
      const panes = makePanes2D(240, 50, [
        { paneId: PARENT, left: 0, width: 96 },
        { paneId: "%9", left: 96, width: 20 },
        { paneId: "%1", left: 116, width: 52 },
      ]);
      const ops = planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4);
      assert.equal(ops.length, 0);
    });

    it("returns no ops when the parent pane is missing", () => {
      const panes = makePanes2D(200, 50, [
        { paneId: "%1", left: 0, width: 200 },
      ]);
      assert.equal(planTmuxGridRebalance(panes, PARENT, ["%1"], 0.4).length, 0);
    });
  });

  describe("layout mode persistence", () => {
    const LAYOUT_KEY = Symbol.for("pi-subagents/layout-mode");

    it("defaults to columns, honors PI_SUBAGENT_LAYOUT, and persists toggles", () => {
      const store = globalThis as Record<symbol, unknown>;
      const prevConfigDir = process.env.PI_CODING_AGENT_DIR;
      const prevLayoutEnv = process.env.PI_SUBAGENT_LAYOUT;
      const prevMode = store[LAYOUT_KEY];
      const dir = mkdtempSync(join(tmpdir(), "subagents-layout-"));
      try {
        process.env.PI_CODING_AGENT_DIR = dir;
        delete process.env.PI_SUBAGENT_LAYOUT;
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "columns");

        process.env.PI_SUBAGENT_LAYOUT = "tiled";
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "tiled");

        // /subagent-layout persists — the file wins over the env default.
        setSubagentLayoutMode("columns");
        delete store[LAYOUT_KEY];
        assert.equal(getSubagentLayoutMode(), "columns");
        assert.deepEqual(
          JSON.parse(readFileSync(join(dir, "subagents-layout.json"), "utf8")),
          {
            mode: "columns",
          },
        );

        setSubagentLayoutMode("tiled");
        assert.equal(getSubagentLayoutMode(), "tiled");
      } finally {
        if (prevConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevConfigDir;
        if (prevLayoutEnv === undefined) delete process.env.PI_SUBAGENT_LAYOUT;
        else process.env.PI_SUBAGENT_LAYOUT = prevLayoutEnv;
        if (prevMode === undefined) delete store[LAYOUT_KEY];
        else store[LAYOUT_KEY] = prevMode;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("model credential fallback", () => {
  const { resolveModelWithFallback } = (subagentsModule as any).__test__;
  const authed = new Set(["zai-coding-cn/glm-5.3"]);
  const hasAuth = (provider: string, id: string) =>
    authed.has(`${provider}/${id}`);

  it("keeps the requested model when its provider has credentials", () => {
    assert.deepEqual(
      resolveModelWithFallback({
        requestedModel: "zai-coding-cn/glm-5.3:high",
        hasAuth,
        parentModel: "zai-coding-cn/glm-5.3",
      }),
      { model: "zai-coding-cn/glm-5.3:high", applyThinking: true },
    );
  });

  it("falls back to the parent model when the agent provider has no auth", () => {
    const decision = resolveModelWithFallback({
      requestedModel: "anthropic/claude-sonnet-4-6:minimal",
      hasAuth,
      parentModel: "zai-coding-cn/glm-5.3",
    });
    assert.equal(decision.model, "zai-coding-cn/glm-5.3");
    assert.equal(decision.applyThinking, false);
    assert.match(decision.warning ?? "", /falling back/);
    assert.match(
      decision.warning ?? "",
      /anthropic\/claude-sonnet-4-6:minimal/,
    );
  });

  it("keeps the requested model with a warning when no parent model exists", () => {
    const decision = resolveModelWithFallback({
      requestedModel: "anthropic/claude-haiku-4-5",
      hasAuth,
      parentModel: undefined,
    });
    assert.equal(decision.model, "anthropic/claude-haiku-4-5");
    assert.equal(decision.applyThinking, true);
    assert.match(decision.warning ?? "", /no parent model/);
  });

  it("passes through unset and bare model ids without probing", () => {
    assert.deepEqual(
      resolveModelWithFallback({ hasAuth, parentModel: "p/m" }),
      {
        applyThinking: true,
      },
    );
    assert.deepEqual(
      resolveModelWithFallback({ requestedModel: "glm-5.3", hasAuth }),
      { model: "glm-5.3", applyThinking: true },
    );
  });
});

describe("waiting-delivery lane", () => {
  const baseParams = {
    interactive: false,
    interruptRequested: false,
    completing: false,
    cli: undefined,
    snapshotState: "present",
    phase: "waiting",
    waitingSinceMs: 10_000,
    lastActivityAtMs: 10_000,
    waitingDelivered: false,
    lastAssistantIndex: 5,
    deliveredAssistantIndex: undefined,
  };

  function deliver(
    overrides: Record<string, unknown> = {},
    config = { steerDebounceMs: 3_000 },
    now = 13_000,
  ) {
    const { shouldDeliverWaitingResult } = (subagentsModule as any).__test__;
    return shouldDeliverWaitingResult(
      { ...baseParams, ...overrides },
      config,
      now,
    );
  }

  it("delivers for autonomous waiting runs after the debounce window", () => {
    assert.deepEqual(deliver(), { deliver: true, idleMs: 3_000 });
    // Just under the debounce → not yet.
    assert.deepEqual(deliver({}, undefined, 12_999), { deliver: false });
  });

  it("skips interactive, interrupted, completing, and claude runs", () => {
    assert.deepEqual(deliver({ interactive: true }), { deliver: false });
    assert.deepEqual(deliver({ interruptRequested: true }), {
      deliver: false,
    });
    assert.deepEqual(deliver({ completing: true }), { deliver: false });
    assert.deepEqual(deliver({ cli: "claude" }), { deliver: false });
  });

  it("skips runs without a present snapshot or an idle phase", () => {
    assert.deepEqual(deliver({ snapshotState: "missing" }), {
      deliver: false,
    });
    assert.deepEqual(deliver({ snapshotState: "unseen" }), { deliver: false });
    assert.deepEqual(deliver({ phase: "active" }), { deliver: false });
    assert.deepEqual(deliver({ phase: "starting" }), { deliver: false });
    assert.deepEqual(deliver({ phase: "done", waitingSinceMs: null }), {
      deliver: true,
      idleMs: 3_000,
    });
    assert.deepEqual(
      deliver({ phase: "done", waitingSinceMs: null, lastActivityAtMs: null }),
      { deliver: false },
    );
  });

  it("never re-delivers without a new assistant message", () => {
    // Same idle episode, no new assistant entry → blocked.
    assert.deepEqual(
      deliver({ waitingDelivered: true, deliveredAssistantIndex: 5 }),
      { deliver: false },
    );
    // New episode (new waitingSince), but only user entries were appended
    // (an injected/typed message still waiting for the child's turn) — the
    // last assistant index is unchanged → blocked.
    assert.deepEqual(
      deliver({
        waitingDelivered: true,
        deliveredAssistantIndex: 5,
        waitingSinceMs: 11_000,
        lastAssistantIndex: 5,
      }),
      { deliver: false },
    );
    // New episode AND a new assistant message (index advanced) → deliverable.
    assert.deepEqual(
      deliver(
        {
          waitingDelivered: true,
          deliveredAssistantIndex: 5,
          waitingSinceMs: 11_000,
          lastAssistantIndex: 7,
        },
        undefined,
        14_500,
      ),
      { deliver: true, idleMs: 3_500 },
    );
    // A new assistant message overrides the same-episode latch too (e.g. a
    // recorder hiccup froze waitingSince while the child finished a reply).
    assert.deepEqual(
      deliver(
        {
          waitingDelivered: true,
          deliveredAssistantIndex: 5,
          waitingSinceMs: 10_000,
          lastAssistantIndex: 7,
        },
        undefined,
        14_500,
      ),
      { deliver: true, idleMs: 4_500 },
    );
  });
});

describe("idle auto-close", () => {
  const { shouldIdleClose } = (subagentsModule as any).__test__;

  const baseParams = {
    interactive: false,
    interruptRequested: false,
    waitingDelivered: true,
    idleMs: 600_000,
    deliveredWaitingSince: 10_000,
    waitingSinceMs: 10_000,
  };

  function idleClose(
    overrides: Record<string, unknown> = {},
    config = { idleCloseMs: 600_000 },
  ) {
    return shouldIdleClose({ ...baseParams, ...overrides }, config);
  }

  it("closes delivered runs after idleCloseMs in the same episode", () => {
    assert.equal(idleClose(), true);
    assert.equal(idleClose({ idleMs: 599_999 }), false);
    assert.equal(idleClose({ idleMs: 600_000 }), true);
  });

  it("only closes autonomous, undelivered-episode-free, non-interrupted runs", () => {
    assert.equal(idleClose({ interactive: true }), false);
    assert.equal(idleClose({ interruptRequested: true }), false);
    assert.equal(idleClose({ waitingDelivered: false }), false);
    assert.equal(
      idleClose({ deliveredWaitingSince: 5_000, waitingSinceMs: 10_000 }),
      false,
    );
  });

  it("is disabled when idleCloseMs is 0", () => {
    assert.equal(idleClose({}, { idleCloseMs: 0 }), false);
  });
});

describe("closeRunningSubagent", () => {
  it("writes the .exit sidecar and suppresses duplicate exit steers", () => {
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [
        {
          type: "message",
          id: "u1",
          message: {
            role: "user",
            content: [{ type: "text", text: "go" }],
          },
        },
      ]);
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();

      try {
        const running = {
          id: "a1",
          name: "Worker",
          task: "",
          surface: "pane-1",
          startTime: 0,
          sessionFile,
          interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
          waitingDelivered: true,
          deliveredWaitingSince: null,
          deliveredSequence: 3,
        };
        runningMap.set("a1", running);

        testApi.closeRunningSubagent(running, "idle-close");

        assert.equal(running.exitSteerSuppressed, true);
        const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.deepEqual(sidecar, { type: "done", reason: "idle-close" });
      } finally {
        runningMap.clear();
      }
    });
  });

  it("keeps the exit lane enabled when the result was never delivered", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "worker.jsonl");
      const testApi = (subagentsModule as any).__test__;
      const running = {
        id: "a1",
        name: "Worker",
        task: "",
        surface: "pane-1",
        startTime: 0,
        sessionFile,
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };

      testApi.closeRunningSubagent(running, "closed-by-parent");

      assert.equal(running.exitSteerSuppressed, undefined);
      // Sidecar written (pi-backed close path) with the close reason.
      const sidecar = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
      assert.deepEqual(sidecar, { type: "done", reason: "closed-by-parent" });
    });
  });
});

describe("superviseRunCompletion", () => {
  function makeWaitingRunning(
    sessionFile: string,
    overrides: Record<string, unknown> = {},
  ) {
    const state = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 10_000,
        sequence: 7,
        phase: "waiting",
        waitingSince: 10_000,
      },
      10_000,
    );
    return {
      id: "a1",
      name: "Worker",
      task: "do things",
      agent: "worker",
      surface: "pane-1",
      startTime: 4_000,
      sessionFile,
      interactive: false,
      statusState: state,
      ...overrides,
    };
  }

  function assistantEntry(text: string) {
    return {
      type: "message",
      id: `a-${text.slice(0, 6)}`,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    };
  }

  it("steers the closing message once for an idle autonomous run", () => {
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [
        assistantEntry("All finished, tests green."),
      ]);
      const testApi = (subagentsModule as any).__test__;
      const sent: any[] = [];
      const pi = {
        sendMessage: (message: any, options: any) =>
          sent.push({ message, options }),
      };
      const running = makeWaitingRunning(sessionFile);

      // 3.5s idle → past the 3s debounce.
      testApi.superviseRunCompletion(pi, running, 13_500);

      assert.equal(sent.length, 1);
      const { message, options } = sent[0];
      assert.equal(message.customType, "subagent_result");
      assert.match(message.content, /finished its run \(9s\)/);
      assert.match(message.content, /All finished, tests green\./);
      assert.match(message.content, /subagent_message/);
      assert.match(message.content, /subagent_close/);
      assert.equal(message.details.deliveredVia, "waiting");
      assert.equal(message.details.name, "Worker");
      assert.equal(message.details.sessionFile, sessionFile);
      assert.equal(options.triggerTurn, true);
      assert.equal(options.deliverAs, "steer");
      assert.equal(running.waitingDelivered, true);
      assert.equal(running.deliveredAssistantIndex, 0);
      assert.equal(running.deliveredWaitingSince, 10_000);
      // F1 regression: delivery arms exit-lane suppression so a later exit
      // for the same content cannot steer a duplicate.
      assert.equal(running.exitSteerSuppressed, true);

      // Same episode → no duplicate steer.
      testApi.superviseRunCompletion(pi, running, 14_500);
      assert.equal(sent.length, 1);
    });
  });

  it("re-delivers only after a NEW assistant message, not user-only growth", () => {
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [assistantEntry("first")]);
      const testApi = (subagentsModule as any).__test__;
      const sent: any[] = [];
      const pi = {
        sendMessage: (message: any, options: any) =>
          sent.push({ message, options }),
      };
      const running = makeWaitingRunning(sessionFile);

      testApi.superviseRunCompletion(pi, running, 13_500);
      assert.equal(sent.length, 1);

      // A live subagent_message follow-up re-arms the exit lane…
      running.exitSteerSuppressed = false;
      // …and appends a USER entry (the injected message) plus new activity
      // while the child has not produced its reply yet.
      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "u2",
          message: { role: "user", content: [{ type: "text", text: "go on" }] },
        })}\n`,
      );
      const state2 = observeStatus(
        running.statusState,
        {
          snapshot: "present",
          updatedAt: 15_000,
          sequence: 9,
          phase: "waiting",
          waitingSince: 15_000,
        },
        15_000,
      );
      running.statusState = state2;

      // F4 regression: user-only growth must not re-steer the old text.
      testApi.superviseRunCompletion(pi, running, 18_500);
      assert.equal(sent.length, 1);

      // The child finishes its reply: a new assistant entry + new episode.
      appendFileSync(
        sessionFile,
        `${JSON.stringify(assistantEntry("second reply"))}\n`,
      );
      const state3 = observeStatus(
        running.statusState,
        {
          snapshot: "present",
          updatedAt: 20_000,
          sequence: 12,
          phase: "waiting",
          waitingSince: 20_000,
        },
        20_000,
      );
      running.statusState = state3;

      testApi.superviseRunCompletion(pi, running, 23_500);
      assert.equal(sent.length, 2);
      assert.match(sent[1].message.content, /second reply/);
      assert.equal(running.exitSteerSuppressed, true);
    });
  });

  it("uses a placeholder when the run has no closing assistant message", () => {
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [
        {
          type: "message",
          id: "u1",
          message: {
            role: "user",
            content: [{ type: "text", text: "go" }],
          },
        },
      ]);
      const testApi = (subagentsModule as any).__test__;
      const sent: any[] = [];
      const pi = {
        sendMessage: (message: any, options: any) =>
          sent.push({ message, options }),
      };
      const running = makeWaitingRunning(sessionFile);

      testApi.superviseRunCompletion(pi, running, 13_000);
      assert.equal(sent.length, 1);
      assert.match(
        sent[0].message.content,
        /\(finished without a closing message\)/,
      );
    });
  });

  it("skips unreadable session files, interactive runs, and claude runs", () => {
    const testApi = (subagentsModule as any).__test__;
    const sent: any[] = [];
    const pi = {
      sendMessage: (message: any, options: any) =>
        sent.push({ message, options }),
    };

    // Unreadable session file → skip this tick.
    const unreadable = makeWaitingRunning("/nonexistent/dir/x.jsonl");
    testApi.superviseRunCompletion(pi, unreadable, 13_000);
    assert.equal(sent.length, 0);

    // Interactive → never steer.
    withTempDir((dir) => {
      const sessionFile = createSessionFile(dir, [assistantEntry("done")]);
      const interactive = makeWaitingRunning(sessionFile, {
        interactive: true,
      });
      testApi.superviseRunCompletion(pi, interactive, 13_000);
      assert.equal(sent.length, 0);

      // Claude-backed → no snapshots, never steer.
      const claude = makeWaitingRunning(sessionFile, { cli: "claude" });
      testApi.superviseRunCompletion(pi, claude, 13_000);
      assert.equal(sent.length, 0);

      // Completing (watcher already resolved) → never steer.
      const completing = makeWaitingRunning(sessionFile, {
        completing: true,
      });
      testApi.superviseRunCompletion(pi, completing, 13_000);
      assert.equal(sent.length, 0);
    });
  });
});

describe("sanitizeInjectedMessage", () => {
  const { sanitizeInjectedMessage } = (subagentsModule as any).__test__;

  it("collapses newline-containing whitespace runs into single spaces", () => {
    assert.equal(sanitizeInjectedMessage("a\nb"), "a b");
    assert.equal(sanitizeInjectedMessage("a\n\n  b"), "a b");
    assert.equal(sanitizeInjectedMessage("a \n\t b"), "a b");
    assert.equal(sanitizeInjectedMessage("  trimmed  "), "trimmed");
    // Whitespace without newlines is preserved.
    assert.equal(sanitizeInjectedMessage("a  b"), "a  b");
  });

  it("hard-caps at 4000 chars with a truncation marker", () => {
    const long = "x".repeat(4_100);
    const sanitized = sanitizeInjectedMessage(long);
    assert.equal(sanitized.length, 4_000 + "…[truncated]".length);
    assert.ok(sanitized.endsWith("…[truncated]"));
    assert.equal(sanitizeInjectedMessage("y".repeat(4_000)), "y".repeat(4_000));
  });
});

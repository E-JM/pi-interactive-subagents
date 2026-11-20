import {
  execFile,
  execFileSync,
  execSync,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";

const commandAvailability = new Map<string, boolean>();

/** Cached for the process lifetime; mux availability is not re-checked after startup. */
function hasCommand(command: string): boolean {
  const cached = commandAvailability.get(command);
  if (cached !== undefined) return cached;

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (
    pref === "cmux" ||
    pref === "tmux" ||
    pref === "zellij" ||
    pref === "wezterm" ||
    pref === "herdr"
  ) {
    return pref;
  }
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return (
    !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) &&
    hasCommand("zellij")
  );
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

function isHerdrRuntimeAvailable(): boolean {
  const insideHerdr =
    process.env.HERDR_ENV === "1" || process.env.TERM_PROGRAM === "herdr";
  return insideHerdr && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function isHerdrAvailable(): boolean {
  return isHerdrRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;
  if (pref === "herdr") return isHerdrRuntimeAvailable() ? "herdr" : null;

  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  if (isHerdrRuntimeAvailable()) return "herdr";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "tmux") {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  if (pref === "wezterm") {
    return "Start pi inside WezTerm.";
  }
  if (pref === "herdr") {
    return "Start pi inside herdr (`herdr` or `herdr --session <name>`, then run `pi`).";
  }
  return (
    "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), " +
    "zellij (`zellij --session pi`, then run `pi`), WezTerm, or herdr (`herdr`, then run `pi`)."
  );
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(
      `No supported terminal multiplexer found. ${muxSetupHint()}`,
    );
  }
  return backend;
}

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

/**
 * Pane-scoped zellij actions that must target a specific pane via --pane-id
 * (the ZELLIJ_PANE_ID env var is ignored by most of these).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/19
 */
const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  // Don't double-add if caller already specified it.
  if (args.includes("--pane-id") || args.includes("-p"))
    return ["action", ...args];
  return [
    "action",
    action,
    "--pane-id",
    zellijPaneId(surface),
    ...args.slice(1),
  ];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

// Mirrors Zellij 0.44.x tab minimums, used to predict which pane Zellij itself
// will choose for a directionless split.
const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;

// Pi subagents need more usable space than Zellij's internal minimum. These can
// be tuned per session without another code change.
const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

export interface ZellijPaneSnapshot {
  id: number;
  is_plugin?: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
  | {
      mode: "split";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
      splitDirection: ZellijSplitDirection;
    }
  | {
      mode: "stack";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
    };

function paneArea(pane: ZellijPaneSnapshot): number {
  return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}

function isUsableZellijTiledPane(pane: ZellijPaneSnapshot): boolean {
  return (
    !pane.is_plugin &&
    !pane.is_floating &&
    pane.is_selectable !== false &&
    !pane.exited &&
    typeof pane.pane_rows === "number" &&
    typeof pane.pane_columns === "number"
  );
}

export function predictZellijSplitDirection(
  pane: ZellijPaneSnapshot,
): ZellijSplitDirection | null {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT)
    return null;

  if (
    rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
    rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
  ) {
    return "down";
  }

  if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) {
    return "right";
  }

  return null;
}

export function canSplitZellijPane(
  pane: ZellijPaneSnapshot,
  minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
  minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  const direction = predictZellijSplitDirection(pane);
  if (!direction) return false;

  if (direction === "down") {
    return columns >= minColumns && Math.floor(rows / 2) >= minRows;
  }

  return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

function zellijTabPanesForParent(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): {
  parentPane: ZellijPaneSnapshot;
  tabId: number;
  tabPanes: ZellijPaneSnapshot[];
} | null {
  const parentPane = panes.find(
    (pane) => !pane.is_plugin && pane.id === parentPaneId,
  );
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;

  const tabPanes = panes
    .filter((pane) => pane.tab_id === parentPane.tab_id)
    .filter(isUsableZellijTiledPane);

  return { parentPane, tabId: parentPane.tab_id, tabPanes };
}

export function selectZellijStackPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const stackTarget = tabInfo.tabPanes
    .filter((pane) => pane.id !== parentPaneId)
    .sort((a, b) => paneArea(b) - paneArea(a))[0];
  if (!stackTarget) return null;

  return {
    mode: "stack",
    anchorPaneId: stackTarget.id,
    targetPaneId: stackTarget.id,
    tabId: tabInfo.tabId,
  };
}

export function selectZellijPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
  minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const zellijSplitCandidates = tabInfo.tabPanes
    .map((pane) => ({
      pane,
      splitDirection: predictZellijSplitDirection(pane),
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        pane: ZellijPaneSnapshot;
        splitDirection: ZellijSplitDirection;
      } =>
        candidate.splitDirection !== null &&
        canSplitZellijPane(
          candidate.pane,
          ZELLIJ_MIN_TERMINAL_WIDTH,
          ZELLIJ_MIN_TERMINAL_HEIGHT,
        ),
    );

  const safeSplitCandidates = zellijSplitCandidates.filter((candidate) =>
    canSplitZellijPane(candidate.pane, minColumns, minRows),
  );

  // Split creation is tab-scoped, so Zellij chooses the concrete split pane.
  // Only split when every pane Zellij might split would remain usable.
  if (
    zellijSplitCandidates.length > 0 &&
    safeSplitCandidates.length === zellijSplitCandidates.length
  ) {
    const splitTarget = safeSplitCandidates.sort(
      (a, b) => paneArea(b.pane) - paneArea(a.pane),
    )[0];
    return {
      mode: "split",
      anchorPaneId: splitTarget.pane.id,
      targetPaneId: splitTarget.pane.id,
      tabId: tabInfo.tabId,
      splitDirection: splitTarget.splitDirection,
    };
  }

  return selectZellijStackPlacement(panes, parentPaneId);
}

/** Synchronous sleep that blocks the event loop (safe inside sync CLI flows). */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(
      `Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`,
    );
  }
  return `pane:${idMatch[1]}`;
}

function readZellijPanes(): ZellijPaneSnapshot[] {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync([
        "list-panes",
        "--json",
        "--geometry",
        "--state",
        "--tab",
      ]);
      if (!output.trim()) {
        throw new Error("Unexpected zellij list-panes output: empty");
      }
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected zellij list-panes output: not an array");
      }
      return parsed as ZellijPaneSnapshot[];
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync(50);
    }
  }
  throw lastError;
}

function createZellijTiledPane(name: string, tabId: number): string {
  const args = [
    "new-pane",
    "--tab-id",
    String(tabId),
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];
  return parseZellijPaneSurface(zellijActionSync(args).trim(), "new-pane");
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
  const args = [
    "new-pane",
    "--stacked",
    "--near-current-pane",
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];
  return parseZellijPaneSurface(
    zellijActionSync(args, anchorSurface).trim(),
    "new-pane --stacked",
  );
}

function createZellijTab(name: string): string {
  const tabIdRaw = zellijActionSync([
    "new-tab",
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ]).trim();
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId)) {
    throw new Error(
      `Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`,
    );
  }

  try {
    const panes = readZellijPanes();
    const pane = panes.find(
      (candidate) =>
        candidate.tab_id === tabId &&
        isUsableZellijTiledPane(candidate) &&
        typeof candidate.id === "number",
    );
    if (!pane) {
      throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
    }

    const surface = `pane:${pane.id}`;
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {
      // Optional.
    }
    return surface;
  } catch (error) {
    try {
      zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function zellijSurfaceLockPath(): string {
  const session = (
    process.env.ZELLIJ_SESSION_NAME ??
    process.env.ZELLIJ ??
    "default"
  ).replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}

function withZellijSurfaceLock<T>(callback: () => T): T {
  const lockPath = zellijSurfaceLockPath();
  const deadline = Date.now() + 10000;

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
          // Stale lock — older than 30s means a crashed holder left it behind.
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for zellij surface lock: ${lockPath}`,
        );
      }
      sleepSync(50);
    }
  }

  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function createZellijSurfaceUnlocked(name: string): string {
  const parentPaneIdRaw = process.env.ZELLIJ_PANE_ID;
  const parentPaneId = parentPaneIdRaw ? Number(parentPaneIdRaw) : NaN;
  const minColumns = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  );
  const minRows = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_ROWS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
  );

  const plan = Number.isInteger(parentPaneId)
    ? selectZellijPlacement(
        readZellijPanes(),
        parentPaneId,
        minColumns,
        minRows,
      )
    : null;

  if (plan?.mode === "split") {
    return createZellijTiledPane(name, plan.tabId);
  }

  if (plan?.mode === "stack") {
    return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
  }

  return createZellijTab(name);
}

function createZellijSurface(name: string): string {
  return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name));
}

type CmuxFocusSnapshot = {
  surfaceRef?: string;
  paneRef?: string;
};

type CmuxCreatedSurface = {
  surface: string;
  paneRef?: string;
};

type CmuxIdentifySnapshot = {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read `{ [key]: { surface_ref?, pane_ref? } }` from a parsed cmux identify
 * payload, rejecting entries without at least one usable ref.
 */
function parseCmuxFocusSnapshotField(
  value: unknown,
  key: "focused" | "caller",
): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const field = (value as Record<string, unknown>)[key];
  if (!field || typeof field !== "object") return null;

  const record = field as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref)
    ? record.surface_ref
    : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxFocusedSnapshot(
  value: unknown,
): CmuxFocusSnapshot | null {
  return parseCmuxFocusSnapshotField(value, "focused");
}

export function parseCmuxJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(
  value: string,
): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  return parseCmuxFocusSnapshotField(value, "caller");
}

export function parseCmuxPaneRefForSurface(
  value: unknown,
  surface: string,
): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as {
    surface_ref?: unknown;
    pane_ref?: unknown;
    caller?: unknown;
  };
  const direct = paneRefForSurface(record, surface);
  if (direct) return direct;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;
  return paneRefForSurface(
    caller as { surface_ref?: unknown; pane_ref?: unknown },
    surface,
  );
}

/** The pane ref when `record` is for `surface` and carries a non-empty pane_ref. */
function paneRefForSurface(
  record: { surface_ref?: unknown; pane_ref?: unknown },
  surface: string,
): string | null {
  return record.surface_ref === surface && nonEmptyString(record.pane_ref)
    ? (record.pane_ref as string)
    : null;
}

export function parseCmuxPaneRefForSurfaceFromJson(
  value: string,
  surface: string,
): string | null {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}

function readCmux(args: string[]): string | null {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed),
  };
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
  return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
  if (!snapshot) return;

  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], {
      encoding: "utf8",
    });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], {
      encoding: "utf8",
    });
  }
}

/** Give cmux a moment to apply focus changes before reading focus back. */
function waitForCmuxFocusSettle(): void {
  sleepSync(100);
}

function cmuxFocusMatchesChild(
  currentFocus: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
): boolean {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
  currentFocus: CmuxFocusSnapshot | null,
  surfaceRef: string | undefined,
): boolean {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
  currentFocus: CmuxFocusSnapshot | null,
  paneRef: string | undefined,
): boolean {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
  snapshot: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
  options?: {
    sourceSurfaceRef?: string;
    callerSnapshot?: CmuxFocusSnapshot | null;
  },
): void {
  if (!snapshot) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  if (
    cmuxFocusMatchesChild(currentFocus, child) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(
      currentFocus,
      options?.callerSnapshot?.surfaceRef,
    ) ||
    // cmux can settle focus onto another active surface in the caller pane after creating a split/surface.
    cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
  ) {
    restoreCmuxFocusSnapshot(snapshot);
  }
}

function parseCmuxCreatedSurface(
  output: string,
  command: string,
): CmuxCreatedSurface {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }

  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0],
  };
}

function renameCmuxSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], {
    encoding: "utf8",
  });
}

function createCmuxSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);

    const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        sourceSurfaceRef: fromSurface,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/** Extract the pane id from a herdr CLI JSON envelope (`pane split` / `tab create` output). */
export function parseHerdrPaneId(output: string, context: string): string {
  const parsed = parseCmuxJson(output);
  const paneId =
    parsed?.result?.pane?.pane_id ?? parsed?.result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(
      `Unexpected herdr ${context} output: ${output || "(empty)"}`,
    );
  }
  return paneId;
}

export interface HerdrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HerdrLayoutPane {
  pane_id: string;
  rect: HerdrRect;
}

export interface HerdrLayoutSplit {
  id: string;
  direction: "right" | "down";
  ratio: number;
  rect: HerdrRect;
}

export interface HerdrLayout {
  area: HerdrRect;
  panes: HerdrLayoutPane[];
  splits: HerdrLayoutSplit[];
  tab_id?: string;
  zoomed?: boolean;
}

export function parseHerdrLayout(output: string): HerdrLayout | null {
  const parsed = parseCmuxJson(output) as {
    result?: { layout?: HerdrLayout };
  } | null;
  const layout = parsed?.result?.layout;
  if (!layout?.area || !Array.isArray(layout.panes)) return null;
  return layout;
}

function readHerdrLayout(paneId?: string): HerdrLayout | null {
  const args = ["pane", "layout"];
  if (paneId) args.push("--pane", paneId);
  try {
    return parseHerdrLayout(execFileSync("herdr", args, { encoding: "utf8" }));
  } catch {
    return null;
  }
}

/** Tracked herdr subagent panes; globalThis + Symbol.for so it survives /reload. */
const HERDR_SUBAGENT_PANES_KEY = Symbol.for(
  "pi-subagents/herdr-subagent-panes",
);

/** Tracked herdr subagent pane ids, in spawn order (grid fill order). */
function herdrSubagentPaneList(): string[] {
  const store = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(store[HERDR_SUBAGENT_PANES_KEY])) {
    store[HERDR_SUBAGENT_PANES_KEY] = [];
  }
  return store[HERDR_SUBAGENT_PANES_KEY] as string[];
}

/** Replace the tracked herdr subagent pane list. Exported for tests. */
export function setHerdrSubagentPaneList(paneIds: string[]): void {
  (globalThis as Record<symbol, unknown>)[HERDR_SUBAGENT_PANES_KEY] = [
    ...paneIds,
  ];
}

/**
 * Track a spawned herdr subagent pane so layout ops stay in the group
 * (idempotent).
 */
function herdrTrackPane(paneId: string): void {
  const panes = herdrSubagentPaneList();
  if (!panes.includes(paneId)) panes.push(paneId);
}

/** Forget a herdr subagent pane after its surface closes. */
function herdrUntrackPane(paneId: string): void {
  setHerdrSubagentPaneList(
    herdrSubagentPaneList().filter((id) => id !== paneId),
  );
}

/** Default fraction of the tab width reserved for the parent (main agent) pane. */
const DEFAULT_SUBAGENT_PARENT_RATIO = 0.4;

function parentRatioFromEnv(envName: string): number {
  const value = Number(process.env[envName]);
  return Number.isFinite(value) && value >= 0.1 && value <= 0.9
    ? value
    : DEFAULT_SUBAGENT_PARENT_RATIO;
}

function herdrParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_HERDR_PARENT_RATIO");
}

// --- Subagent layout mode (columns vs tiled grid, herdr/tmux only) ---

export type SubagentLayoutMode = "columns" | "tiled";

const LAYOUT_MODE_KEY = Symbol.for("pi-subagents/layout-mode");
const LAYOUT_MODE_FILE = "subagents-layout.json";

function parseLayoutMode(value: unknown): SubagentLayoutMode | null {
  return value === "columns" || value === "tiled" ? value : null;
}

function agentConfigDirForLayout(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function readPersistedLayoutMode(): SubagentLayoutMode | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(agentConfigDirForLayout(), LAYOUT_MODE_FILE), "utf8"),
    );
    return parseLayoutMode(raw?.mode);
  } catch {
    return null;
  }
}

/**
 * Resolve the active subagent pane layout for herdr/tmux. Precedence: the
 * choice persisted by /subagent-layout, then PI_SUBAGENT_LAYOUT, then
 * "columns". Cached on globalThis so it survives /reload.
 */
export function getSubagentLayoutMode(): SubagentLayoutMode {
  const store = globalThis as Record<symbol, unknown>;
  const cached = parseLayoutMode(store[LAYOUT_MODE_KEY]);
  if (cached) return cached;
  const mode =
    readPersistedLayoutMode() ??
    parseLayoutMode(process.env.PI_SUBAGENT_LAYOUT) ??
    "columns";
  store[LAYOUT_MODE_KEY] = mode;
  return mode;
}

/** Set the layout mode and persist it so the choice survives restarts. */
export function setSubagentLayoutMode(mode: SubagentLayoutMode): void {
  (globalThis as Record<symbol, unknown>)[LAYOUT_MODE_KEY] = mode;
  try {
    mkdirSync(agentConfigDirForLayout(), { recursive: true });
    writeFileSync(
      join(agentConfigDirForLayout(), LAYOUT_MODE_FILE),
      `${JSON.stringify({ mode }, null, 2)}\n`,
    );
  } catch {
    // Best effort — the in-memory mode still applies to this session.
  }
}

// --- Tiled grid geometry (shared by herdr and tmux) ---

/** Rectangle in tab/window coordinates. */
export interface GridRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Smallest rectangle covering every input rect. The one bounding fold behind
 * both backends' group regions: callers always seed it with the parent pane's
 * rect, so a solo parent yields exactly its own rect (the whole tab only when
 * nothing else is in it). Input is never empty in practice; the Infinity
 * edges of an empty fold are garbage by contract.
 */
function boundingRect(rects: GridRect[]): GridRect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface GridDims {
  cols: number;
  rows: number;
}

/**
 * Grid shape for `count` subagents. Rows = round(sqrt(count)), grown one axis
 * at a time: 1×1 → 1×2 → 2×2 → 2×3 → 3×3 → 3×4 → 4×4 … so existing panes
 * never need to change cells when the grid grows (binary split trees can
 * only move dividers, not reflow panes).
 */
export function gridDimsForCount(count: number): GridDims {
  const n = Math.max(1, count);
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const cols = Math.max(1, Math.ceil(n / rows));
  return { cols, rows };
}

/**
 * How the grid grew at exactly `count` (compared to `count - 1`): "col" when
 * a column was added, "row" when a row was added, null when the shape is
 * unchanged (and for count < 2).
 */
function gridGrowthAt(count: number): "col" | "row" | null {
  const prev = gridDimsForCount(count - 1);
  const cur = gridDimsForCount(count);
  if (cur.cols > prev.cols) return "col";
  if (cur.rows > prev.rows) return "row";
  return null;
}

/**
 * Which axis the grid last grew on at or before `count`: "col" (2,5,10,17…),
 * "row" (3,7,13…), or null when the grid is exactly full. Unclaimed cells
 * left by a growth are absorbed by the neighbor pane on that axis.
 */
function lastGridGrowth(count: number): "col" | "row" | null {
  for (let n = count; n >= 2; n--) {
    const growth = gridGrowthAt(n);
    if (growth) return growth;
  }
  return null;
}

/** First unclaimed cell in row-major scan order (origin as the fallback). */
function firstFreeCell(
  claimed: Set<string>,
  rows: number,
  cols: number,
): { row: number; col: number } {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!claimed.has(`${row},${col}`)) return { row, col };
    }
  }
  return { row: 0, col: 0 };
}

/**
 * Cell (row, col) claimed by each of the first `count` spawns, in order.
 * Every pane keeps its cell as the grid grows: a growth spawn claims the new
 * column's top cell or the new row's left cell; other spawns take the first
 * free cell in scan order.
 */
function spawnSlots(count: number): { row: number; col: number }[] {
  const slots: { row: number; col: number }[] = [];
  const claimed = new Set<string>();
  for (let k = 1; k <= count; k++) {
    const { cols, rows } = gridDimsForCount(k);
    let slot: { row: number; col: number };
    switch (gridGrowthAt(k)) {
      case "col":
        slot = { row: 0, col: cols - 1 };
        break;
      case "row":
        slot = { row: rows - 1, col: 0 };
        break;
      default:
        slot = firstFreeCell(claimed, rows, cols);
    }
    claimed.add(`${slot.row},${slot.col}`);
    slots.push(slot);
  }
  return slots;
}

/**
 * Minimum usable cell size for rebalance targets — smaller grids bail out
 * instead of squeezing. (Spawn-time anchor selection uses stricter minimums,
 * since a split must leave both halves usable.)
 */
const GRID_MIN_CELL_WIDTH = 10;
const GRID_MIN_CELL_HEIGHT = 3;

export interface GridTargets {
  /** Target rect for the parent pane (left strip at `parentRatio`). */
  parentRect: GridRect;
  /** Target cell rect per tracked pane, keyed by pane id (row-major fill). */
  cells: Map<string, GridRect>;
}

/**
 * Grid targets: the parent keeps `parentRatio` of `area` width on the left;
 * each tracked pane keeps the cell it was spawned into (spawn order), and —
 * right after a grid growth — absorbs the unclaimed cells beside it (below
 * for new rows, to the right for new columns), matching how the incremental
 * splits actually stretch the neighboring panes. Returns null when the area
 * is too small for usable cells.
 */
export function planGridTargets(
  paneIds: string[],
  area: GridRect,
  parentRatio: number,
): GridTargets | null {
  if (paneIds.length === 0) return null;
  const parentWidth = Math.round(parentRatio * area.width);
  const regionWidth = area.width - parentWidth;
  const count = paneIds.length;
  const { cols, rows } = gridDimsForCount(count);
  const cellWidth = regionWidth / cols;
  const cellHeight = area.height / rows;
  if (cellWidth < GRID_MIN_CELL_WIDTH || cellHeight < GRID_MIN_CELL_HEIGHT)
    return null;

  const slots = spawnSlots(count);
  const cellOf = new Map<string, { row: number; col: number }>();
  paneIds.forEach((paneId, index) => {
    cellOf.set(paneId, slots[index]);
  });
  const growth = lastGridGrowth(count);
  const isUnclaimed = (row: number, col: number): boolean =>
    row < rows &&
    col < cols &&
    !slots.some((s) => s.row === row && s.col === col);

  const cells = new Map<string, GridRect>();
  for (const [paneId, cell] of cellOf) {
    let widthCells = 1;
    let heightCells = 1;
    if (growth === "col") {
      while (isUnclaimed(cell.row, cell.col + widthCells)) widthCells++;
    } else if (growth === "row") {
      while (isUnclaimed(cell.row + heightCells, cell.col)) heightCells++;
    }
    cells.set(paneId, {
      x: area.x + parentWidth + cell.col * cellWidth,
      y: area.y + cell.row * cellHeight,
      width: widthCells * cellWidth,
      height: heightCells * cellHeight,
    });
  }
  return {
    parentRect: {
      x: area.x,
      y: area.y,
      width: parentWidth,
      height: area.height,
    },
    cells,
  };
}

/**
 * A pane with its current rect — the input for spawn-anchor selection, both
 * the tiled grid (selectTiledGridAnchor) and the columns rightmost anchor.
 */
interface PlacedPane {
  paneId: string;
  rect: GridRect;
}

/**
 * Rects of the tracked panes present in `panes`, in tracked (fill) order;
 * tracked panes missing from `panes` are skipped.
 */
function placedPanes<Pane>(
  trackedPaneIds: string[],
  panes: readonly Pane[],
  paneIdOf: (pane: Pane) => string,
  rectOf: (pane: Pane) => GridRect,
): PlacedPane[] {
  const byId = new Map(panes.map((pane) => [paneIdOf(pane), pane]));
  const placed: PlacedPane[] = [];
  for (const id of trackedPaneIds) {
    const pane = byId.get(id);
    if (pane) placed.push({ paneId: id, rect: rectOf(pane) });
  }
  return placed;
}

/**
 * Columns-mode spawn anchor: the rightmost tracked pane (bottommost, then
 * rightmost, on ties — columns-mode panes are full-height, so the y
 * tie-break only decides odd layouts) at or right of `parentRight` within 1
 * cell. Foreign panes are never anchors — when the tab is shared, the first
 * spawn splits the parent itself rather than carving up a foreign pane.
 * `placed` holds the tracked panes (see placedPanes); null when none
 * qualifies, and callers then split the parent. Exported for tests.
 */
export function rightmostAnchor(
  placed: PlacedPane[],
  parentRight: number,
): string | null {
  const anchor = placed
    .filter((pane) => pane.rect.x >= parentRight - 1)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .pop();
  return anchor?.paneId ?? null;
}

export interface TiledAnchorSelection {
  anchorPaneId: string;
  direction: "right" | "down";
}

/**
 * Pick which tracked pane to split for subagent #count (1-indexed) in tiled
 * mode, and in which direction. `placed` holds the tracked panes with their
 * current rects in fill order; `region` is the subagent area — right of the
 * parent, inside the group region. The anchor is the pane overlapping the
 * target cell the most (ties: smaller pane, then fill order); the direction
 * is whichever half-split of the anchor contains more of the target cell.
 * Returns null when tiling isn't possible and the caller should fall back
 * to columns.
 */
export function selectTiledGridAnchor(
  placed: PlacedPane[],
  region: GridRect,
  count: number,
  minCellWidth = 20,
  minCellHeight = 6,
): TiledAnchorSelection | null {
  if (placed.length === 0 || count <= placed.length) return null;
  const { cols, rows } = gridDimsForCount(count);
  const cellWidth = region.width / cols;
  const cellHeight = region.height / rows;
  if (cellWidth < minCellWidth || cellHeight < minCellHeight) return null;

  const spawnCell = spawnSlots(count)[count - 1];
  const target: GridRect = {
    x: region.x + spawnCell.col * cellWidth,
    y: region.y + spawnCell.row * cellHeight,
    width: cellWidth,
    height: cellHeight,
  };

  const overlapArea = (a: GridRect, b: GridRect): number => {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height =
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
  };

  const anchor = [...placed].sort((a, b) => {
    const overlapDiff =
      overlapArea(b.rect, target) - overlapArea(a.rect, target);
    if (Math.abs(overlapDiff) > 1) return overlapDiff;
    return a.rect.width * a.rect.height - b.rect.width * b.rect.height;
  })[0];
  if (!anchor) return null;

  const rightSlice: GridRect = {
    x: anchor.rect.x + anchor.rect.width / 2,
    y: anchor.rect.y,
    width: anchor.rect.width / 2,
    height: anchor.rect.height,
  };
  const downSlice: GridRect = {
    x: anchor.rect.x,
    y: anchor.rect.y + anchor.rect.height / 2,
    width: anchor.rect.width,
    height: anchor.rect.height / 2,
  };
  // Prefer "down" only when the bottom half clearly contains more of the cell.
  const direction: "right" | "down" =
    overlapArea(downSlice, target) > overlapArea(rightSlice, target)
      ? "down"
      : "right";

  // Both halves of the anchor must stay usable after the split.
  if (direction === "right") {
    if (anchor.rect.width / 2 < minCellWidth) return null;
  } else if (anchor.rect.height / 2 < minCellHeight) {
    return null;
  }
  return { anchorPaneId: anchor.paneId, direction };
}

/** Ratio deltas below this are treated as already-balanced (avoids rounding churn). */
const HERDR_RESIZE_EPSILON = 0.01;

/**
 * Divider movement so the low side holds `lowTarget / (lowTarget + highTarget)`;
 * null when the split is already balanced or the targets sum to zero.
 */
function dividerDelta(
  lowTarget: number,
  highTarget: number,
  ratio: number,
): number | null {
  if (!(lowTarget + highTarget > 0)) return null;
  const delta = lowTarget / (lowTarget + highTarget) - ratio;
  if (Math.abs(delta) < HERDR_RESIZE_EPSILON) return null;
  return delta;
}

/**
 * Pane a divider move is anchored on (herdr resolves ops by the anchor pane):
 * the leaf flush against the divider on the side the divider moves away from.
 */
function dividerAnchor(
  axis: GridAxis,
  delta: number,
  lowLeaves: HerdrLayoutPane[],
  highLeaves: HerdrLayoutPane[],
): { anchor: HerdrLayoutPane; grow: boolean } {
  const anchor =
    delta > 0
      ? [...lowLeaves].sort((a, b) => axis.low(b.rect) - axis.low(a.rect))[0]
      : [...highLeaves].sort((a, b) => axis.low(a.rect) - axis.low(b.rect))[0];
  return { anchor, grow: delta > 0 };
}

/** One `herdr pane resize` step: move the divider on the pane's `direction` side by `amount` (a ratio delta). */
export interface HerdrResizeOp {
  paneId: string;
  direction: "left" | "right" | "up" | "down";
  amount: number;
}

/**
 * Slack (cells) for herdr containment checks: herdr rect coordinates are
 * ratio-derived floats, so edges can drift off an integer cell grid.
 */
const HERDR_RECT_TOLERANCE = 1.5;

/**
 * True when a layout pane lies fully inside `rect` within herdr's
 * float-drift tolerance. The herdr pane adapter over rectWithin, shared by
 * the columns and grid rebalance planners.
 */
function paneInRect(pane: HerdrLayoutPane, rect: HerdrRect): boolean {
  return rectWithin(pane.rect, rect, HERDR_RECT_TOLERANCE);
}

/**
 * True when `rect` lies fully inside `bounds` within a ±`tolerance`-cell
 * slack. The one containment primitive behind both backends' region checks:
 * herdr passes HERDR_RECT_TOLERANCE (float drift), tmux passes
 * TMUX_RECT_TOLERANCE (integer geometry).
 */
function rectWithin(
  rect: HerdrRect,
  bounds: HerdrRect,
  tolerance: number,
): boolean {
  return (
    rect.x >= bounds.x - tolerance &&
    rect.y >= bounds.y - tolerance &&
    rect.x + rect.width <= bounds.x + bounds.width + tolerance &&
    rect.y + rect.height <= bounds.y + bounds.height + tolerance
  );
}

/**
 * Shared guard for the herdr rebalance planners: sane region dimensions and a
 * full-height parent pane within the region (within tolerance — true for the
 * single-row column layout and the left parent grid strip alike). Returns the
 * pieces both planners start from, or null when rebalancing must be skipped.
 */
function herdrBalancePreflight(
  layout: HerdrLayout,
  parentPaneId: string,
  trackedPaneIds?: string[],
): { region: HerdrRect; parent: HerdrLayoutPane } | null {
  const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
  if (!parent) return null;

  const region = herdrGroupRegion(layout, parent, trackedPaneIds);
  if (!(region.width > 0) || !(region.height > 0)) return null;
  // Balancing assumes the parent fills the region's full height.
  if (parent.rect.height < region.height - 2 || parent.rect.y > region.y + 2)
    return null;

  return { region, parent };
}

/**
 * Width target per pane for the single-row column layout: parent at
 * `parentRatio` of the group region, each tracked column cell sharing the
 * rest equally, foreign panes inside the region keeping their width.
 * Returns null when there is nothing to balance or the targets cannot fit.
 */
function herdrColumnTargets(
  layout: HerdrLayout,
  parentPaneId: string,
  parent: HerdrLayoutPane,
  region: HerdrRect,
  parentRatio: number,
  trackedPaneIds: string[],
): ((pane: HerdrLayoutPane) => number) | null {
  const tracked = new Set(trackedPaneIds);
  // Column cells: tracked, full-height panes starting at/after the parent's
  // right edge.
  const parentRight = parent.rect.x + parent.rect.width;
  const cells = layout.panes
    .filter(
      (pane) =>
        tracked.has(pane.pane_id) &&
        pane.pane_id !== parentPaneId &&
        pane.rect.x >= parentRight - 1 &&
        pane.rect.height >= region.height - 2 &&
        pane.rect.y <= region.y + 2,
    )
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  // Foreign panes inside the region (user splits, another agent's panes)
  // keep their width — the cells share what they leave. Foreign panes
  // outside the region are not part of the group's layout at all.
  const cellIds = new Set(cells.map((cell) => cell.pane_id));
  if (cellIds.size === 0) return null; // nothing to balance
  const frozenSum = layout.panes
    .filter(
      (pane) =>
        pane.pane_id !== parentPaneId &&
        !cellIds.has(pane.pane_id) &&
        paneInRect(pane, region),
    )
    .reduce((sum, pane) => sum + pane.rect.width, 0);

  const parentTarget = parentRatio * region.width;
  const remaining = region.width - parentTarget - frozenSum;
  // cells is non-empty here (cellIds.size === 0 returned above). If their
  // combined share shrinks to a sliver, the layout cannot be balanced —
  // leave it alone.
  if (!(remaining > 5)) return null;
  const cellTarget = remaining / cells.length;

  return (pane: HerdrLayoutPane): number => {
    if (pane.pane_id === parentPaneId) return parentTarget;
    if (cellIds.has(pane.pane_id)) return cellTarget;
    return pane.rect.width; // anything else is foreign: keep current width
  };
}

/**
 * Walk the vertical splits inside `region` outermost-first, moving each
 * divider toward its side's width target. Empty when any divider move is
 * ambiguous — herdr could move either of two coincident dividers, so no op
 * can be trusted. Splits outside the region (dividers shared with foreign
 * panes) are never walked, so foreign panes cannot move.
 */
function herdrColumnDividerOps(
  layout: HerdrLayout,
  region: HerdrRect,
  targetWidth: (pane: HerdrLayoutPane) => number,
): HerdrResizeOp[] {
  // Outermost splits first, restricted to the group's own split subtree.
  const rightSplits = layout.splits.filter(
    (split) =>
      split.direction === "right" &&
      rectWithin(split.rect, region, HERDR_RECT_TOLERANCE),
  );
  const splits = [...rightSplits].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
  );

  let ambiguous = false;
  const ops: HerdrResizeOp[] = [];

  for (const split of splits) {
    const dividerX = split.rect.x + split.rect.width * split.ratio;
    const leftRect: HerdrRect = {
      x: split.rect.x,
      y: split.rect.y,
      width: dividerX - split.rect.x,
      height: split.rect.height,
    };
    const rightRect: HerdrRect = {
      x: dividerX,
      y: split.rect.y,
      width: split.rect.x + split.rect.width - dividerX,
      height: split.rect.height,
    };
    const leftLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, leftRect),
    );
    const rightLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, rightRect),
    );
    if (leftLeaves.length === 0 || rightLeaves.length === 0) continue;

    const leftTarget = leftLeaves.reduce(
      (sum, pane) => sum + targetWidth(pane),
      0,
    );
    const rightTarget = rightLeaves.reduce(
      (sum, pane) => sum + targetWidth(pane),
      0,
    );
    const delta = dividerDelta(leftTarget, rightTarget, split.ratio);
    if (delta === null) continue;

    const { anchor, grow } = dividerAnchor(
      AXIS_X,
      delta,
      leftLeaves,
      rightLeaves,
    );

    // The divider anchor must be flush against the divider — herdr resolves
    // the op by the anchor pane, so a non-adjacent pane would move the wrong
    // divider. Skip this split rather than guess.
    const anchorEdge = grow ? anchor.rect.x + anchor.rect.width : anchor.rect.x;
    if (Math.abs(anchorEdge - dividerX) > 1.5) continue;
    // A coincident divider from another split (possible in nested layouts,
    // e.g. a user split inside a column) makes the move ambiguous — herdr
    // could push either one — so abort the whole plan instead of resizing
    // an arbitrary pane.
    if (hasCoincidentDivider(rightSplits, split, anchor, dividerX)) {
      ambiguous = true;
      break;
    }

    ops.push({
      paneId: anchor.pane_id,
      direction: grow ? "right" : "left",
      amount: grow ? delta : -delta,
    });
  }
  return ambiguous ? [] : ops;
}

/**
 * Plan resizes that lay the group's region out as: parent at `parentRatio`
 * width on the left, every tracked column cell to its right sharing the rest
 * equally. Each split's ratio is targeted independently, so nesting depth
 * doesn't matter. The region is the bounding rect of the parent and its
 * tracked subagent panes; foreign panes (another agent, user splits — inside
 * or outside the region) are never moved. `trackedPaneIds` defaults to the
 * process's tracked herdr panes. Pure — no CLI calls.
 */
export function planHerdrRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds?: string[],
): HerdrResizeOp[] {
  const tracked = trackedPaneIds ?? herdrSubagentPaneList();
  const pre = herdrBalancePreflight(layout, parentPaneId, tracked);
  if (!pre) return [];
  const targetWidth = herdrColumnTargets(
    layout,
    parentPaneId,
    pre.parent,
    pre.region,
    parentRatio,
    tracked,
  );
  if (!targetWidth) return [];
  return herdrColumnDividerOps(layout, pre.region, targetWidth);
}

/**
 * True when another split's divider is coincident with `dividerX` while
 * overlapping `anchor` vertically — herdr could move either one, so the
 * resize is ambiguous and the whole plan must abort.
 */
function hasCoincidentDivider(
  rightSplits: HerdrLayoutSplit[],
  split: HerdrLayoutSplit,
  anchor: HerdrLayoutPane,
  dividerX: number,
): boolean {
  const overlapsY = (rect: HerdrRect): boolean =>
    anchor.rect.y < rect.y + rect.height + 1.5 &&
    anchor.rect.y + anchor.rect.height > rect.y - 1.5;
  for (const other of rightSplits) {
    if (other === split) continue;
    if (!overlapsY(other.rect)) continue;
    const otherX = other.rect.x + other.rect.width * other.ratio;
    if (Math.abs(otherX - dividerX) <= 1.5) return true;
  }
  return false;
}

/** Axis-specific accessors, so one planner serves both divider orientations. */
interface GridAxis {
  /** Low edge of a rect along this axis. */
  low: (rect: HerdrRect) => number;
  /** Extent of a rect along this axis. */
  size: (rect: HerdrRect) => number;
  /** Sub-rect of `split.rect` spanning `[low, low + size)` along this axis. */
  subRect: (split: HerdrLayoutSplit, low: number, size: number) => HerdrRect;
  /** herdr resize direction that moves the divider toward larger coordinates. */
  growDirection: "right" | "down";
  /** herdr resize direction that moves the divider toward smaller coordinates. */
  shrinkDirection: "left" | "up";
}

const AXIS_X: GridAxis = {
  low: (rect) => rect.x,
  size: (rect) => rect.width,
  subRect: (split, low, size) => ({
    x: low,
    y: split.rect.y,
    width: size,
    height: split.rect.height,
  }),
  growDirection: "right",
  shrinkDirection: "left",
};

const AXIS_Y: GridAxis = {
  low: (rect) => rect.y,
  size: (rect) => rect.height,
  subRect: (split, low, size) => ({
    x: split.rect.x,
    y: low,
    width: split.rect.width,
    height: size,
  }),
  growDirection: "down",
  shrinkDirection: "up",
};

/**
 * Bounding-box extent of the leaves' target rects along `axis` (stacked panes
 * share columns/rows, so summing extents would double-count).
 */
function dividerSideExtent(
  axis: GridAxis,
  leaves: HerdrLayoutPane[],
  targetRectOf: (pane: HerdrLayoutPane) => HerdrRect,
): number {
  let low = Infinity;
  let high = -Infinity;
  for (const leaf of leaves) {
    const rect = targetRectOf(leaf);
    low = Math.min(low, axis.low(rect));
    high = Math.max(high, axis.low(rect) + axis.size(rect));
  }
  return Number.isFinite(low) ? high - low : 0;
}

/**
 * Plan resize ops for one axis's dividers: each divider moves so its low side
 * holds `lowTarget / (lowTarget + highTarget)` of the split ratio, where the
 * side targets are bounding-box extents of the leaves' target rects (stacked
 * panes share columns/rows, so summing extents would double-count). Splits
 * are processed largest-area first. A split is skipped when either side has
 * no leaves, the targets sum to zero, or the chosen anchor pane isn't flush
 * against the divider — herdr resolves ops by the anchor pane, so aligned
 * grids with coincident dividers across columns are safe; a non-adjacent
 * anchor is not.
 */
function planDividerOps(
  axis: GridAxis,
  splits: HerdrLayoutSplit[],
  layout: HerdrLayout,
  targetRectOf: (pane: HerdrLayoutPane) => HerdrRect,
): HerdrResizeOp[] {
  const ops: HerdrResizeOp[] = [];

  for (const split of splits) {
    const start = axis.low(split.rect);
    const span = axis.size(split.rect);
    const divider = start + span * split.ratio;
    const lowLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, axis.subRect(split, start, divider - start)),
    );
    const highLeaves = layout.panes.filter((pane) =>
      paneInRect(pane, axis.subRect(split, divider, start + span - divider)),
    );
    if (lowLeaves.length === 0 || highLeaves.length === 0) continue;

    const delta = dividerDelta(
      dividerSideExtent(axis, lowLeaves, targetRectOf),
      dividerSideExtent(axis, highLeaves, targetRectOf),
      split.ratio,
    );
    if (delta === null) continue;

    const { anchor, grow } = dividerAnchor(axis, delta, lowLeaves, highLeaves);

    const anchorEdge = grow
      ? axis.low(anchor.rect) + axis.size(anchor.rect)
      : axis.low(anchor.rect);
    if (Math.abs(anchorEdge - divider) > 1.5) continue;

    ops.push({
      paneId: anchor.pane_id,
      direction: grow ? axis.growDirection : axis.shrinkDirection,
      amount: grow ? delta : -delta,
    });
  }
  return ops;
}

/**
 * Plan resizes that lay the group's region out as a tiled grid: parent at
 * `parentRatio` width on the left, tracked panes (fill order) in the
 * `gridDimsForCount` grid (round(sqrt(n)) rows × ceil(n/rows) columns) of
 * equal cells to its right. The region is the bounding rect of the parent
 * and its tracked panes — foreign panes are never touched, and a foreign
 * pane right of the parent inside the region bails the whole plan. Handles
 * both right-splits (vertical dividers) and down-splits (horizontal
 * dividers). Pure — no CLI calls.
 */
export function planHerdrGridRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  trackedPaneIds: string[],
  parentRatio: number,
): HerdrResizeOp[] {
  const pre = herdrBalancePreflight(layout, parentPaneId, trackedPaneIds);
  if (!pre) return [];
  const { region, parent } = pre;
  const ops: HerdrResizeOp[] = [];

  const tracked = trackedPaneIds.filter((id) =>
    layout.panes.some((pane) => pane.pane_id === id),
  );
  // A foreign pane right of the parent inside the region (a user split in
  // the grid area) would get wrecked by the rebalance — bail. Foreign panes
  // elsewhere are not ours to care about.
  const trackedSet = new Set(tracked);
  const parentRight = parent.rect.x + parent.rect.width;
  const isForeignInRegion = (pane: HerdrLayoutPane): boolean =>
    pane.pane_id !== parentPaneId &&
    !trackedSet.has(pane.pane_id) &&
    paneInRect(pane, region) &&
    pane.rect.x >= parentRight - 1;
  if (layout.panes.some(isForeignInRegion)) return ops;
  const targets = planGridTargets(tracked, region, parentRatio);
  if (!targets) return ops;

  const targetRectOf = (pane: HerdrLayoutPane): HerdrRect => {
    if (pane.pane_id === parentPaneId) return targets.parentRect;
    return targets.cells.get(pane.pane_id) ?? pane.rect; // foreign: frozen
  };

  const byAreaDesc = (a: HerdrLayoutSplit, b: HerdrLayoutSplit): number =>
    b.rect.width * b.rect.height - a.rect.width * a.rect.height;
  // Only the group's own split subtree: dividers shared with foreign panes
  // must never move.
  const inRegion = (split: HerdrLayoutSplit): boolean =>
    rectWithin(split.rect, region, HERDR_RECT_TOLERANCE);
  const verticalDividers = layout.splits
    .filter((split) => split.direction === "right" && inRegion(split))
    .sort(byAreaDesc);
  const horizontalDividers = layout.splits
    .filter((split) => split.direction === "down" && inRegion(split))
    .sort(byAreaDesc);

  ops.push(
    ...planDividerOps(AXIS_X, verticalDividers, layout, targetRectOf),
    ...planDividerOps(AXIS_Y, horizontalDividers, layout, targetRectOf),
  );
  return ops;
}

function applyHerdrResizeOps(ops: HerdrResizeOp[]): void {
  for (const op of ops) {
    try {
      execFileSync(
        "herdr",
        [
          "pane",
          "resize",
          "--pane",
          op.paneId,
          "--direction",
          op.direction,
          "--amount",
          op.amount.toFixed(4),
        ],
        { encoding: "utf8" },
      );
    } catch {
      // Best effort — herdr clamps ratios and refuses tiny moves.
    }
  }
}

/**
 * Rebalance: parent fixed width, subagents equal width. Runs up to three
 * plan→apply passes against a fresh layout to absorb rounding and clamp
 * residuals. Best effort — never blocks spawning.
 */
function rebalanceHerdrSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 3; pass++) {
    const layout = readHerdrLayout(parentPaneId);
    if (!layout) return;
    const ops = planHerdrRebalance(layout, parentPaneId, herdrParentRatio());
    if (ops.length === 0) return;
    applyHerdrResizeOps(ops);
  }
}

/**
 * The region this agent group owns: the bounding rect of the parent pane and
 * its tracked subagent panes present in the layout. When the tab is shared
 * with foreign panes (another agent, user splits), the group only claims the
 * parent's own panel — subagents split within it and rebalancing never moves
 * panes outside it. A solo parent's region is exactly its own rect; in an
 * unshared tab that is the whole tab, so the layout math is unchanged.
 */
function herdrGroupRegion(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
  trackedPaneIds?: string[],
): HerdrRect {
  const tracked = new Set(trackedPaneIds ?? herdrSubagentPaneList());
  return boundingRect([
    parent.rect,
    ...layout.panes
      .filter((pane) => tracked.has(pane.pane_id))
      .map((pane) => pane.rect),
  ]);
}

/**
 * The subagent area a tiled spawn carves from: the group region minus the
 * parent strip — right of the parent, within the group's own region, so a
 * shared-tab spawn never reaches into foreign panes.
 */
function subagentArea(group: GridRect, parentRight: number): GridRect {
  return {
    x: parentRight,
    y: group.y,
    width: group.x + group.width - parentRight,
    height: group.height,
  };
}

/** Subagent area for herdr: right of the parent, inside the group region. */
function herdrSubagentArea(
  layout: HerdrLayout,
  parent: HerdrLayoutPane,
): HerdrRect {
  return subagentArea(
    herdrGroupRegion(layout, parent),
    parent.rect.x + parent.rect.width,
  );
}

/**
 * Read the layout, waiting briefly for herdr to materialize all tracked panes.
 * Under load (several pi instances launching at once), `pane layout` can lag a
 * split by a few ms — planning against a layout that is missing the new pane
 * would compute zero ops and leave the raw split geometry in place. Returns
 * null while the layout is incomplete or unreadable.
 */
function waitForHerdrTrackedPanes(
  parentPaneId: string,
  timeoutMs = 500,
): HerdrLayout | null {
  const tracked = herdrSubagentPaneList();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const layout = readHerdrLayout(parentPaneId);
    if (layout) {
      const present = new Set(layout.panes.map((pane) => pane.pane_id));
      if (tracked.every((id) => present.has(id))) return layout;
    }
    sleepSync(50);
  }
  return null;
}

/**
 * Rebalance into the tiled grid. Runs up to three plan→apply passes against a
 * fresh layout to absorb rounding and clamp residuals. Best effort — never
 * blocks spawning.
 */
function rebalanceHerdrGridLayout(parentPaneId: string): void {
  const tracked = herdrSubagentPaneList();
  if (tracked.length === 0) return;
  for (let pass = 0; pass < 3; pass++) {
    const layout =
      pass === 0
        ? waitForHerdrTrackedPanes(parentPaneId)
        : readHerdrLayout(parentPaneId);
    if (!layout) return;
    const ops = planHerdrGridRebalance(
      layout,
      parentPaneId,
      tracked,
      herdrParentRatio(),
    );
    if (ops.length === 0) return;
    applyHerdrResizeOps(ops);
  }
}

const HERDR_DEFERRED_REBALANCE_KEY = Symbol.for(
  "pi-subagents/herdr-deferred-rebalance",
);

/**
 * Schedule trailing rebalances ~400ms apart (coalesced). Safety net for races:
 * whichever spawn or close ran last, these passes re-read the settled layout
 * and equalize anything the synchronous rebalance missed. Stops after 5 passes
 * once the plan reports nothing left to do; while the layout keeps failing to
 * read, retries up to 10 ticks before giving up.
 */
function scheduleHerdrDeferredRebalance(parentPaneId: string): void {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[HERDR_DEFERRED_REBALANCE_KEY] as
    | NodeJS.Timeout
    | undefined;
  if (existing) clearTimeout(existing);

  let attempts = 0;

  function tick(): void {
    attempts += 1;
    try {
      const tiled = getSubagentLayoutMode() === "tiled";
      const tracked = herdrSubagentPaneList();
      // "Zero ops" only counts as converged when the layout actually shows
      // every tracked pane — a stale read must keep retrying, not stop.
      const layout =
        tiled && tracked.length > 0
          ? waitForHerdrTrackedPanes(parentPaneId, 300)
          : readHerdrLayout(parentPaneId);
      if (!layout) {
        if (attempts >= 10) stop();
        else scheduleNext();
        return;
      }
      const ops = tiled
        ? planHerdrGridRebalance(
            layout,
            parentPaneId,
            tracked,
            herdrParentRatio(),
          )
        : planHerdrRebalance(layout, parentPaneId, herdrParentRatio());
      if (ops.length > 0) applyHerdrResizeOps(ops);
      if (ops.length === 0 || attempts >= 5) {
        stop();
        return;
      }
    } catch {
      // Best effort — never surface deferred-rebalance failures.
    }
    scheduleNext();
  }

  function scheduleNext(): void {
    const timer = setTimeout(tick, 400);
    timer.unref?.();
    store[HERDR_DEFERRED_REBALANCE_KEY] = timer;
  }

  function stop(): void {
    delete store[HERDR_DEFERRED_REBALANCE_KEY];
  }

  scheduleNext();
}

/**
 * Rebalance the herdr tab in the configured layout mode (tiled grid or
 * equal-width columns). Best effort — never blocks spawning.
 */
function rebalanceHerdrLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceHerdrGridLayout(parentPaneId);
  } else {
    rebalanceHerdrSubagentLayout(parentPaneId);
  }
}

/**
 * Create a herdr subagent surface. The group (parent + tracked subagent
 * panes) only ever claims the parent's own panel: when the tab is shared
 * with foreign panes, splits and rebalancing stay inside the group region.
 * In "columns" mode (default) the first subagent splits the parent and new
 * subagents split the rightmost tracked subagent pane; rebalancing keeps the
 * parent at `PI_SUBAGENT_HERDR_PARENT_RATIO` (default 0.4) of the group
 * region and all subagent panes equally wide. In "tiled" mode subagents fill
 * the gridDimsForCount grid (round(sqrt(n)) rows × ceil(n/rows) columns)
 * right of the parent: each spawn splits the pane covering the next grid
 * cell (right/down) and the grid is rebalanced afterwards.
 */
function createHerdrSubagentSurface(name: string): string {
  const parentPaneId = process.env.HERDR_PANE_ID;
  const tiled = getSubagentLayoutMode() === "tiled";

  let anchorPaneId = parentPaneId ?? undefined;
  let splitDirection: "right" | "down" = "right";

  if (parentPaneId) {
    const layout = readHerdrLayout(parentPaneId);
    if (layout) {
      const known = new Set(layout.panes.map((pane) => pane.pane_id));
      setHerdrSubagentPaneList(
        herdrSubagentPaneList().filter((id) => known.has(id)),
      );
      const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
      if (parent) {
        const tracked = herdrSubagentPaneList();
        const placed = placedPanes(
          tracked,
          layout.panes,
          (pane) => pane.pane_id,
          (pane) => pane.rect,
        );
        const selection = tiled
          ? selectTiledGridAnchor(
              placed,
              herdrSubagentArea(layout, parent),
              tracked.length + 1,
            )
          : null;
        if (selection) {
          anchorPaneId = selection.anchorPaneId;
          splitDirection = selection.direction;
        } else {
          // Columns mode, or tiled fallback: split the rightmost tracked pane
          // (the pane list survives /reload). No tracked pane yet — first
          // spawn, or a fresh process whose pane list is gone — leaves the
          // anchor at the parent rather than carving up a foreign pane.
          const anchor = rightmostAnchor(
            placed,
            parent.rect.x + parent.rect.width,
          );
          if (anchor) anchorPaneId = anchor;
        }
      }
    }
  }

  const paneId = createSurfaceSplit(name, splitDirection, anchorPaneId);
  herdrTrackPane(paneId);
  if (parentPaneId) {
    rebalanceHerdrLayoutForMode(parentPaneId);
    scheduleHerdrDeferredRebalance(parentPaneId);
  }
  return paneId;
}

export interface TmuxPaneGeometry {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
}

const TMUX_GEOMETRY_FORMAT =
  "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}|#{window_height}";

export function parseTmuxPaneGeometry(output: string): TmuxPaneGeometry[] {
  const panes: TmuxPaneGeometry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [paneId, left, top, width, height, windowWidth, windowHeight] = parts;
    if (!paneId.startsWith("%")) continue;
    const nums = [left, top, width, height, windowWidth, windowHeight].map(
      Number,
    );
    if (nums.some((n) => !Number.isFinite(n))) continue;
    panes.push({
      paneId,
      left: nums[0],
      top: nums[1],
      width: nums[2],
      height: nums[3],
      windowWidth: nums[4],
      windowHeight: nums[5],
    });
  }
  return panes;
}

function readTmuxPaneGeometry(targetPaneId?: string): TmuxPaneGeometry[] {
  const args = ["list-panes", "-F", TMUX_GEOMETRY_FORMAT];
  if (targetPaneId) args.push("-t", targetPaneId);
  try {
    return parseTmuxPaneGeometry(
      execFileSync("tmux", args, { encoding: "utf8" }),
    );
  } catch {
    return [];
  }
}

/** Tracked tmux subagent panes; globalThis + Symbol.for so it survives /reload. */
const TMUX_SUBAGENT_PANES_KEY = Symbol.for("pi-subagents/tmux-subagent-panes");

/** Tracked tmux subagent pane ids, in spawn order (defines grid fill order). */
function tmuxSubagentPaneList(): string[] {
  const store = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(store[TMUX_SUBAGENT_PANES_KEY])) {
    store[TMUX_SUBAGENT_PANES_KEY] = [];
  }
  return store[TMUX_SUBAGENT_PANES_KEY] as string[];
}

/** Replace the tracked tmux subagent pane list. Exported for tests. */
export function setTmuxSubagentPaneList(paneIds: string[]): void {
  (globalThis as Record<symbol, unknown>)[TMUX_SUBAGENT_PANES_KEY] = [
    ...paneIds,
  ];
}

/**
 * Track a spawned tmux subagent pane so layout ops stay in the group
 * (idempotent).
 */
function tmuxTrackPane(paneId: string): void {
  const panes = tmuxSubagentPaneList();
  if (!panes.includes(paneId)) panes.push(paneId);
}

/** Forget a tmux subagent pane after its surface closes. */
function tmuxUntrackPane(paneId: string): void {
  setTmuxSubagentPaneList(tmuxSubagentPaneList().filter((id) => id !== paneId));
}

function tmuxParentRatio(): number {
  return parentRatioFromEnv("PI_SUBAGENT_TMUX_PARENT_RATIO");
}

/** One `tmux resize-pane -x` step: set the pane's absolute column count. */
export interface TmuxResizeOp {
  paneId: string;
  width: number;
}

/** A pane's geometry as a window-relative rect. */
function tmuxPaneRect(pane: TmuxPaneGeometry): GridRect {
  return {
    x: pane.left,
    y: pane.top,
    width: pane.width,
    height: pane.height,
  };
}

/**
 * The region this agent group owns: the bounding rect (window-relative) of
 * the parent pane and its tracked subagent panes, folded by boundingRect.
 * Foreign panes (another agent, user splits) are never split or resized;
 * the rebalance planners only ever measure and move inside this region.
 */
function tmuxGroupRegion(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
  trackedPaneIds?: string[],
): GridRect {
  const tracked = new Set(trackedPaneIds ?? tmuxSubagentPaneList());
  return boundingRect([
    tmuxPaneRect(parent),
    ...panes.filter((pane) => tracked.has(pane.paneId)).map(tmuxPaneRect),
  ]);
}

/** Subagent area for tmux: right of the parent, inside the group region. */
function tmuxSubagentArea(
  panes: TmuxPaneGeometry[],
  parent: TmuxPaneGeometry,
): GridRect {
  return subagentArea(
    tmuxGroupRegion(panes, parent),
    parent.left + parent.width,
  );
}

/**
 * Slack (window cells) for tmux containment checks: pane geometry is integer
 * columns/rows, nudged by absolute resizes.
 */
const TMUX_RECT_TOLERANCE = 1;

/**
 * True when a pane lies fully inside `region` within tmux's integer-geometry
 * tolerance — the tmux pane adapter over rectWithin.
 */
function tmuxPaneInRegion(pane: TmuxPaneGeometry, region: GridRect): boolean {
  return rectWithin(tmuxPaneRect(pane), region, TMUX_RECT_TOLERANCE);
}

/**
 * Parent pane, group region, and the tracked full-height column cells right
 * of the parent for the single-row column layout, or null when there is
 * nothing to balance or a foreign pane sits inside the region (absolute
 * widths could not be honored without moving it).
 */
function tmuxColumnLayout(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  trackedPaneIds?: string[],
): {
  parent: TmuxPaneGeometry;
  region: GridRect;
  cells: TmuxPaneGeometry[];
} | null {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return null;
  const region = tmuxGroupRegion(panes, parent, trackedPaneIds);
  if (!(region.width > 0)) return null;

  const tracked = new Set(trackedPaneIds ?? tmuxSubagentPaneList());
  const parentRight = parent.left + parent.width;
  const cells = panes
    .filter(
      (pane) =>
        tracked.has(pane.paneId) &&
        pane.paneId !== parentPaneId &&
        pane.left >= parentRight - 1 &&
        pane.height >= parent.height - 1 &&
        pane.top <= parent.top + 1,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  if (cells.length === 0) return null;
  // Absolute-width resizes cannot leave room for a foreign pane inside the
  // region — bail instead of squeezing it.
  const foreignInside = panes.some(
    (pane) =>
      pane.paneId !== parentPaneId &&
      !tracked.has(pane.paneId) &&
      tmuxPaneInRegion(pane, region),
  );
  if (foreignInside) return null;
  return { parent, region, cells };
}

/** Absolute-width resize toward `target`, or undefined when within 1 column. */
function tmuxWidthOp(
  paneId: string,
  current: number,
  target: number,
): TmuxResizeOp | undefined {
  if (Math.abs(current - target) <= 1) return undefined;
  return { paneId, width: target };
}

/**
 * Plan absolute-width resizes that lay the group region out as: parent at
 * `parentRatio` of the region on the left, every tracked full-height pane to
 * its right sharing the rest equally. `trackedPaneIds` defaults to the
 * process's tracked tmux panes. Returns no ops when the layout cannot be
 * balanced (see tmuxColumnLayout). Pure — no CLI calls.
 */
export function planTmuxRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  parentRatio: number,
  trackedPaneIds?: string[],
): TmuxResizeOp[] {
  const layout = tmuxColumnLayout(panes, parentPaneId, trackedPaneIds);
  if (!layout) return [];
  const { parent, region, cells } = layout;

  const parentTarget = Math.round(parentRatio * region.width);
  const remaining = region.width - parentTarget;
  // Every cell needs at least two columns to be worth resizing.
  if (remaining < cells.length * 2) return [];

  const cellTarget = Math.floor(remaining / cells.length);
  const ops: TmuxResizeOp[] = [];
  const parentOp = tmuxWidthOp(parentPaneId, parent.width, parentTarget);
  if (parentOp) ops.push(parentOp);
  for (const cell of cells) {
    const op = tmuxWidthOp(cell.paneId, cell.width, cellTarget);
    if (op) ops.push(op);
  }
  return ops;
}

function applyTmuxResizeOps(ops: TmuxResizeOp[]): void {
  for (const op of ops) {
    try {
      execFileSync(
        "tmux",
        ["resize-pane", "-t", op.paneId, "-x", String(op.width)],
        {
          encoding: "utf8",
        },
      );
    } catch {
      // Best effort — tmux clamps to minimum pane sizes.
    }
  }
}

/**
 * Rebalance: parent fixed width, subagents equal width. Second pass absorbs
 * any drift from tmux's size clamps. Best effort — never blocks spawning.
 */
function rebalanceTmuxSubagentLayout(parentPaneId: string): void {
  for (let pass = 0; pass < 2; pass++) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length === 0) return;
    const ops = planTmuxRebalance(panes, parentPaneId, tmuxParentRatio());
    if (ops.length === 0) return;
    applyTmuxResizeOps(ops);
  }
}

/** One tmux resize step for the tiled grid: absolute width and/or height. */
export interface TmuxGridResizeOp {
  paneId: string;
  width?: number;
  height?: number;
}

/**
 * Target size along one axis, or undefined when no resize is needed: the pane
 * is within 1 of the target, or it already reaches past its target toward the
 * region's far edge (masonry panes tmux cannot shrink away from the edge).
 */
function tmuxAxisTarget(
  current: number,
  target: number,
  paneAtFarEdge: boolean,
  targetAtFarEdge: boolean,
): number | undefined {
  if (Math.abs(current - target) <= 1) return undefined;
  if (paneAtFarEdge && !targetAtFarEdge) return undefined;
  return Math.round(target);
}

/** Absolute width/height resize toward `cell`, or undefined when balanced. */
function tmuxGridPaneOp(
  pane: TmuxPaneGeometry,
  cell: GridRect,
  region: GridRect,
): TmuxGridResizeOp | undefined {
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;
  const width = tmuxAxisTarget(
    pane.width,
    cell.width,
    pane.left + pane.width >= regionRight - 1,
    cell.x + cell.width >= regionRight - 1,
  );
  const height = tmuxAxisTarget(
    pane.height,
    cell.height,
    pane.top + pane.height >= regionBottom - 1,
    cell.y + cell.height >= regionBottom - 1,
  );
  if (width === undefined && height === undefined) return undefined;
  return { paneId: pane.paneId, width, height };
}

/**
 * Plan absolute resizes that lay the group's region out as a tiled grid:
 * parent at `parentRatio` width on the left (full height), tracked panes
 * (fill order) in equal cells to its right. Foreign panes are never touched;
 * a foreign pane right of the parent inside the region bails the whole plan
 * (absolute widths cannot be honored around it). Masonry panes tmux cannot
 * shrink away from the region's far edge are left alone. Pure — no CLI calls.
 */
export function planTmuxGridRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  trackedPaneIds: string[],
  parentRatio: number,
): TmuxGridResizeOp[] {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return [];
  const tracked = trackedPaneIds.filter((id) =>
    panes.some((pane) => pane.paneId === id),
  );
  // The group's own region: parent + tracked panes — never the whole window
  // when the tab is shared with foreign panes.
  const region = tmuxGroupRegion(panes, parent, tracked);
  if (!(region.width > 0) || !(region.height > 0)) return [];
  if (!(parent.width > 0)) return [];

  // A foreign pane right of the parent inside the region (a user split in
  // the grid area) would get wrecked by the rebalance — bail. Foreign panes
  // elsewhere are not ours to care about.
  const trackedSet = new Set(tracked);
  const parentRight = parent.left + parent.width;
  const isForeignInRegion = (pane: TmuxPaneGeometry): boolean =>
    pane.paneId !== parentPaneId &&
    !trackedSet.has(pane.paneId) &&
    tmuxPaneInRegion(pane, region) &&
    pane.left >= parentRight - 1;
  if (panes.some(isForeignInRegion)) return [];
  const targets = planGridTargets(tracked, region, parentRatio);
  if (!targets) return [];

  const ops: TmuxGridResizeOp[] = [];
  if (Math.abs(parent.width - targets.parentRect.width) > 1) {
    ops.push({
      paneId: parentPaneId,
      width: Math.round(targets.parentRect.width),
    });
  }
  for (const [paneId, cell] of targets.cells) {
    const pane = panes.find((p) => p.paneId === paneId);
    const op = pane ? tmuxGridPaneOp(pane, cell, region) : undefined;
    if (op) ops.push(op);
  }
  return ops;
}

function applyTmuxGridResizeOps(ops: TmuxGridResizeOp[]): void {
  for (const op of ops) {
    try {
      // tmux resizes one axis at a time: `-x` sets columns, `-y` sets rows.
      const axes = [
        ["-x", op.width],
        ["-y", op.height],
      ] as const;
      for (const [flag, size] of axes) {
        if (size === undefined) continue;
        execFileSync(
          "tmux",
          ["resize-pane", "-t", op.paneId, flag, String(size)],
          {
            encoding: "utf8",
          },
        );
      }
    } catch {
      // Best effort — tmux clamps to minimum pane sizes.
    }
  }
}

/**
 * Rebalance into the tiled grid: parent fixed width, tracked panes in equal
 * cells. Second pass absorbs any drift from tmux's size clamps. Best effort
 * — never blocks spawning.
 */
function rebalanceTmuxGridLayout(parentPaneId: string): void {
  const tracked = tmuxSubagentPaneList();
  if (tracked.length === 0) return;
  for (let pass = 0; pass < 2; pass++) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length === 0) return;
    const ops = planTmuxGridRebalance(
      panes,
      parentPaneId,
      tracked,
      tmuxParentRatio(),
    );
    if (ops.length === 0) return;
    applyTmuxGridResizeOps(ops);
  }
}

/**
 * Rebalance the tmux window in the configured layout mode (tiled grid or
 * equal-width columns). Best effort — never blocks spawning.
 */
function rebalanceTmuxLayoutForMode(parentPaneId: string): void {
  if (getSubagentLayoutMode() === "tiled") {
    rebalanceTmuxGridLayout(parentPaneId);
  } else {
    rebalanceTmuxSubagentLayout(parentPaneId);
  }
}

/**
 * Create a tmux subagent surface. The group (parent + tracked subagent
 * panes) only ever claims the parent's own panel: when the window is shared
 * with foreign panes, splits and rebalancing stay inside the group region.
 * In "columns" mode (default) the first subagent splits the parent and new
 * subagents split the rightmost tracked subagent pane; rebalancing keeps the
 * parent at `PI_SUBAGENT_TMUX_PARENT_RATIO` (default 0.4) of the group
 * region and all subagent panes equally wide. In "tiled" mode subagents fill
 * the gridDimsForCount grid (round(sqrt(n)) rows × ceil(n/rows) columns)
 * right of the parent: each spawn splits the pane covering the next grid
 * cell (right/down) and the grid is rebalanced afterwards.
 */
function createTmuxSubagentSurface(name: string): string {
  const parentPaneId = process.env.TMUX_PANE;
  const tiled = getSubagentLayoutMode() === "tiled";

  let anchorPaneId = parentPaneId ?? undefined;
  let splitDirection: "right" | "down" = "right";

  if (parentPaneId) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length > 0) {
      const known = new Set(panes.map((pane) => pane.paneId));
      setTmuxSubagentPaneList(
        tmuxSubagentPaneList().filter((id) => known.has(id)),
      );
      const parent = panes.find((pane) => pane.paneId === parentPaneId);
      if (parent) {
        const tracked = tmuxSubagentPaneList();
        const placed = placedPanes(
          tracked,
          panes,
          (pane) => pane.paneId,
          tmuxPaneRect,
        );
        // Subagent area: right of the parent, clipped to the group region so
        // a shared-tab spawn never lands in a foreign pane.
        const area = tmuxSubagentArea(panes, parent);
        const selection = tiled
          ? selectTiledGridAnchor(placed, area, tracked.length + 1)
          : null;
        if (selection) {
          anchorPaneId = selection.anchorPaneId;
          splitDirection = selection.direction;
        } else {
          // Columns mode, or tiled fallback: split the rightmost tracked pane
          // (the pane list survives /reload). No tracked pane yet — first
          // spawn, or a fresh process whose pane list is gone — leaves the
          // anchor at the parent rather than carving up a foreign pane.
          const anchor = rightmostAnchor(placed, parent.left + parent.width);
          if (anchor) anchorPaneId = anchor;
        }
      }
    }
  }

  const paneId = createSurfaceSplit(name, splitDirection, anchorPaneId);
  tmuxTrackPane(paneId);
  if (parentPaneId) {
    rebalanceTmuxLayoutForMode(parentPaneId);
  }
  return paneId;
}

/** Whether herdr currently detects a working agent turn in the given pane. */
function isHerdrAgentWorking(surface: string): Promise<boolean> {
  return execFileAsync("herdr", ["agent", "get", surface], { encoding: "utf8" })
    .then(
      ({ stdout }) =>
        JSON.parse(stdout)?.result?.agent?.agent_status === "working",
    )
    .catch(() => false);
}

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For zellij: chooses a tab-aware tiled or stacked placement.
 * For herdr: splits the rightmost tracked subagent pane (no focus steal),
 * keeping the parent pane at a fixed share of the group region, then
 * rebalances so all subagent panes are equally wide
 * (`PI_SUBAGENT_HERDR_PARENT_RATIO`, default 0.4). When the tab is shared
 * with foreign panes (another agent, user splits), the group only claims
 * the parent's own panel — foreign panes are never split or resized. In
 * "tiled" mode both herdr and tmux instead fill a grid right of the parent —
 * see createHerdrSubagentSurface / createTmuxSubagentSurface.
 * For tmux: same balanced layout as herdr (`PI_SUBAGENT_TMUX_PARENT_RATIO`),
 * using absolute `resize-pane -x` widths.
 * For wezterm: falls back to split behavior.
 *
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm, `w1:p7` in herdr).
 */
export function createSurface(name: string): string {
  const backend = getMuxBackend();

  if (backend === "cmux" && cmuxSubagentPane) {
    // Verify the pane still exists before adding a tab to it
    try {
      const tree = execSync(`cmux tree`, { encoding: "utf8" });
      if (tree.includes(cmuxSubagentPane)) {
        return createSurfaceInPane(name, cmuxSubagentPane);
      }
    } catch {}
    // Pane is gone — fall through to create a new split
    cmuxSubagentPane = null;
  }

  if (backend === "cmux") {
    const created = createCmuxSplitSurface(
      name,
      "right",
      process.env.CMUX_SURFACE_ID,
    );
    cmuxSubagentPane = created.paneRef ?? null;
    return created.surface;
  }

  if (backend === "zellij") {
    return createZellijSurface(name);
  }

  if (backend === "herdr") {
    return createHerdrSubagentSurface(name);
  }

  if (backend === "tmux") {
    return createTmuxSubagentSurface(name);
  }

  // wezterm: split the parent (no pane-position API for a balanced layout yet).
  return createSurfaceSplit(name, "right", process.env.WEZTERM_PANE);
}

/**
 * Create a new surface (tab) in an existing cmux pane.
 */
function createSurfaceInPane(name: string, pane: string): string {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const output = execFileSync("cmux", ["new-surface", "--pane", pane], {
      encoding: "utf8",
    }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm, `w1:p7` in herdr).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return createCmuxSplitSurface(name, direction, fromSurface).surface;
  }

  if (backend === "herdr") {
    // herdr supports only right/down splits; left/up fall back to the nearest equivalent.
    const herdrDirection =
      direction === "left" || direction === "right" ? "right" : "down";
    const args = [
      "pane",
      "split",
      "--direction",
      herdrDirection,
      "--no-focus",
      "--cwd",
      process.cwd(),
    ];
    const anchor = fromSurface ?? process.env.HERDR_PANE_ID;
    if (anchor) {
      args.push("--pane", anchor);
    }
    const output = execFileSync("herdr", args, { encoding: "utf8" }).trim();
    const paneId = parseHerdrPaneId(output, "pane split");
    execFileSync("herdr", ["pane", "rename", paneId, name], {
      encoding: "utf8",
    });
    return paneId;
  }

  if (backend === "tmux") {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    return pane;
  }

  if (backend === "wezterm") {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(
        `Unexpected wezterm split-pane output: ${paneId || "(empty)"}`,
      );
    }
    try {
      execFileSync(
        "wezterm",
        ["cli", "set-tab-title", "--pane-id", paneId, name],
        {
          encoding: "utf8",
        },
      );
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  // zellij
  const directionArg =
    direction === "left" || direction === "right" ? "right" : "down";
  const args = [
    "new-pane",
    "--direction",
    directionArg,
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];

  let rawId: string;
  try {
    rawId = zellijActionSync(args, fromSurface).trim();
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    rawId = zellijActionSync(args).trim();
  }

  // zellij returns the pane ID as e.g. "terminal_7" — extract the numeric part.
  // Previously we sent `write-chars "echo $ZELLIJ_PANE_ID"` to a temp file, but
  // `write-chars` without --pane-id targets the focused pane, which raced on tab switches.
  const surface = parseZellijPaneSurface(rawId, "new-pane");

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(
      `cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`,
      {
        encoding: "utf8",
      },
    );
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{window_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) throw new Error("HERDR_PANE_ID not set");
    execFileSync("herdr", ["pane", "rename", paneId, title], {
      encoding: "utf8",
    });
    return;
  }

  // zellij: rename the agent's own pane, not the whole tab. In multi-pane layouts,
  // rename-tab clobbers the user's tab title whenever a subagent starts or /plan runs.
  // Closes #21.
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (paneId) {
    zellijActionSync(["rename-pane", title], `pane:${paneId}`);
  } else {
    zellijActionSync(["rename-pane", title]);
  }
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(
      `cmux workspace-action --action rename --title ${shellEscape(title)}`,
      {
        encoding: "utf8",
      },
    );
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
    return;
  }

  if (backend === "herdr") {
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID not set");
    execFileSync("herdr", ["workspace", "rename", workspaceId, title], {
      encoding: "utf8",
    });
    return;
  }

  // Skip session rename for zellij. rename-session renames the socket file
  // but the ZELLIJ_SESSION_NAME env var in the parent process keeps the old
  // name, so all subsequent `zellij action ...` CLI calls fail with
  // "There is no active session!" because the CLI can't find the socket.
  // Additionally, pi titles often contain special characters (em dashes,
  // spaces) that fail zellij's session name validation on lookup.
  // rename-tab (called separately) is sufficient for user-visible naming.
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(
      `cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`,
      {
        encoding: "utf8",
      },
    );
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
      encoding: "utf8",
    });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-text", surface, command], {
      encoding: "utf8",
    });
    execFileSync("herdr", ["pane", "send-keys", surface, "Enter"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", `${command}\n`],
      { encoding: "utf8" },
    );
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  // zellij "write" takes raw bytes — 13 = Enter (CR), the tmux/herdr
  // equivalents send the named "Enter" key.
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execFileSync("cmux", ["send", "--surface", surface, "\u001b"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-keys", surface, "esc"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"],
      {
        encoding: "utf8",
      },
    );
    return;
  }

  // 27 = Escape.
  zellijActionSync(["write", "27"], surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, `${scriptParts.join("\n")}\n`, {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(
      `cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "herdr") {
    return execFileSync(
      "herdr",
      ["pane", "read", surface, "--lines", String(Math.max(1, lines))],
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "wezterm") {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      {
        encoding: "utf8",
      },
    );
    return tailLines(raw, lines);
  }

  // Zellij 0.44+: dump-screen to stdout via --pane-id instead of env var +
  // temp file. The ZELLIJ_PANE_ID env var doesn't reliably target other panes
  // for dump-screen, and --path may silently fail to create the file. Stdout
  // capture is robust.
  const raw = zellijActionSync(["dump-screen"], surface);
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(
  surface: string,
  lines = 50,
): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "herdr") {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", surface, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "wezterm") {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      {
        encoding: "utf8",
      },
    );
    return tailLines(stdout, lines);
  }

  // Zellij 0.44+: dump-screen to stdout via --pane-id (see readScreen).
  const { stdout } = await execFileAsync(
    "zellij",
    zellijActionArgs(["dump-screen"], surface),
    {
      encoding: "utf8",
    },
  );
  return tailLines(stdout, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    // Rebalance the remaining subagent panes so they share the freed space.
    if (tmuxSubagentPaneList().includes(surface)) {
      tmuxUntrackPane(surface);
      const parentPaneId = process.env.TMUX_PANE;
      if (parentPaneId) {
        rebalanceTmuxLayoutForMode(parentPaneId);
      }
    }
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    // Rebalance the remaining subagent panes so they share the freed space.
    if (herdrSubagentPaneList().includes(surface)) {
      herdrUntrackPane(surface);
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (parentPaneId) {
        rebalanceHerdrLayoutForMode(parentPaneId);
        scheduleHerdrDeferredRebalance(parentPaneId);
      }
    }
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["close-pane"], surface);
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/** Shape of the `.exit` sidecar JSON written by the child extension. */
interface ExitSidecarPayload {
  type?: unknown;
  name?: unknown;
  message?: unknown;
  errorMessage?: unknown;
}

/**
 * Read + consume the `.exit` sidecar for a session file. Returns the decoded
 * PollResult, or null when the sidecar does not exist / is not yet readable.
 */
function readExitSidecar(sessionFile: string): PollResult | null {
  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: unknown): PollResult {
  const payload = (
    typeof data === "object" && data !== null ? data : {}
  ) as ExitSidecarPayload;

  if (payload.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: {
        name: typeof payload.name === "string" ? payload.name : "subagent",
        message: typeof payload.message === "string" ? payload.message : "",
      },
    };
  }
  if (payload.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" &&
      payload.errorMessage.trim() !== ""
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      const sidecar = readExitSidecar(options.sessionFile);
      if (sidecar) return sidecar;
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        const sidecar = readExitSidecar(options.sessionFile);
        if (sidecar) return sidecar;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    // herdr: block on `agent wait` instead of blind sampling — it returns as
    // soon as the agent settles (idle/blocked/gone), avoiding a hot loop.
    if (getMuxBackend() === "herdr" && (await isHerdrAgentWorking(surface))) {
      const wait = execFileAsync(
        "herdr",
        [
          "agent",
          "wait",
          surface,
          "--until",
          "idle",
          "--until",
          "blocked",
          "--until",
          "unknown",
          "--timeout",
          String(options.interval),
        ],
        { encoding: "utf8" },
      );
      const abort = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          wait.child?.kill();
          return reject(new Error("Aborted"));
        }
        signal.addEventListener(
          "abort",
          () => {
            wait.child?.kill();
            reject(new Error("Aborted"));
          },
          { once: true },
        );
      });
      await Promise.race([
        wait.then(
          () => undefined,
          () => undefined,
        ),
        abort,
      ]);
      continue;
    }

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

import { execSync, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
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
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

function isHerdrRuntimeAvailable(): boolean {
  const insideHerdr = process.env.HERDR_ENV === "1" || process.env.TERM_PROGRAM === "herdr";
  return insideHerdr && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
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
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
  "send-keys",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  // Don't double-add if caller already specified it.
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
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
  | { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

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

export function predictZellijSplitDirection(pane: ZellijPaneSnapshot): ZellijSplitDirection | null {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) return null;

  if (rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns && rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2) {
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
): { parentPane: ZellijPaneSnapshot; tabPanes: ZellijPaneSnapshot[] } | null {
  const parentPane = panes.find((pane) => !pane.is_plugin && pane.id === parentPaneId);
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;

  const tabPanes = panes
    .filter((pane) => pane.tab_id === parentPane.tab_id)
    .filter(isUsableZellijTiledPane);

  return { parentPane, tabPanes };
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
    tabId: tabInfo.parentPane.tab_id!,
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
    .map((pane) => ({ pane, splitDirection: predictZellijSplitDirection(pane) }))
    .filter(
      (
        candidate,
      ): candidate is { pane: ZellijPaneSnapshot; splitDirection: ZellijSplitDirection } =>
        candidate.splitDirection !== null &&
        canSplitZellijPane(candidate.pane, ZELLIJ_MIN_TERMINAL_WIDTH, ZELLIJ_MIN_TERMINAL_HEIGHT),
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
    const splitTarget = safeSplitCandidates.sort((a, b) => paneArea(b.pane) - paneArea(a.pane))[0];
    return {
      mode: "split",
      anchorPaneId: splitTarget.pane.id,
      targetPaneId: splitTarget.pane.id,
      tabId: tabInfo.parentPane.tab_id!,
      splitDirection: splitTarget.splitDirection,
    };
  }

  return selectZellijStackPlacement(panes, parentPaneId);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
  }
  return `pane:${idMatch[1]}`;
}

function readZellijPanes(): ZellijPaneSnapshot[] {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync(["list-panes", "--json", "--geometry", "--state", "--tab"]);
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
  const args = ["new-pane", "--tab-id", String(tabId), "--name", name, "--cwd", process.cwd()];
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
  return parseZellijPaneSurface(zellijActionSync(args, anchorSurface).trim(), "new-pane --stacked");
}

function createZellijTab(name: string): string {
  const tabIdRaw = zellijActionSync(["new-tab", "--name", name, "--cwd", process.cwd()]).trim();
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`);
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

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function zellijSurfaceLockPath(): string {
  const session = (process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default").replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
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
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`);
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
    ? selectZellijPlacement(readZellijPanes(), parentPaneId, minColumns, minRows)
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

export function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const focused = (value as { focused?: unknown }).focused;
  if (!focused || typeof focused !== "object") return null;

  const record = focused as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch (error) {
    void error;
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(value: string): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const caller = (value as { caller?: unknown }).caller;
  if (!caller || typeof caller !== "object") return null;

  const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxPaneRefForSurface(value: unknown, surface: string): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as { surface_ref?: unknown; pane_ref?: unknown; caller?: unknown };
  if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) return record.pane_ref;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;

  const callerRecord = caller as { surface_ref?: unknown; pane_ref?: unknown };
  if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
    return callerRecord.pane_ref;
  }

  return null;
}

export function parseCmuxPaneRefForSurfaceFromJson(value: string, surface: string): string | null {
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
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
  }
}

function waitForCmuxFocusSettle(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
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
  options?: { sourceSurfaceRef?: string; callerSnapshot?: CmuxFocusSnapshot | null },
): void {
  if (!snapshot) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  if (
    cmuxFocusMatchesChild(currentFocus, child) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.callerSnapshot?.surfaceRef) ||
    // cmux can settle focus onto another active surface in the caller pane after creating a split/surface.
    cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
  ) {
    restoreCmuxFocusSnapshot(snapshot);
  }
}

function parseCmuxCreatedSurface(output: string, command: string): CmuxCreatedSurface {
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
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
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
  const paneId = parsed?.result?.pane?.pane_id ?? parsed?.result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr ${context} output: ${output || "(empty)"}`);
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
  const parsed = parseCmuxJson(output) as { result?: { layout?: HerdrLayout } } | null;
  const layout = parsed?.result?.layout;
  if (!layout || !layout.area || !Array.isArray(layout.panes)) return null;
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
const HERDR_SUBAGENT_PANES_KEY = Symbol.for("pi-subagents/herdr-subagent-panes");

function herdrSubagentPaneList(): string[] {
  const store = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(store[HERDR_SUBAGENT_PANES_KEY])) {
    store[HERDR_SUBAGENT_PANES_KEY] = [];
  }
  return store[HERDR_SUBAGENT_PANES_KEY] as string[];
}

function setHerdrSubagentPaneList(paneIds: string[]): void {
  (globalThis as Record<symbol, unknown>)[HERDR_SUBAGENT_PANES_KEY] = [...paneIds];
}

function herdrTrackPane(paneId: string): void {
  const panes = herdrSubagentPaneList();
  if (!panes.includes(paneId)) panes.push(paneId);
}

function herdrUntrackPane(paneId: string): void {
  setHerdrSubagentPaneList(herdrSubagentPaneList().filter((id) => id !== paneId));
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

/** Ratio deltas below this are treated as already-balanced (avoids rounding churn). */
const HERDR_RESIZE_EPSILON = 0.01;

/** One `herdr pane resize` step: move the divider on the pane's `direction` side by `amount` (a ratio delta). */
export interface HerdrResizeOp {
  paneId: string;
  direction: "left" | "right";
  amount: number;
}

/**
 * Plan resizes that lay the tab out as: parent at `parentRatio` width on the
 * left, every full-height pane to its right sharing the rest equally. Each
 * split's ratio is targeted independently, so nesting depth doesn't matter.
 * Panes left of the parent or partial-height are frozen. Pure — no CLI calls.
 */
export function planHerdrRebalance(
  layout: HerdrLayout,
  parentPaneId: string,
  parentRatio: number,
): HerdrResizeOp[] {
  const ops: HerdrResizeOp[] = [];
  const total = layout.area;
  if (!(total.width > 0) || !(total.height > 0)) return ops;

  const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
  if (!parent) return ops;
  // Balancing assumes a full-height parent in a single-row layout.
  if (parent.rect.height < total.height - 2 || parent.rect.y > total.y + 2) return ops;

  // Column cells: full-height panes starting at/after the parent's right edge.
  const parentRight = parent.rect.x + parent.rect.width;
  const cells = layout.panes
    .filter(
      (pane) =>
        pane.pane_id !== parentPaneId &&
        pane.rect.x >= parentRight - 1 &&
        pane.rect.height >= total.height - 2 &&
        pane.rect.y <= total.y + 2,
    )
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  // Panes we won't move (left of the parent, or stacked rows): keep widths.
  const cellIds = new Set(cells.map((cell) => cell.pane_id));
  if (cellIds.size === 0) return ops; // nothing to balance
  const frozenSum = layout.panes
    .filter((pane) => pane.pane_id !== parentPaneId && !cellIds.has(pane.pane_id))
    .reduce((sum, pane) => sum + pane.rect.width, 0);

  const parentTarget = parentRatio * total.width;
  const remaining = total.width - parentTarget - frozenSum;
  if (cells.length > 0 && !(remaining > 5)) return ops; // can't fit; leave the layout alone
  const cellTarget = cells.length > 0 ? remaining / cells.length : 0;

  const targetWidth = (pane: HerdrLayoutPane): number => {
    if (pane.pane_id === parentPaneId) return parentTarget;
    if (cellIds.has(pane.pane_id)) return cellTarget;
    return pane.rect.width; // frozen
  };

  const inRect = (pane: HerdrLayoutPane, rect: HerdrRect): boolean =>
    pane.rect.x >= rect.x - 1.5 &&
    pane.rect.y >= rect.y - 1.5 &&
    pane.rect.x + pane.rect.width <= rect.x + rect.width + 1.5 &&
    pane.rect.y + pane.rect.height <= rect.y + rect.height + 1.5;

  // Outermost splits first.
  const rightSplits = layout.splits.filter((split) => split.direction === "right");
  const splits = [...rightSplits].sort(
    (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
  );
  const dividerXOf = (split: HerdrLayoutSplit): number =>
    split.rect.x + split.rect.width * split.ratio;
  const overlapsY = (anchor: HerdrLayoutPane, rect: HerdrRect): boolean =>
    anchor.rect.y < rect.y + rect.height + 1.5 && anchor.rect.y + anchor.rect.height > rect.y - 1.5;

  // Coincident dividers make a resize ambiguous (see guard below) — bail.
  let ambiguous = false;

  for (const split of splits) {
    const dividerX = dividerXOf(split);
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
    const leftLeaves = layout.panes.filter((pane) => inRect(pane, leftRect));
    const rightLeaves = layout.panes.filter((pane) => inRect(pane, rightRect));
    if (leftLeaves.length === 0 || rightLeaves.length === 0) continue;

    const leftTarget = leftLeaves.reduce((sum, pane) => sum + targetWidth(pane), 0);
    const rightTarget = rightLeaves.reduce((sum, pane) => sum + targetWidth(pane), 0);
    if (!(leftTarget + rightTarget > 0)) continue;

    const delta = leftTarget / (leftTarget + rightTarget) - split.ratio;
    if (Math.abs(delta) < HERDR_RESIZE_EPSILON) continue;

    let anchor: HerdrLayoutPane;
    let grow: boolean;
    if (delta > 0) {
      // Grow: move the divider right, anchored on the pane beside it.
      anchor = [...leftLeaves].sort((a, b) => b.rect.x - a.rect.x)[0];
      grow = true;
    } else {
      // Shrink: same divider, from the right side.
      anchor = [...rightLeaves].sort((a, b) => a.rect.x - b.rect.x)[0];
      grow = false;
    }

    // Skip if another split's divider coincides with this one — herdr could
    // move either one. Only happens in legacy layouts this code never creates.
    const anchorEdge = grow ? anchor.rect.x + anchor.rect.width : anchor.rect.x;
    if (Math.abs(anchorEdge - dividerX) > 1.5) continue;
    for (const other of rightSplits) {
      if (other === split) continue;
      if (!overlapsY(anchor, other.rect)) continue;
      if (Math.abs(dividerXOf(other) - dividerX) <= 1.5) {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) break;

    ops.push({
      paneId: anchor.pane_id,
      direction: grow ? "right" : "left",
      amount: grow ? delta : -delta,
    });
  }
  if (ambiguous) return [];
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
 * Create a herdr subagent surface: the parent keeps its width, new subagents
 * split the rightmost subagent pane so all subagent panes stay equal width.
 */
function createHerdrSubagentSurface(name: string): string {
  const parentPaneId = process.env.HERDR_PANE_ID;

  // Anchor on the rightmost pane right of the parent (self-heals after /reload).
  let anchorPaneId = parentPaneId ?? undefined;
  if (parentPaneId) {
    const layout = readHerdrLayout(parentPaneId);
    if (layout) {
      const known = new Set(layout.panes.map((pane) => pane.pane_id));
      setHerdrSubagentPaneList(herdrSubagentPaneList().filter((id) => known.has(id)));
      const parent = layout.panes.find((pane) => pane.pane_id === parentPaneId);
      if (parent) {
        const anchor = layout.panes
          .filter(
            (pane) =>
              pane.pane_id !== parentPaneId && pane.rect.x >= parent.rect.x + parent.rect.width - 1,
          )
          .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
          .pop();
        if (anchor) anchorPaneId = anchor.pane_id;
      }
    }
  }

  const paneId = createSurfaceSplit(name, "right", anchorPaneId);
  herdrTrackPane(paneId);
  if (parentPaneId) {
    rebalanceHerdrSubagentLayout(parentPaneId);
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
}

const TMUX_GEOMETRY_FORMAT =
  "#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{window_width}";

export function parseTmuxPaneGeometry(output: string): TmuxPaneGeometry[] {
  const panes: TmuxPaneGeometry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 6) continue;
    const [paneId, left, top, width, height, windowWidth] = parts;
    if (!paneId.startsWith("%")) continue;
    const nums = [left, top, width, height, windowWidth].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    panes.push({
      paneId,
      left: nums[0],
      top: nums[1],
      width: nums[2],
      height: nums[3],
      windowWidth: nums[4],
    });
  }
  return panes;
}

function readTmuxPaneGeometry(targetPaneId?: string): TmuxPaneGeometry[] {
  const args = ["list-panes", "-F", TMUX_GEOMETRY_FORMAT];
  if (targetPaneId) args.push("-t", targetPaneId);
  try {
    return parseTmuxPaneGeometry(execFileSync("tmux", args, { encoding: "utf8" }));
  } catch {
    return [];
  }
}

/** Tracked tmux subagent panes; globalThis + Symbol.for so it survives /reload. */
const TMUX_SUBAGENT_PANES_KEY = Symbol.for("pi-subagents/tmux-subagent-panes");

function tmuxSubagentPaneList(): string[] {
  const store = globalThis as Record<symbol, unknown>;
  if (!Array.isArray(store[TMUX_SUBAGENT_PANES_KEY])) {
    store[TMUX_SUBAGENT_PANES_KEY] = [];
  }
  return store[TMUX_SUBAGENT_PANES_KEY] as string[];
}

function setTmuxSubagentPaneList(paneIds: string[]): void {
  (globalThis as Record<symbol, unknown>)[TMUX_SUBAGENT_PANES_KEY] = [...paneIds];
}

function tmuxTrackPane(paneId: string): void {
  const panes = tmuxSubagentPaneList();
  if (!panes.includes(paneId)) panes.push(paneId);
}

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

/**
 * Plan absolute-width resizes: parent at `parentRatio` of the window, every
 * full-height pane to its right sharing the rest equally. Pure — no CLI calls.
 */
export function planTmuxRebalance(
  panes: TmuxPaneGeometry[],
  parentPaneId: string,
  parentRatio: number,
): TmuxResizeOp[] {
  const parent = panes.find((pane) => pane.paneId === parentPaneId);
  if (!parent) return [];
  const windowWidth = parent.windowWidth;
  if (!(windowWidth > 0) || !(parent.width > 0)) return [];

  const parentRight = parent.left + parent.width;
  const cells = panes
    .filter(
      (pane) =>
        pane.paneId !== parentPaneId &&
        pane.left >= parentRight - 1 &&
        pane.height >= parent.height - 1 &&
        pane.top <= parent.top + 1,
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);
  if (cells.length === 0) return [];

  const parentTarget = Math.round(parentRatio * windowWidth);
  const remaining = windowWidth - parentTarget;
  // Every cell needs at least two columns to be worth resizing.
  if (remaining < cells.length * 2) return [];

  const cellTarget = Math.floor(remaining / cells.length);
  const ops: TmuxResizeOp[] = [];
  if (Math.abs(parent.width - parentTarget) > 1) {
    ops.push({ paneId: parentPaneId, width: parentTarget });
  }
  for (const cell of cells) {
    if (Math.abs(cell.width - cellTarget) > 1) {
      ops.push({ paneId: cell.paneId, width: cellTarget });
    }
  }
  return ops;
}

function applyTmuxResizeOps(ops: TmuxResizeOp[]): void {
  for (const op of ops) {
    try {
      execFileSync("tmux", ["resize-pane", "-t", op.paneId, "-x", String(op.width)], {
        encoding: "utf8",
      });
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

/**
 * Create a tmux subagent surface: the parent keeps its width, new subagents
 * split the rightmost subagent pane so all subagent panes stay equal width.
 */
function createTmuxSubagentSurface(name: string): string {
  const parentPaneId = process.env.TMUX_PANE;

  // Anchor on the rightmost pane right of the parent (self-heals after /reload).
  let anchorPaneId = parentPaneId ?? undefined;
  if (parentPaneId) {
    const panes = readTmuxPaneGeometry(parentPaneId);
    if (panes.length > 0) {
      const known = new Set(panes.map((pane) => pane.paneId));
      setTmuxSubagentPaneList(tmuxSubagentPaneList().filter((id) => known.has(id)));
      const parent = panes.find((pane) => pane.paneId === parentPaneId);
      if (parent) {
        const anchor = panes
          .filter(
            (pane) => pane.paneId !== parentPaneId && pane.left >= parent.left + parent.width - 1,
          )
          .sort((a, b) => a.top - b.top || a.left - b.left)
          .pop();
        if (anchor) anchorPaneId = anchor.paneId;
      }
    }
  }

  const paneId = createSurfaceSplit(name, "right", anchorPaneId);
  tmuxTrackPane(paneId);
  if (parentPaneId) {
    rebalanceTmuxSubagentLayout(parentPaneId);
  }
  return paneId;
}

/** Whether herdr currently detects a working agent turn in the given pane. */
function isHerdrAgentWorking(surface: string): Promise<boolean> {
  return execFileAsync("herdr", ["agent", "get", surface], { encoding: "utf8" })
    .then(({ stdout }) => JSON.parse(stdout)?.result?.agent?.agent_status === "working")
    .catch(() => false);
}

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For zellij: chooses a tab-aware tiled or stacked placement.
 * For herdr: splits the rightmost subagent pane (no focus steal), keeping the
 * parent pane at a fixed width, then rebalances so all subagent panes are
 * equally wide (`PI_SUBAGENT_HERDR_PARENT_RATIO`, default 0.4).
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
    const created = createCmuxSplitSurface(name, "right", process.env.CMUX_SURFACE_ID);
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
    const herdrDirection = direction === "left" || direction === "right" ? "right" : "down";
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
    execFileSync("herdr", ["pane", "rename", paneId, name], { encoding: "utf8" });
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
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

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
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
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
    execFileSync("herdr", ["pane", "rename", paneId, title], { encoding: "utf8" });
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
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
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
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
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
    execFileSync("herdr", ["workspace", "rename", workspaceId, title], { encoding: "utf8" });
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
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-text", surface, command], { encoding: "utf8" });
    execFileSync("herdr", ["pane", "send-keys", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
      { encoding: "utf8" },
    );
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execFileSync("cmux", ["send", "--surface", surface, "\u001b"], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-keys", surface, "esc"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
      encoding: "utf8",
    });
    return;
  }

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

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
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
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
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
    return execFileSync("herdr", ["pane", "read", surface, "--lines", String(Math.max(1, lines))], {
      encoding: "utf8",
    });
  }

  if (backend === "wezterm") {
    const raw = execFileSync("wezterm", ["cli", "get-text", "--pane-id", surface], {
      encoding: "utf8",
    });
    return tailLines(raw, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  // The ZELLIJ_PANE_ID env var doesn't reliably target other panes for dump-screen,
  // and --path may silently fail to create the file. Stdout capture is robust.
  const paneId = zellijPaneId(surface);
  const raw = execFileSync("zellij", ["action", "dump-screen", "--pane-id", paneId], {
    encoding: "utf8",
  });
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
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
    const { stdout } = await execFileAsync("wezterm", ["cli", "get-text", "--pane-id", surface], {
      encoding: "utf8",
    });
    return tailLines(stdout, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  const paneId = zellijPaneId(surface);
  const { stdout } = await execFileAsync("zellij", ["action", "dump-screen", "--pane-id", paneId], {
    encoding: "utf8",
  });
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
    // Rebalance the remaining subagent panes so they share the freed width.
    if (tmuxSubagentPaneList().includes(surface)) {
      tmuxUntrackPane(surface);
      const parentPaneId = process.env.TMUX_PANE;
      if (parentPaneId) {
        rebalanceTmuxSubagentLayout(parentPaneId);
      }
    }
    return;
  }

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    // Rebalance the remaining subagent panes so they share the freed width.
    if (herdrSubagentPaneList().includes(surface)) {
      herdrUntrackPane(surface);
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (parentPaneId) {
        rebalanceHerdrSubagentLayout(parentPaneId);
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

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
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
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
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
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
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

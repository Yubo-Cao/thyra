import {
  constants,
  watch,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  type FSWatcher,
} from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ShellInputState,
  ShellName,
  ShellSubmitParams,
  ShellSubmitResult,
} from "../../../shared/shell";
import { paneFilename } from "./paths";

export interface ShellRecord {
  v: 1;
  pane: string;
  pid: number;
  shell: ShellName;
  shell_version: string;
  seq: number;
  state: "prompt" | "running";
  cwd: string;
  exit: number;
  histfile: string;
  bracketed_paste: boolean;
  ts: number;
  path?: string;
  /** Set when a line editor replaces readline (ble.sh runs multi-line buffers on C-j). */
  line_editor?: "ble";
}
export interface ProcessInfo {
  shell_pid: number;
  foreground_process_group_id: number;
}
export type ShellCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
export function parseShellRecord(value: unknown): ShellRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as ShellRecord;
  if (
    v.v !== 1 ||
    typeof v.pane !== "string" ||
    !v.pane ||
    v.pane.length > 256 ||
    !Number.isSafeInteger(v.pid) ||
    v.pid <= 0 ||
    !Number.isSafeInteger(v.seq) ||
    v.seq < 1 ||
    !["bash", "zsh", "fish"].includes(v.shell) ||
    !["prompt", "running"].includes(v.state) ||
    typeof v.shell_version !== "string" ||
    typeof v.cwd !== "string" ||
    !v.cwd.startsWith("/") ||
    typeof v.histfile !== "string" ||
    typeof v.bracketed_paste !== "boolean" ||
    !Number.isInteger(v.exit) ||
    !Number.isFinite(v.ts) ||
    v.ts <= 0 ||
    (v.path !== undefined && typeof v.path !== "string") ||
    (v.line_editor !== undefined && v.line_editor !== "ble")
  )
    return null;
  return v;
}
export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readAtInput(path: string): ShellRecord | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== (process.getuid?.() ?? 0) ||
      stat.mode & 0o077 ||
      stat.size > 1024 * 1024
    )
      return null;
    return parseShellRecord(JSON.parse(readFileSync(fd, "utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readShellRecord(
  path: string,
  uid = process.getuid?.() ?? 0,
) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 1024 * 1024
    )
      return null;
    return parseShellRecord(JSON.parse(await file.readFile("utf8")));
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

export function encodeSubmit(
  text: string,
  execute: boolean,
  bracketed: boolean,
  lineEditor?: ShellRecord["line_editor"],
): { text: string; keys: string[] } | ShellSubmitResult {
  if (text.length > 256 * 1024 || text.includes("\0"))
    return { ok: false, reason: "invalid_text" };
  if (!bracketed && /[\r\n]/.test(text))
    return { ok: false, reason: "multiline" };
  // Unbracketed control bytes could invoke arbitrary line-editor bindings.
  if (!bracketed && /[\x01-\x1f\x7f]/.test(text))
    return { ok: false, reason: "invalid_text" };
  if (bracketed && text.includes("\x1b[201~")) {
    // A removal can join two fragments into another end marker. A stack
    // removes those too without repeatedly rescanning adversarial input.
    const marker = "\x1b[201~";
    const output: string[] = [];
    for (const char of text) {
      output.push(char);
      if (
        output.length >= marker.length &&
        [...marker].every(
          (part, i) => output[output.length - marker.length + i] === part,
        )
      )
        output.length -= marker.length;
    }
    text = output.join("");
  }
  // Herdr's pane.send_input wraps text in a bracketed paste itself whenever
  // the PTY has mode 2004 on, and encodes Enter for the live key mode.
  // ble.sh leaves a multi-line buffer in MULTILINE mode, where Enter inserts
  // a newline and C-j runs it.
  const run = lineEditor === "ble" && text.includes("\n") ? "ctrl+j" : "Enter";
  return { text, keys: execute ? [run] : [] };
}

/** Unchanged panes are still re-verified this often. */
const FULL_SCAN_INTERVAL_MS = 30_000;

export class ShellStateTracker {
  private records = new Map<string, ShellRecord>();
  private states = new Map<string, ShellInputState>();
  private blocked = new Map<
    string,
    { pid: number; seq: number; reason: "dirty" | "submitted" }
  >();
  private revisions = new Map<string, number>();
  /** Never reused, so a pruned pane cannot repeat a revision a refresh holds. */
  private revision = 0;
  private alternate = new Set<string>();
  /** State files seen by the last scan, by name. */
  private files = new Map<string, { stamp: string; pane?: string }>();
  /** Panes the next scan refreshes even though their file did not change. */
  private unsettled = new Set<string>();
  private lastFullScan = 0;
  private submitting = new Set<string>();
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private stopped = false;
  constructor(
    private args: {
      dir: string;
      call: ShellCall;
      changed?: (state: ShellInputState) => void;
      alive?: (pid: number) => boolean;
    },
  ) {}
  record(pane: string) {
    return this.records.get(pane);
  }
  snapshot() {
    return [...this.states.values()];
  }
  current(pane: string) {
    return this.states.get(pane);
  }
  private publish(state: ShellInputState) {
    if (this.stopped) return;
    if (
      JSON.stringify(this.states.get(state.pane_id)) !== JSON.stringify(state)
    ) {
      this.states.set(state.pane_id, state);
      this.args.changed?.(state);
    }
  }
  /** Drops everything held for a closed pane. */
  forget(pane: string) {
    this.records.delete(pane);
    this.states.delete(pane);
    this.blocked.delete(pane);
    this.revisions.delete(pane);
    this.alternate.delete(pane);
    this.unsettled.delete(pane);
  }
  dirty(pane: string, reason: "dirty" | "submitted" = "dirty") {
    this.revisions.set(pane, ++this.revision);
    // A prompt may have advanced since the watcher last ran. Bind input to
    // the file at the actual dispatch boundary, never that stale snapshot.
    const disk = readAtInput(join(this.args.dir, paneFilename(pane)));
    const record = disk?.pane === pane ? disk : undefined;
    if (this.blocked.get(pane)?.reason === "submitted") reason = "submitted";
    this.blocked.set(pane, {
      pid: record?.pid ?? 0,
      seq: record?.seq ?? 0,
      reason,
    });
    const state = this.states.get(pane);
    if (state) this.publish({ ...state, available: false, reason });
  }
  setAlternate(pane: string, active: boolean) {
    if (!active) {
      // The next scan republishes the state the alternate screen was hiding.
      if (this.alternate.delete(pane)) this.unsettled.add(pane);
      return;
    }
    this.alternate.add(pane);
    const state = this.states.get(pane);
    if (state)
      this.publish({
        ...state,
        available: false,
        reason: "alternate_screen",
      });
  }
  async refresh(pane: string): Promise<ShellInputState> {
    const missing: ShellInputState = {
      pane_id: pane,
      available: false,
      reason: "no_integration",
      seq: 0,
      bracketed_paste: false,
    };
    const revision = this.revisions.get(pane) ?? 0;
    this.unsettled.delete(pane);
    const record = await readShellRecord(
      join(this.args.dir, paneFilename(pane)),
    );
    let info: ProcessInfo | null = null;
    if (
      record &&
      record.pane === pane &&
      (this.args.alive ?? isProcessAlive)(record.pid)
    ) {
      try {
        info =
          (
            (await this.args.call("pane.process_info", {
              pane_id: pane,
            })) as { process_info?: ProcessInfo }
          ).process_info ?? null;
      } catch {
        /* Unavailable fails closed; the next scan asks again. */
        this.unsettled.add(pane);
      }
    }
    if (!record || !info || info.shell_pid !== record.pid) {
      this.records.delete(pane);
      this.publish(missing);
      return missing;
    }
    const latest = await readShellRecord(
      join(this.args.dir, paneFilename(pane)),
    );
    if (
      !latest ||
      latest.pid !== record.pid ||
      latest.seq !== record.seq ||
      latest.state !== record.state
    ) {
      this.publish(missing);
      return missing;
    }
    const previous = this.records.get(pane);
    if (previous?.pid === record.pid && record.seq < previous.seq) {
      this.publish(missing);
      return missing;
    }
    this.records.set(pane, record);
    const blocked = this.blocked.get(pane);
    if (
      blocked &&
      blocked.pid !== 0 &&
      (blocked.pid !== record.pid || blocked.seq < record.seq) &&
      revision === (this.revisions.get(pane) ?? 0)
    )
      this.blocked.delete(pane);
    if (blocked?.pid === 0)
      this.blocked.set(pane, { ...blocked, pid: record.pid, seq: record.seq });
    // Raw input arriving during process_info must also invalidate this read.
    if (revision !== (this.revisions.get(pane) ?? 0))
      this.blocked.set(pane, {
        pid: record.pid,
        seq: record.seq,
        reason: "dirty",
      });
    const reason =
      this.blocked.get(pane)?.reason ??
      (this.alternate.has(pane)
        ? "alternate_screen"
        : record.state !== "prompt" ||
            info.foreground_process_group_id !== record.pid
          ? "busy"
          : undefined);
    const state: ShellInputState = {
      pane_id: pane,
      available: !reason,
      ...(reason ? { reason } : {}),
      seq: record.seq,
      shell: record.shell,
      cwd: record.cwd,
      exit: record.exit,
      bracketed_paste: record.bracketed_paste,
    };
    this.publish(state);
    return state;
  }
  async submit(
    params: ShellSubmitParams,
    current = () => true,
  ): Promise<ShellSubmitResult> {
    if (this.submitting.has(params.pane_id))
      return { ok: false, reason: "busy" };
    this.submitting.add(params.pane_id);
    try {
      const state = await this.refresh(params.pane_id);
      if (!state.available)
        return { ok: false, reason: state.reason ?? "busy" };
      if (state.seq !== params.seq) return { ok: false, reason: "stale_seq" };
      const input = encodeSubmit(
        params.text,
        params.execute,
        state.bracketed_paste,
        this.records.get(params.pane_id)?.line_editor,
      );
      if ("ok" in input) return input;
      if (!current()) return { ok: false, reason: "connection_changed" };
      // No await between availability/reservation and dispatch. A failed write
      // stays blocked: its dispatch state may be unknown, so never retry it.
      this.dirty(params.pane_id, "submitted");
      await this.args.call("pane.send_input", {
        pane_id: params.pane_id,
        ...input,
      });
      return { ok: true };
    } finally {
      this.submitting.delete(params.pane_id);
    }
  }
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const files = await readdir(this.args.dir).catch(() => [] as string[]);
      const full = Date.now() - this.lastFullScan >= FULL_SCAN_INTERVAL_MS;
      if (full) this.lastFullScan = Date.now();
      // Only panes whose state file changed are re-read: an idle scan costs
      // one stat per file instead of a read and a Herdr call per pane.
      const panes = new Set(this.unsettled);
      const present = new Set<string>();
      const seen = new Set<string>();
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        seen.add(name);
        const path = join(this.args.dir, name);
        const stamp = await lstat(path).then(
          (stat) => `${stat.mtimeMs}:${stat.size}:${stat.ino}`,
          () => "",
        );
        let known = this.files.get(name);
        if (!known || known.stamp !== stamp) {
          const record = await readShellRecord(path);
          const pane =
            record && paneFilename(record.pane) === name
              ? record.pane
              : undefined;
          if (known?.pane && known.pane !== pane) panes.add(known.pane);
          if (pane) panes.add(pane);
          known = { stamp, pane };
          this.files.set(name, known);
        }
        if (known.pane) present.add(known.pane);
      }
      for (const [name, known] of this.files) {
        if (seen.has(name)) continue;
        this.files.delete(name);
        if (known.pane) panes.add(known.pane);
      }
      const alive = this.args.alive ?? isProcessAlive;
      for (const [pane, record] of this.records)
        if (!alive(record.pid)) panes.add(pane);
      if (full)
        for (const pane of [...this.states.keys(), ...present]) panes.add(pane);
      for (const pane of panes) {
        if (this.stopped) break;
        await this.refresh(pane);
      }
      // A pane without a state file has nothing to track; a later request or
      // a new file brings it back.
      for (const [pane, state] of this.states)
        if (
          !present.has(pane) &&
          !this.records.has(pane) &&
          state.reason === "no_integration"
        )
          this.states.delete(pane);
    })().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }
  async start() {
    await mkdir(this.args.dir, { recursive: true, mode: 0o700 });
    if (this.stopped) return;
    const schedule = () => {
      if (!this.debounce)
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          void this.scan();
        }, 50);
    };
    try {
      this.watcher = watch(this.args.dir, schedule);
      this.watcher.on("error", () => {
        this.watcher?.close();
      });
    } catch {
      /* periodic fallback */
    }
    this.timer = setInterval(schedule, 1000);
    this.timer.unref();
    await this.scan();
  }
  async stop() {
    this.stopped = true;
    this.watcher?.close();
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    await this.scanning;
  }
}

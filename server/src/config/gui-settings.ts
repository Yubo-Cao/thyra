import { defaultDataFile } from "./data-paths";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import { serverLogger } from "../utils/logger";
import { sourceCheckoutPath as workspaceSourceCheckoutPath } from "../workspace/utils";
import {
  type LauncherSettings,
  normalizeLauncherSettingsMap,
} from "../launcher/folders";

export type GuiSettings = {
  version: 1;
  terminal_transport?: Record<string, { surface_codecs: boolean }>;
  /** Project launcher pins, commands, and history per connection ID. */
  launcher?: Record<string, LauncherSettings>;
  custom: Record<string, unknown>;
};

let cachedGuiSettings: GuiSettings | null = null;
let settingsMutationQueue: Promise<void> = Promise.resolve();
let temporaryFileSequence = 0;

export function guiSettingsPath(): string {
  return defaultDataFile("settings.json");
}

function defaultGuiSettings(): GuiSettings {
  return {
    version: 1,
    terminal_transport: {},
    launcher: {},
    custom: {},
  };
}

function normalizeGuiSettings(raw: unknown): GuiSettings {
  const obj = raw && typeof raw === "object" ? (raw as any) : {};
  return {
    version: 1,
    terminal_transport: Object.fromEntries(
      Object.entries(obj.terminal_transport ?? {}).flatMap(([key, value]) =>
        value &&
        typeof value === "object" &&
        typeof (value as { surface_codecs?: unknown }).surface_codecs ===
          "boolean"
          ? [
              [
                key,
                {
                  surface_codecs: (value as { surface_codecs: boolean })
                    .surface_codecs,
                },
              ],
            ]
          : [],
      ),
    ),
    launcher: normalizeLauncherSettingsMap(obj.launcher),
    custom:
      obj.custom && typeof obj.custom === "object"
        ? (obj.custom as Record<string, unknown>)
        : {},
  };
}

export async function readGuiSettings(): Promise<GuiSettings> {
  if (cachedGuiSettings) return cachedGuiSettings;
  const path = guiSettingsPath();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    cachedGuiSettings = defaultGuiSettings();
    return cachedGuiSettings;
  }
  try {
    cachedGuiSettings = normalizeGuiSettings(JSON.parse(await file.text()));
  } catch (e) {
    serverLogger.child("settings").warn("ignoring invalid settings", {
      path,
      error: e,
    });
    cachedGuiSettings = defaultGuiSettings();
  }
  return cachedGuiSettings;
}

async function persistGuiSettings(
  settings: GuiSettings,
  shouldCommit: () => boolean,
): Promise<GuiSettings> {
  const path = guiSettingsPath();
  const temporaryPath = `${path}.${process.pid}.${++temporaryFileSequence}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const normalized = normalizeGuiSettings(settings);
  try {
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    if (!shouldCommit()) throw new Error("settings update cancelled");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  cachedGuiSettings = normalized;
  return normalized;
}

function enqueueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(operation);
  settingsMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Read and persist under one queue slot so background status updates cannot
// overwrite a toggle changed by an RPC that completed at the same time.
export function updateGuiSettings(
  update: (current: GuiSettings) => GuiSettings | Promise<GuiSettings>,
  shouldCommit: () => boolean = () => true,
): Promise<GuiSettings> {
  return enqueueSettingsMutation(async () => {
    const current = await readGuiSettings();
    if (!shouldCommit()) throw new Error("settings update cancelled");
    const next = await update(current);
    if (!shouldCommit()) throw new Error("settings update cancelled");
    return persistGuiSettings(next, shouldCommit);
  });
}

export function terminalSurfaceCodecsEnabled(
  settings: GuiSettings,
  connectionId = LEGACY_DEFAULT_CONNECTION_ID,
): boolean {
  return settings.terminal_transport?.[connectionId]?.surface_codecs !== false;
}

export function connectionSettingsPrefix(connectionId?: string | null): string {
  return connectionId && connectionId !== LEGACY_DEFAULT_CONNECTION_ID
    ? `connection:${encodeURIComponent(connectionId)}:`
    : "";
}

export function repoSettingsKey(
  rawRepoKey: string,
  host?: string | null,
  connectionId?: string | null,
): string {
  return `${connectionSettingsPrefix(connectionId)}${host ? `ssh:${host}` : "local"}:${rawRepoKey}`;
}

export function workspaceRepoSettingsKey(
  workspace: any,
  host?: string | null,
  connectionId?: string | null,
): string | null {
  const raw =
    (typeof workspace?.worktree?.repo_key === "string" &&
      workspace.worktree.repo_key) ||
    (typeof workspace?.worktree?.repo_root === "string" &&
      workspace.worktree.repo_root) ||
    workspaceSourceCheckoutPath(workspace);
  return raw ? repoSettingsKey(raw, host, connectionId) : null;
}

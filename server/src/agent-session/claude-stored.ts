import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_SESSION_HISTORY_LIMIT,
  AGENT_SESSION_ITEM_LIMIT,
  type AgentStoredSession,
} from "../../../shared/agentSession";
import { oneLine, record, text } from "./adapter";
import { isAgentSessionId } from "./link";

/**
 * The conversations Claude Code stores on disk: one JSONL file per
 * conversation under `<config>/projects/<directory name>/<session ID>.jsonl`,
 * written by the terminal UI and by `claude -p` alike. This module finds a
 * directory's conversations and reads one back as the entries its transcript
 * is made of; `claude.ts` turns those entries into items.
 */

export type StoredEntry = Record<string, unknown>;

const PROJECT_NAME_LIMIT = 200;
const TITLE_LIMIT = 200;
/** A conversation's first prompt is looked for this far into its file. */
const HEAD_BYTES = 64 * 1024;
/** Title entries are written again after every turn, so the end has one. */
const TAIL_BYTES = 128 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
/**
 * Entries are chosen by how many items they can make at most; some make
 * fewer (a todo list replaces its item), so more are read than can be kept.
 */
const ITEM_SLACK = 1.5;

/** The name Claude Code gives a directory under `projects/`. */
export function claudeProjectName(directory: string): string {
  const name = directory.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= PROJECT_NAME_LIMIT) return name;
  let hash = 0;
  for (let index = 0; index < directory.length; index++)
    hash = ((hash << 5) - hash + directory.charCodeAt(index)) | 0;
  return `${name.slice(0, PROJECT_NAME_LIMIT)}-${Math.abs(hash).toString(36)}`;
}

/**
 * Where the conversations of a working directory are stored. The CLI names
 * the directory after the real path, so a symlinked one is resolved first.
 */
export function claudeProjectDir(
  cwd: string,
  env: Record<string, string | undefined>,
): string {
  let directory = cwd;
  try {
    directory = realpathSync(cwd);
  } catch {
    // A directory that is gone has no conversations either.
  }
  const root = join(
    env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
    "projects",
  );
  const name = claudeProjectName(directory);
  if (name.length <= PROJECT_NAME_LIMIT) return join(root, name);
  // Past the limit the name ends in a hash; another build may hash otherwise.
  try {
    const prefix = name.slice(0, PROJECT_NAME_LIMIT + 1);
    const names = readdirSync(root);
    const found = names.includes(name)
      ? name
      : names.find((entry) => entry.startsWith(prefix));
    if (found) return join(root, found);
  } catch {
    // No conversations are stored at all.
  }
  return join(root, name);
}

/** Blocks the terminal UI or an IDE attaches around what the user typed. */
const ATTACHED_CONTEXT =
  /^<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder)[\s>]/;
/** Entries the CLI writes in the user's name: command output, notifications. */
const NOT_TYPED =
  /^<(command-(name|message|args)|local-command-[a-z]+|bash-(input|stdout|stderr)|task-notification|system-reminder|user-prompt-submit-hook)[\s>]/;

/**
 * A prompt the CLI took while a turn was running. It is stored as an
 * attachment of the turn, not as a `user` entry of its own; null for any
 * other entry (task notifications are queued the same way).
 */
function queuedPrompt(entry: StoredEntry): Record<string, unknown> | null {
  const attachment = entry.type === "attachment" && record(entry.attachment);
  return attachment &&
    attachment.type === "queued_command" &&
    attachment.commandMode === "prompt"
    ? attachment
    : null;
}

/** The text of an entry the user is behind; null for any other entry. */
function userText(entry: StoredEntry): string | null {
  const queued = queuedPrompt(entry);
  // What a `user` entry says of itself, a queued prompt's attachment says.
  const said = queued ?? entry;
  if (
    (entry.type !== "user" && !queued) ||
    said.isMeta === true ||
    entry.isSidechain === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true
  )
    return null;
  // Newer files say where a prompt came from; a notification is not typed.
  const origin = record(said.origin)?.kind;
  if (origin !== undefined && origin !== "human") return null;
  const content = queued ? queued.prompt : record(entry.message)?.content;
  let parts: string[];
  if (typeof content === "string") parts = [content];
  else if (Array.isArray(content)) {
    if (content.some((value) => record(value)?.type === "tool_result"))
      return null;
    // An image the text already names (`[Image #1]`) is not named twice.
    const named = content.some((value) =>
      /\[Image #\d+\]/.test(text(record(value)?.text) ?? ""),
    );
    parts = content.flatMap((value) => {
      const block = record(value);
      if (block?.type === "text") return [text(block.text) ?? ""];
      return block?.type === "image" && !named ? ["[image]"] : [];
    });
  } else return null;
  const body = parts
    .filter((part) => !ATTACHED_CONTEXT.test(part.trimStart()))
    .join("\n")
    .trim();
  return body || null;
}

/** A prompt the user typed, as stored; null for every other entry. */
export function storedPrompt(entry: StoredEntry): string | null {
  const body = userText(entry);
  return body === null ||
    NOT_TYPED.test(body) ||
    body.startsWith("[Request interrupted")
    ? null
    : body;
}

/** A slash command the user ran, as `/name arguments`; null otherwise. */
export function storedCommand(entry: StoredEntry): string | null {
  const body = userText(entry);
  const name =
    body && /<command-name>([\s\S]*?)<\/command-name>/.exec(body)?.[1]?.trim();
  if (!body || !name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(body)?.[1];
  return `${name} ${args?.trim() ?? ""}`.trim();
}

function parseEntry(line: string): StoredEntry | null {
  try {
    return record(JSON.parse(line));
  } catch {
    // A line cut by the read window, or one still being written.
    return null;
  }
}

/** Part of a file as text; a character cut at either edge only harms the line it is in. */
function readSlice(path: string, position: number, length: number): string {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(file, buffer, 0, length, position);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(file);
  }
}

/**
 * What to call a conversation: the title it was given (by the user, else by
 * the CLI), else its first prompt, else its latest one. Null for a file
 * that holds no conversation of the user's (never prompted, or a sub-agent).
 */
function conversationTitle(path: string, size: number): string | null {
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail = readSlice(path, tailStart, size - tailStart).split("\n");
  if (tailStart > 0) tail.shift();
  let custom: string | undefined;
  let generated: string | undefined;
  let latest: string | undefined;
  for (const line of tail) {
    // Cheap test first: tool results in the tail can be megabytes long.
    if (
      line.length > 8192 ||
      !/"(custom-title|ai-title|last-prompt)"/.test(line)
    )
      continue;
    const entry = parseEntry(line);
    if (entry?.type === "custom-title")
      custom = text(entry.customTitle) || custom;
    else if (entry?.type === "ai-title")
      generated = text(entry.aiTitle) || generated;
    else if (entry?.type === "last-prompt")
      latest = text(entry.lastPrompt) || latest;
  }
  const head = readSlice(path, 0, Math.min(size, HEAD_BYTES)).split("\n");
  if (size > HEAD_BYTES) head.pop();
  let first: string | undefined;
  let conversation = false;
  for (const line of head) {
    const entry = line.includes('"uuid"') ? parseEntry(line) : null;
    if (!entry || typeof entry.uuid !== "string") continue;
    // A sub-agent's file: older builds keep them beside the conversations.
    if (!conversation && entry.isSidechain === true) return null;
    conversation = true;
    // An image pasted before the text is not what the conversation is about.
    first = storedPrompt(entry)?.replace(/^(\[image\]\s*)+(?=\S)/, "");
    if (first) break;
  }
  const title =
    custom ??
    generated ??
    first ??
    (latest && !NOT_TYPED.test(latest) ? latest : undefined);
  return title?.trim() ? oneLine(title, TITLE_LIMIT) : null;
}

/**
 * The conversations stored in a project directory, newest first by their
 * last write. Reads a bounded part of each file, and only of as many files
 * as it takes to fill the list.
 */
export function listClaudeSessions(
  directory: string,
  options: { exclude?: string; limit?: number } = {},
): AgentStoredSession[] {
  const limit = options.limit ?? AGENT_SESSION_HISTORY_LIMIT;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const files = names.flatMap((name) => {
    const id = name.endsWith(".jsonl") ? name.slice(0, -6) : "";
    if (!isAgentSessionId(id) || id === options.exclude) return [];
    // `agent-<id>.jsonl` is how older builds name a sub-agent's file.
    if (id.startsWith("agent-")) return [];
    try {
      const stats = statSync(join(directory, name));
      return stats.isFile() && stats.size > 0
        ? [{ id, path: join(directory, name), stats }]
        : [];
    } catch {
      return [];
    }
  });
  files.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  const sessions: AgentStoredSession[] = [];
  for (const file of files) {
    if (sessions.length >= limit) break;
    let title: string | null = null;
    try {
      title = conversationTitle(file.path, file.stats.size);
    } catch {
      // Unreadable: not offered.
    }
    if (title)
      sessions.push({
        id: file.id,
        title,
        updated_at: Math.round(file.stats.mtimeMs),
      });
  }
  return sessions;
}

/** The lines of a file from a position on, each with its byte offset. */
async function* fileLines(
  file: FileHandle,
  from: number,
): AsyncGenerator<[offset: number, line: Buffer]> {
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  let position = from;
  /** Start of the line being read, and its parts from earlier chunks. */
  let lineStart = from;
  let carried: Buffer[] = [];
  for (;;) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    for (;;) {
      const end = view.indexOf(10, start);
      if (end === -1) break;
      const part = view.subarray(start, end);
      // The view is reused by the next read: a line is used before then.
      yield [
        lineStart,
        carried.length > 0 ? Buffer.concat([...carried, part]) : part,
      ];
      carried = [];
      start = end + 1;
      lineStart = position + start;
    }
    if (start < bytesRead) carried.push(Buffer.from(view.subarray(start)));
    position += bytesRead;
  }
  if (carried.length > 0) yield [lineStart, Buffer.concat(carried)];
}

/** What the transcript needs to know of an entry to place it, kept per entry. */
type EntryLink = {
  uuid: string;
  parent: string | null;
  /** Where a compaction boundary points back into the earlier history. */
  earlier: (string | undefined)[];
  offset: number;
  /** Position in the file, which is also the order entries were written in. */
  index: number;
  /** Items the entry can add to a transcript, at most. */
  weight: number;
  /** IDs of the tool calls it makes, and of those whose results it holds. */
  calls: string[];
  results: string[];
};

const UUID_KEY = Buffer.from('"uuid"');
const REWOUND_KEY = Buffer.from('"rewound"');
const SHOWN_SYSTEM_ENTRIES = new Set(["compact_boundary", "informational"]);

/** Whether an entry of this kind can show in a transcript at all. */
export function isTranscriptEntry(entry: StoredEntry): boolean {
  if (entry.isSidechain === true || entry.isMeta === true) return false;
  if (entry.type === "user" || entry.type === "assistant") return true;
  if (queuedPrompt(entry)) return true;
  return (
    entry.type === "system" &&
    SHOWN_SYSTEM_ENTRIES.has(text(entry.subtype) ?? "")
  );
}

function linkOf(entry: StoredEntry, offset: number, index: number): EntryLink {
  const link: EntryLink = {
    uuid: entry.uuid as string,
    parent: text(entry.parentUuid) ?? null,
    earlier: [
      text(entry.logicalParentUuid),
      text(record(record(entry.compactMetadata)?.preservedSegment)?.headUuid),
    ],
    offset,
    index,
    weight: 0,
    calls: [],
    results: [],
  };
  if (!isTranscriptEntry(entry)) return link;
  const content = record(entry.message)?.content;
  const blocks = Array.isArray(content) ? content : [];
  if (entry.type === "assistant") {
    for (const value of blocks) {
      const block = record(value);
      const id = text(block?.id);
      if (block?.type === "tool_use" && id) link.calls.push(id);
      if (
        block?.type === "tool_use" ||
        (text(block?.text) ?? text(block?.thinking))?.trim()
      )
        link.weight += 1;
    }
    if (entry.error) link.weight += 1;
  } else if (entry.type === "user") {
    for (const value of blocks) {
      const block = record(value);
      const id = text(block?.tool_use_id);
      if (block?.type === "tool_result" && id) link.results.push(id);
    }
    // A prompt, a command or an interruption notice.
    if (link.results.length === 0) link.weight = 1;
  } else link.weight = 1;
  return link;
}

/**
 * Where the entries of a conversation's transcript start in its file, in
 * the order they were written.
 *
 * Entries link to the one before them by `parentUuid`, so the conversation
 * is the chain that ends at the last entry written: a branch abandoned by a
 * rewind is not on it. A rewind with nothing written after it ends the
 * chain where its `last-prompt` entry says (`leafUuid`; none for a rewind
 * to the start). `leaf` names the end instead, as `--resume-session-at`
 * does. A compaction boundary starts a new chain and names the entry the
 * earlier history ended at, which this follows, so the history before a
 * compaction is shown too. The results of tool calls made in parallel hang
 * off the chain, and are added by the calls they answer.
 */
async function transcriptOffsets(
  file: FileHandle,
  itemLimit: number,
  leaf?: string,
): Promise<number[]> {
  const entries = new Map<string, EntryLink>();
  const resultOf = new Map<string, EntryLink>();
  let last: EntryLink | undefined;
  let index = 0;
  for await (const [offset, line] of fileLines(file, 0)) {
    if (line.indexOf(UUID_KEY) === -1) {
      // A rewind is marked by a `last-prompt` entry, which has no `uuid`.
      if (line.indexOf(REWOUND_KEY) === -1) continue;
      const marker = parseEntry(line.toString("utf8"));
      if (marker?.type === "last-prompt" && marker.rewound === true) {
        const end = text(marker.leafUuid);
        last = end ? entries.get(end) : undefined;
      }
      // Most of a large file is request records, which carry no `uuid`.
      continue;
    }
    const entry = parseEntry(line.toString("utf8"));
    if (!entry || typeof entry.uuid !== "string" || entry.isSidechain === true)
      continue;
    last = linkOf(entry, offset, index++);
    entries.set(last.uuid, last);
    for (const id of last.results) resultOf.set(id, last);
  }
  if (leaf !== undefined) {
    last = entries.get(leaf);
    if (!last) throw new Error(`message ${leaf} is not in the conversation`);
  }

  const chosen = new Set<EntryLink>();
  const seen = new Set<EntryLink>();
  for (let link = last; link && !seen.has(link); ) {
    seen.add(link);
    if (link.weight > 0 || link.calls.length > 0 || link.results.length > 0)
      chosen.add(link);
    const at: EntryLink = link;
    link =
      (at.parent ? entries.get(at.parent) : undefined) ??
      // Only backwards: a boundary can also name an entry written after it.
      at.earlier
        .map((uuid) => (uuid ? entries.get(uuid) : undefined))
        .find((entry) => entry && entry.index < at.index && !seen.has(entry));
  }
  const answered = new Set<string>();
  for (const link of chosen) for (const id of link.results) answered.add(id);
  for (const link of [...chosen])
    for (const id of link.calls) {
      const result = answered.has(id) ? undefined : resultOf.get(id);
      if (result) chosen.add(result);
    }

  const ordered = [...chosen].sort((a, b) => a.index - b.index);
  // The transcript keeps the newest items; older entries need no reading.
  let start = ordered.length;
  for (let weight = 0; start > 0 && weight < itemLimit * ITEM_SLACK; )
    weight += ordered[--start]!.weight;
  return ordered.slice(start).map((link) => link.offset);
}

/**
 * The entries a stored conversation's transcript is made of, oldest first:
 * at most the ones the newest `itemLimit` items come from. The file is
 * read in pieces twice (once for its links, once for the entries
 * themselves) and one entry is held at a time, so a file of any size costs
 * little memory.
 */
export async function* readClaudeConversation(
  path: string,
  itemLimit = AGENT_SESSION_ITEM_LIMIT,
  /** The entry the transcript ends at, in place of the last one written. */
  leaf?: string,
): AsyncGenerator<StoredEntry> {
  const file = await open(path, "r");
  try {
    const offsets = await transcriptOffsets(file, itemLimit, leaf);
    if (offsets.length === 0) return;
    const wanted = new Set(offsets);
    const end = offsets.at(-1)!;
    for await (const [offset, line] of fileLines(file, offsets[0]!)) {
      if (wanted.has(offset)) {
        const entry = parseEntry(line.toString("utf8"));
        if (entry) yield entry;
      }
      if (offset >= end) break;
    }
  } finally {
    await file.close();
  }
}

/**
 * The `parentUuid` of the entry `uuid` in a stored conversation: the entry
 * the conversation stood at just before it, null when it starts the
 * conversation, undefined when the file does not hold it.
 */
export async function claudeEntryParent(
  path: string,
  uuid: string,
): Promise<string | null | undefined> {
  const key = Buffer.from(`"uuid":"${uuid}"`);
  const file = await open(path, "r");
  try {
    for await (const [, line] of fileLines(file, 0)) {
      if (line.indexOf(key) === -1) continue;
      const entry = parseEntry(line.toString("utf8"));
      if (entry?.uuid === uuid) return text(entry.parentUuid) ?? null;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

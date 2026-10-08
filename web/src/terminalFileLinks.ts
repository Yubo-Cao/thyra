const FILE_PATH_CANDIDATE_RE =
  /(?:\/[A-Za-z0-9._~:@%+=,/-]+|\.\/[A-Za-z0-9._~:@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)*|[A-Za-z0-9._~@%+=,-]+(?:\/[A-Za-z0-9._~:@%+=,-]+)+)\/?/g;
const TRAILING_PROSE_RE = /[.,;:!?]+$/;
const TRAILING_LOCATION_RE = /:\d+(?::\d+)?$/;
// Unicode punctuation delimits prose, but ASCII path/URI punctuation does not.
const PATH_BOUNDARY_RE = /[\s"'`([{<]/;
const UNICODE_PUNCTUATION_RE = /\p{P}/u;
export const MAX_CANDIDATES_PER_LINE = 32;
const DEFAULT_POSITIVE_TTL_MS = 30_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;

export type TextRange = { start: number; end: number };

export type TerminalFileLinkCandidate = {
  path: string;
  start: number;
  end: number;
  absolute: boolean;
};

export type ResolvedTerminalFile = {
  candidate: string;
  path: string;
};

function overlapsRange(start: number, end: number, ranges: TextRange[]) {
  return ranges.some((range) => start < range.end && end > range.start);
}

function isSafePath(path: string) {
  if (path.startsWith("~/")) return false;
  const absolute = path.startsWith("/");
  const explicitlyRelative = path.startsWith("./");
  const relative = path.startsWith("/")
    ? path.slice(1)
    : explicitlyRelative
      ? path.slice(2)
      : path;
  const parts = relative.replace(/\/$/, "").split("/");
  return (
    parts.length >= (absolute || explicitlyRelative ? 1 : 2) &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}

export function findTerminalFileLinkCandidates(
  text: string,
  excludedRanges: TextRange[] = [],
): TerminalFileLinkCandidate[] {
  const candidates: TerminalFileLinkCandidate[] = [];
  FILE_PATH_CANDIDATE_RE.lastIndex = 0;
  for (const match of text.matchAll(FILE_PATH_CANDIDATE_RE)) {
    const start = match.index ?? 0;
    const previous = start > 0 ? (text[start - 1] ?? "") : "";
    if (
      previous &&
      !PATH_BOUNDARY_RE.test(previous) &&
      !(previous.charCodeAt(0) > 127 && UNICODE_PUNCTUATION_RE.test(previous))
    )
      continue;
    const path = match[0]
      .replace(TRAILING_PROSE_RE, "")
      .replace(TRAILING_LOCATION_RE, "");
    if (!isSafePath(path)) continue;
    const end = start + path.length;
    if (overlapsRange(start, end, excludedRanges)) continue;
    candidates.push({ path, start, end, absolute: path.startsWith("/") });
    if (candidates.length >= MAX_CANDIDATES_PER_LINE) break;
  }
  return candidates;
}

// Spaced paths: candidates that only become links once `file.resolve` finds
// them, since whitespace alone cannot tell a path from the prose around it.
const SPACED_WORD_RE = /[\p{L}\p{N}\p{M}._~:@%+=,/\\-]+/uy;
const SPACED_SEED_RE =
  /(?:^|(?<=[\s"'`([{<]))(?:[A-Za-z]:[\\/]|\.{0,1}\/|[\p{L}\p{N}._~@%+=,-]+[/\\])/gu;
const QUOTED_RE = /(["'`])([^"'`\n]{1,512}?)\1/g;
const BRACKETED_RE = /[([]([^()[\]\n]{1,512})[)\]]/g;
const PATH_LIKE_RE = /[/\\]|\.[\p{L}\p{N}]+$/u;
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MAX_SPACED_WORDS = 6;

function trimLocation(raw: string) {
  return raw.replace(TRAILING_PROSE_RE, "").replace(TRAILING_LOCATION_RE, "");
}

/** Absolute paths, explicit relatives and any name: never parent escapes. */
function isSafeSpacedPath(path: string) {
  if (
    !path ||
    path !== path.trim() ||
    path.startsWith("~") ||
    URL_SCHEME_RE.test(path) ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return false;
  const normalized = path.replace(/\\/g, "/").replace(/^[A-Za-z]:(?=\/)/, "");
  const parts = normalized
    .replace(/^\.?\//, "")
    .replace(/\/$/, "")
    .split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

const isAbsolutePath = (path: string) =>
  path.startsWith("/") || DRIVE_RE.test(path);

/**
 * File paths that may contain spaces or Windows separators, read from
 * context: quotes (`'file name.ts'` from `ls`), brackets (Claude Code's
 * `Edit(src/foo bar.ts)`), and a path start extended over single spaces
 * (`/data/My Project/file name.ts:12`). Every candidate is speculative: it
 * becomes a link only when the server resolves it to an existing file.
 */
export function findTerminalSpacedFileLinkCandidates(
  text: string,
  excludedRanges: TextRange[] = [],
): TerminalFileLinkCandidate[] {
  const candidates: TerminalFileLinkCandidate[] = [];
  const add = (start: number, raw: string) => {
    const path = trimLocation(raw);
    const end = start + path.length;
    if (
      candidates.length >= MAX_CANDIDATES_PER_LINE ||
      !isSafeSpacedPath(path) ||
      overlapsRange(start, end, excludedRanges) ||
      candidates.some((item) => item.start === start && item.end === end)
    )
      return;
    candidates.push({ path, start, end, absolute: isAbsolutePath(path) });
  };
  for (const match of text.matchAll(QUOTED_RE)) {
    const start = (match.index ?? 0) + 1;
    const before = text[start - 2] ?? "";
    const after = text[start + match[2]!.length + 1] ?? "";
    // Apostrophes inside words are not quotes.
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    const inner = match[2]!;
    if (PATH_LIKE_RE.test(trimLocation(inner))) add(start, inner);
  }
  for (const match of text.matchAll(BRACKETED_RE)) {
    const inner = match[1]!;
    if (/\s/.test(inner) && PATH_LIKE_RE.test(trimLocation(inner)))
      add((match.index ?? 0) + 1, inner);
  }
  for (const seed of text.matchAll(SPACED_SEED_RE)) {
    const start = seed.index ?? 0;
    // A word after a path word continues that path; it starts none itself.
    if (/[/\\]\S*\s$/.test(text.slice(Math.max(0, start - 512), start)))
      continue;
    SPACED_WORD_RE.lastIndex = start;
    const first = SPACED_WORD_RE.exec(text);
    if (!first) continue;
    let end = start + first[0].length;
    if (DRIVE_RE.test(first[0])) add(start, first[0]);
    for (let words = 0; words < MAX_SPACED_WORDS; words++) {
      // One space joins words; `ls` separates its columns with two.
      if (text[end] !== " " || /\s/.test(text[end + 1] ?? " ")) break;
      if (/[.,;!?]$/.test(text.slice(start, end))) break;
      SPACED_WORD_RE.lastIndex = end + 1;
      const word = SPACED_WORD_RE.exec(text);
      if (!word) break;
      end += 1 + word[0].length;
      const raw = text.slice(start, end);
      const path = trimLocation(raw);
      // The spaced part must look like more path: a directory or extension.
      if (PATH_LIKE_RE.test(path.slice(path.indexOf(" ")))) add(start, raw);
    }
  }
  return candidates;
}

type CacheEntry = { path: string | null; expiresAt: number };
type BatchResolver = (
  scopeId: string,
  workspaceId: string,
  candidates: string[],
) => Promise<ResolvedTerminalFile[]>;

export class TerminalFileResolutionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly resolveBatch: BatchResolver,
    private readonly options: {
      positiveTtlMs?: number;
      negativeTtlMs?: number;
      maxEntries?: number;
      now?: () => number;
      isScopeCurrent?: (scopeId: string) => boolean;
    } = {},
  ) {}

  private key(scopeId: string, workspaceId: string, candidate: string) {
    return `${scopeId}\0${workspaceId}\0${candidate}`;
  }

  private remember(key: string, path: string | null) {
    const now = this.options.now?.() ?? Date.now();
    const ttl = path
      ? (this.options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS)
      : (this.options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS);
    this.entries.delete(key);
    this.entries.set(key, { path, expiresAt: now + ttl });
    const maxEntries = this.options.maxEntries ?? 5_000;
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  async resolve(scopeId: string, workspaceId: string, rawCandidates: string[]) {
    const candidates = Array.from(new Set(rawCandidates)).slice(
      0,
      MAX_CANDIDATES_PER_LINE,
    );
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string | null>>();
    const missing: string[] = [];
    const now = this.options.now?.() ?? Date.now();

    for (const candidate of candidates) {
      const key = this.key(scopeId, workspaceId, candidate);
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > now) {
        if (cached.path) resolved.set(candidate, cached.path);
        continue;
      }
      if (cached) this.entries.delete(key);
      const running = this.inFlight.get(key);
      if (running) pending.set(candidate, running);
      else missing.push(candidate);
    }

    if (missing.length > 0) {
      const request = this.resolveBatch(scopeId, workspaceId, missing).then(
        (files) => {
          if (this.options.isScopeCurrent?.(scopeId) === false) {
            return new Map<string, string>();
          }
          const byCandidate = new Map(
            files
              .filter((file) => missing.includes(file.candidate) && file.path)
              .map((file) => [file.candidate, file.path]),
          );
          for (const candidate of missing) {
            this.remember(
              this.key(scopeId, workspaceId, candidate),
              byCandidate.get(candidate) ?? null,
            );
          }
          return byCandidate;
        },
      );
      for (const candidate of missing) {
        const key = this.key(scopeId, workspaceId, candidate);
        const item = request.then((files) => files.get(candidate) ?? null);
        this.inFlight.set(key, item);
        item.then(
          () => this.inFlight.delete(key),
          () => this.inFlight.delete(key),
        );
        pending.set(candidate, item);
      }
    }

    await Promise.all(
      Array.from(pending, async ([candidate, promise]) => {
        const path = await promise;
        if (path) resolved.set(candidate, path);
      }),
    );
    return this.options.isScopeCurrent?.(scopeId) === false
      ? new Map<string, string>()
      : resolved;
  }
}

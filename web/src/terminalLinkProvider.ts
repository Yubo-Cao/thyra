import type {
  TerminalBufferLine,
  TerminalEngine,
  TerminalLink,
} from "./terminalEngine";
import { terminalLinkModifierMatches } from "./shortcutPreferences";
import {
  findTerminalHttpLinks,
  sanitizeTerminalHttpUrl,
  terminalFileUriPath,
} from "./terminalLinks";
import {
  findTerminalFileLinkCandidates,
  findTerminalSpacedFileLinkCandidates,
  MAX_CANDIDATES_PER_LINE,
  type TerminalFileLinkCandidate,
  type TextRange,
} from "./terminalFileLinks";

const MAX_CONTEXT_CELLS = 16_384;
const MAX_INFERRED_JOINS = 8;
const PATH_EDGE = /^[A-Za-z0-9._~:@%+=,/-]$/;
type Position = { x: number; y: number };
type CellSpan = { start: Position; end: Position };

function lineTextWithCells(line: TerminalBufferLine, cols: number, y: number) {
  let text = "";
  const cells: CellSpan[] = [];
  for (let x = 0; x < Math.min(line.length, cols); x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    const span = {
      start: { x: x + 1, y },
      end: { x: Math.min(cols, x + cell.getWidth()), y },
    };
    for (let i = 0; i < chars.length; i++) cells.push(span);
    text += chars;
  }
  return { text, cells, wrapped: line.isWrapped };
}

/** Reconstruct logical text while retaining the cell-based coordinates. */
function readLinkContext(
  term: TerminalEngine,
  row: number,
  inferContinuations: boolean,
) {
  const rows = new Map<number, ReturnType<typeof lineTextWithCells>>();
  const read = (y: number) => {
    if (rows.has(y)) return rows.get(y);
    const line = term.buffer.active.getLine(y - 1);
    if (!line) return undefined;
    const value = lineTextWithCells(line, term.cols, y);
    rows.set(y, value);
    return value;
  };
  const joins = (y: number) => {
    const previous = read(y - 1);
    const next = read(y);
    if (!previous || !next) return false;
    if (next.wrapped) return true;
    // Screen repaints have no soft-wrap metadata. TUI applications also wrap
    // prose with indentation/padding. These joins are only file candidates:
    // they must resolve to an existing file before becoming a link.
    return (
      inferContinuations &&
      !/https?:\/\/\S*$/i.test(previous.text.trimEnd()) &&
      PATH_EDGE.test(previous.text.trimEnd().slice(-1)) &&
      PATH_EDGE.test(next.text.trimStart().slice(0, 1))
    );
  };
  if (term.cols < 1 || term.cols > MAX_CONTEXT_CELLS || !read(row))
    return undefined;
  let first = row;
  let last = row;
  const withinBudget = () =>
    (last - first + 1) * term.cols <= MAX_CONTEXT_CELLS;
  let inferred = 0;
  while (first > 1 && joins(first)) {
    if (!read(first)!.wrapped && inferred++ >= MAX_INFERRED_JOINS) break;
    first--;
    if (!withinBudget()) return undefined;
  }
  inferred = 0;
  while (joins(last + 1)) {
    if (!read(last + 1)!.wrapped && inferred++ >= MAX_INFERRED_JOINS) break;
    last++;
    if (!withinBudget()) return undefined;
  }
  let text = "";
  const cells: CellSpan[] = [];
  const segments: TextRange[] = [];
  let segmentStart = 0;
  for (let y = first; y <= last; y++) {
    const line = read(y)!;
    const inferredBefore = y > first && !line.wrapped;
    const inferredAfter = y < last && !read(y + 1)!.wrapped;
    if (inferredBefore) {
      segments.push({ start: segmentStart, end: text.length });
      segmentStart = text.length;
    }
    const start = inferredBefore
      ? line.text.length - line.text.trimStart().length
      : 0;
    let end = inferredAfter ? line.text.trimEnd().length : line.text.length;
    // Wide glyphs and resizes can leave null padding before a soft wrap.
    // Remove only empty cells; explicit spaces remain token boundaries.
    if (y < last && read(y + 1)!.wrapped) {
      const source = term.buffer.active.getLine(y - 1)!;
      while (
        end > start &&
        !source.getCell(line.cells[end - 1]!.start.x - 1)?.getChars()
      )
        end--;
    }
    text += line.text.slice(start, end);
    cells.push(...line.cells.slice(start, end));
  }
  segments.push({ start: segmentStart, end: text.length });
  return { text, cells, segments };
}

function overlaps(a: TextRange, b: TextRange) {
  return a.start < b.end && a.end > b.start;
}

export type TerminalTouchLink =
  | { kind: "url"; value: string }
  | { kind: "file"; value: string };

export type TerminalResolvedLink = {
  /** Untrusted OSC8 target from the displayed cell, never its visible label. */
  uri?: string | null;
  url: string | null;
  regions: { row: number; start_col: number; end_col: number }[];
};

export function registerTerminalLinkProvider(
  term: TerminalEngine,
  onPreviewPath?: (path: string, event: MouseEvent) => void,
  resolvePaths?: (paths: string[]) => Promise<Map<string, string>>,
  inferContinuations: () => boolean = () => false,
  upstream?: {
    state: () => unknown;
    /** Stable connection/pane identity; unrelated frame repaints may change state. */
    scope?: () => unknown;
    resolve: (
      row: number,
      col: number,
      touch?: boolean,
    ) => Promise<TerminalResolvedLink | null>;
  },
) {
  let disposed = false;
  let requestGeneration = 0;
  type TargetLink = TerminalLink & { target: TerminalTouchLink };
  const provideLinks = (
    bufferLineNumber: number,
    reply: (links: TargetLink[] | undefined) => void,
    touch?: { col: number; current: () => boolean },
  ) => {
    const generation = touch ? requestGeneration : ++requestGeneration;
    const requestCurrent = () =>
      touch ? touch.current() : generation === requestGeneration;
    // The hover keeps only replies for its current row, even for older requests.
    const callback = (links: TargetLink[] | undefined) => {
      if (touch || (!disposed && requestCurrent())) reply(links);
    };
    const activeBuffer = term.buffer.active;
    const columnCount = term.cols;
    const rowCount = term.rows;
    const viewport = activeBuffer.viewportY;
    const state = upstream?.state();
    const scope = upstream?.scope?.();
    const infer = inferContinuations();
    const context = readLinkContext(term, bufferLineNumber, infer);
    if (!context || state === null) {
      callback(undefined);
      return;
    }
    const snapshot = JSON.stringify(context);
    const { text, cells, segments } = context;
    const isCurrent = () =>
      !disposed &&
      requestCurrent() &&
      term.buffer.active === activeBuffer &&
      term.cols === columnCount &&
      term.rows === rowCount &&
      activeBuffer.viewportY === viewport &&
      (upstream?.scope
        ? upstream.scope() === scope && upstream.state() !== null
        : upstream?.state() === state) &&
      inferContinuations() === infer &&
      JSON.stringify(readLinkContext(term, bufferLineNumber, infer)) ===
        snapshot;
    const isFrameCurrent = () => isCurrent() && upstream?.state() === state;
    // A click needs only the link's own rows unchanged: newer lookups (a
    // hover re-evaluation) and repaints of rows beside it keep it usable.
    const rowText = (y: number) => {
      const line = activeBuffer.getLine(y - 1);
      if (!line) return null;
      const { text, wrapped } = lineTextWithCells(line, columnCount, y);
      return `${wrapped ? 1 : 0}${text}`;
    };
    const shownRows = new Map<number, string | null>();
    for (const cell of cells)
      if (!shownRows.has(cell.start.y))
        shownRows.set(cell.start.y, rowText(cell.start.y));
    const viewCurrent = () =>
      !(
        disposed ||
        term.buffer.active !== activeBuffer ||
        term.cols !== columnCount ||
        term.rows !== rowCount ||
        activeBuffer.viewportY !== viewport ||
        inferContinuations() !== infer ||
        // A frame still being written leaves the displayed rows, which the
        // caller compares, on screen; only another pane or connection ends it.
        (upstream?.scope
          ? upstream.scope() !== scope
          : upstream?.state() !== state)
      );
    const isShown = (range: CellSpan) => {
      if (!viewCurrent()) return false;
      for (let y = range.start.y; y <= range.end.y; y++)
        if (!shownRows.has(y) || rowText(y) !== shownRows.get(y)) return false;
      return true;
    };
    const hover = () => {
      // A stale link rereads the row now that it is hovered again.
      if (!isCurrent())
        queueMicrotask(() => {
          if (!disposed) term.refresh();
        });
    };
    const rangeFor = (span: TextRange) => {
      const start = cells[span.start]?.start;
      const end = cells[span.end - 1]?.end;
      return start &&
        end &&
        start.y <= bufferLineNumber &&
        end.y >= bufferLineNumber
        ? { start, end }
        : undefined;
    };
    const links: TargetLink[] = [];
    // HTTP links use only real soft wraps. Heuristic joins cannot verify a URL.
    for (const segment of segments) {
      for (const match of findTerminalHttpLinks(
        text.slice(segment.start, segment.end),
      )) {
        const range = rangeFor({
          start: segment.start + match.start,
          end: segment.start + match.end,
        });
        if (!range || (infer && range.end.x >= columnCount - 1)) continue;
        links.push({
          range,
          hover,
          text: match.url,
          target: { kind: "url", value: match.url },
          activate(event, raw) {
            event.preventDefault();
            if (!isShown(range) || !terminalLinkModifierMatches(event)) return;
            const url = sanitizeTerminalHttpUrl(raw);
            if (url) {
              term.clearSelection?.();
              window.open(url, "_blank", "noopener,noreferrer");
            }
          },
        });
      }
    }
    const candidates: Array<
      TerminalFileLinkCandidate & { inferred: boolean; speculative: boolean }
    > = [];
    if (onPreviewPath) {
      // Exclude whole URLs as well as the individual row forms so a wrapped
      // URL's path fragment never becomes a local file link.
      const excluded = findTerminalHttpLinks(text);
      const add = (part: TextRange) => {
        const slice = text.slice(part.start, part.end);
        for (const [match, speculative] of [
          ...findTerminalFileLinkCandidates(slice).map(
            (match) => [match, false] as const,
          ),
          ...findTerminalSpacedFileLinkCandidates(slice).map(
            (match) => [match, true] as const,
          ),
        ]) {
          const candidate = {
            ...match,
            speculative,
            start: part.start + match.start,
            end: part.start + match.end,
          };
          if (
            !rangeFor(candidate) ||
            excluded.some((span) => overlaps(candidate, span))
          )
            continue;
          if (
            candidates.some(
              (span) =>
                span.start === candidate.start && span.end === candidate.end,
            )
          )
            continue;
          candidates.push({
            ...candidate,
            inferred: segments.some(
              (segment) =>
                candidate.start < segment.end && candidate.end > segment.end,
            ),
          });
        }
      };
      add({ start: 0, end: text.length });
      if (segments.length > 1) {
        // A path may end before another prose row or start after one. Try
        // complete segment spans around the requested row, not just the
        // longest guessed token and individual fragments.
        for (let first = 0; first < segments.length; first++) {
          for (let last = first; last < segments.length; last++) {
            const span = {
              start: segments[first]!.start,
              end: segments[last]!.end,
            };
            if (rangeFor(span)) add(span);
          }
        }
      }
    }
    // Prefer the complete existing path; retain standalone row links when a
    // speculative join does not resolve. Validate ambiguous absolute fragments
    // too, instead of making a known partial path immediately clickable.
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
    // Spaced paths exist only if the server finds them; a word-split prefix
    // of one (`/data/My` in `/data/My Project/a.ts`) must resolve as well.
    const needsResolution = (candidate: (typeof candidates)[number]) =>
      !candidate.absolute ||
      candidate.inferred ||
      candidate.speculative ||
      candidates.some(
        (other) =>
          (other.inferred || other.speculative) && overlaps(candidate, other),
      );
    const pending = candidates.filter(needsResolution);
    const finish = (resolved = new Map<string, string>()) => {
      if (disposed) {
        if (touch) callback(undefined);
        return;
      }
      // Rows beside a link may repaint during the lookup (a spinner on the
      // next row of a joined context); deliver the links whose rows did not.
      if (!viewCurrent()) {
        callback(undefined);
        return;
      }
      links.splice(
        0,
        links.length,
        ...links.filter((link) => isShown(link.range)),
      );
      const accepted: TextRange[] = [];
      for (const candidate of candidates) {
        const path = needsResolution(candidate)
          ? resolved.get(candidate.path)
          : candidate.path;
        const range = rangeFor(candidate)!;
        if (
          !path ||
          !isShown(range) ||
          accepted.some((span) => overlaps(candidate, span))
        )
          continue;
        accepted.push(candidate);
        links.push({
          range,
          hover,
          text: candidate.path,
          target: { kind: "file", value: path },
          activate(event) {
            event.preventDefault();
            if (
              isShown(range) &&
              !term.hasSelection?.() &&
              !event.shiftKey &&
              !event.altKey
            ) {
              term.clearSelection?.();
              onPreviewPath?.(path, event);
            }
          },
        });
      }
      if (!upstream) {
        callback(links.length ? links : undefined);
        return;
      }
      // Probe URL starts and one continuation cell, never every terminal cell.
      const row = bufferLineNumber - 1 - (viewport ?? 0);
      const rowLine = activeBuffer.getLine(bufferLineNumber - 1);
      const rowText = rowLine
        ? lineTextWithCells(rowLine, columnCount, bufferLineNumber)
        : null;
      const first = rowText?.text.search(/\S/) ?? -1;
      const columns = new Set<number>();
      const rowUrls = findTerminalHttpLinks(rowText?.text ?? "");
      // A complete visible URL is already authoritative. Probing it remotely
      // can replace its trimmed punctuation with a wider region, or lose every
      // reply while a TUI timer repaints. Reserve RPCs for wraps/clipped edges.
      const previousLine = activeBuffer.getLine(bufferLineNumber - 2);
      const continuation =
        first === 0 &&
        previousLine &&
        lineTextWithCells(previousLine, columnCount, bufferLineNumber - 1)
          .text.slice(-2)
          .trim();
      const hasResolvedFile = links.some((link) => link.target.kind === "file");
      if (
        first >= 0 &&
        (rowUrls.length === 0 || continuation) &&
        (!hasResolvedFile || continuation)
      )
        columns.add(rowText!.cells[first]!.start.x - 1);
      for (const link of rowUrls) {
        const col = rowText!.cells[link.start]!.start.x - 1;
        // Sanitization can hide an unclosed suffix at the screen edge. Require
        // a raw token boundary, leaving room for a possible wide-glyph spacer.
        // An interior suffix like part/http://x.test has no proven left edge.
        // Leading indentation may be an application's own wrapping boundary.
        const whitespace = rowText!.text.slice(link.end).search(/\s/);
        const complete =
          /(?:^|\s)[("'`[{<]*$/.test(rowText!.text.slice(0, link.start)) &&
          whitespace >= 0 &&
          rowText!.cells[link.end + whitespace]!.start.x < columnCount &&
          links.some(
            (local) =>
              local.target.kind === "url" &&
              local.range.start.y === bufferLineNumber &&
              local.range.end.y === bufferLineNumber &&
              local.range.start.x === col + 1 &&
              local.range.end.x < columnCount - 1 &&
              link.start > first,
          );
        if (!complete) columns.add(col);
      }
      if (touch) {
        columns.clear();
        columns.add(touch.col);
      }
      if (!columns.size) {
        callback(links.length ? links : undefined);
        return;
      }
      const resolve = async () => {
        const resolved: TerminalResolvedLink[] = [];
        for (const col of [...columns].slice(0, MAX_CANDIDATES_PER_LINE)) {
          if (!isFrameCurrent()) {
            callback(undefined);
            return;
          }
          if (
            resolved.some((link) =>
              link.regions.some(
                (r) => r.row === row && r.start_col <= col && r.end_col >= col,
              ),
            )
          )
            continue;
          try {
            const link = await upstream.resolve(row, col, !!touch);
            if (touch && link && "uri" in link) {
              if (!isFrameCurrent()) {
                callback(undefined);
                return;
              }
              const uri = link.uri ?? "";
              const path = terminalFileUriPath(uri);
              const url = sanitizeTerminalHttpUrl(uri);
              const target: TerminalTouchLink | null = path
                ? { kind: "file", value: path }
                : url && url === uri
                  ? { kind: "url", value: url }
                  : null;
              callback(
                target
                  ? [
                      {
                        text: uri,
                        target,
                        range: {
                          start: { x: col + 1, y: bufferLineNumber },
                          end: { x: col + 1, y: bufferLineNumber },
                        },
                        activate() {},
                      },
                    ]
                  : undefined,
              );
              return;
            }
            if (link) resolved.push(link);
          } catch {
            if (touch) {
              callback(undefined);
              return;
            }
            break;
          }
        }
        if (!isFrameCurrent()) {
          callback(undefined);
          return;
        }
        const regions = resolved.flatMap((link) => link.regions);
        const accepted = links.filter(
          (link) =>
            !regions.some((r) => {
              const y = r.row + (viewport ?? 0) + 1;
              return (
                link.range.start.y <= y &&
                link.range.end.y >= y &&
                (link.range.start.y < y ||
                  link.range.start.x <= r.end_col + 1) &&
                (link.range.end.y > y || link.range.end.x >= r.start_col + 1)
              );
            }),
        );
        for (const link of resolved) {
          if (!link.url || sanitizeTerminalHttpUrl(link.url) !== link.url)
            continue;
          if (!link.regions.some((region) => region.row === row)) continue;
          // The bridge validates contiguous regions. Keep one logical range so
          // every wrapped row underlines, whichever row is hovered.
          const first = link.regions[0]!;
          const last = link.regions[link.regions.length - 1]!;
          accepted.push({
            text: link.url,
            target: { kind: "url", value: link.url },
            hover,
            range: {
              start: {
                x: first.start_col + 1,
                y: first.row + (viewport ?? 0) + 1,
              },
              end: {
                x: last.end_col + 1,
                y: last.row + (viewport ?? 0) + 1,
              },
            },
            activate(event) {
              event.preventDefault();
              if (isFrameCurrent() && terminalLinkModifierMatches(event)) {
                term.clearSelection?.();
                window.open(link.url!, "_blank", "noopener,noreferrer");
              }
            },
          });
        }
        callback(accepted.length ? accepted : undefined);
      };
      void resolve();
    };
    if (!pending.length || !resolvePaths) {
      finish();
      return;
    }
    const resolveAll = async () => {
      const paths = [...new Set(pending.map((candidate) => candidate.path))];
      const resolved = new Map<string, string>();
      // Contexts can exceed the per-line cache and server batch limit.
      for (let i = 0; i < paths.length; i += MAX_CANDIDATES_PER_LINE) {
        if (!viewCurrent()) break;
        const batch = await resolvePaths(
          paths.slice(i, i + MAX_CANDIDATES_PER_LINE),
        );
        for (const [candidate, path] of batch) resolved.set(candidate, path);
      }
      return resolved;
    };
    void resolveAll().then(finish, () => finish());
  };
  const registration = term.registerLinkProvider({ provideLinks });
  return {
    /** Independent lookup: never replaces the pending hover row generation. */
    resolveTouch(row: number, col: number, current: () => boolean) {
      const y = term.buffer.active.viewportY + row + 1;
      return new Promise<TerminalTouchLink | null>((reply) => {
        provideLinks(
          y,
          (links) => {
            const link = links?.find(
              ({ range }) =>
                range.start.y <= y &&
                range.end.y >= y &&
                (range.start.y < y || range.start.x <= col + 1) &&
                (range.end.y > y || range.end.x >= col + 1),
            );
            reply(current() ? (link?.target ?? null) : null);
          },
          { col, current },
        );
      });
    },
    dispose() {
      disposed = true;
      registration.dispose();
    },
  };
}

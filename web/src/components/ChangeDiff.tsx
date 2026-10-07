import { DEFAULT_THEMES, getSingularPatch } from "@pierre/diffs";
import {
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { useQueries } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronUp, FolderOpen } from "lucide-react";
import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ConnectionClient } from "../api";
import { thyraLocalStorage } from "../browserStorage";
import { t } from "../i18n";
import {
  type GitDiffSummaryMode,
  gitDiffFileQuery,
  inspectorQueries,
} from "../inspectorQueries";
import { bundledLanguages, syntaxLanguageForPath } from "../syntaxLanguage";
import { shortcutMatches, shortcutTitle } from "../shortcutPreferences";
import type { GitDiffEntry, GitDiffFile } from "../types";
import { GitStatusTokens } from "./ChangesList";
import { useDocumentTheme } from "./documentTheme";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import "./ChangeDiff.css";

// The diff of one changed file (Pierre, unified, read-only). It loads lazily
// with its syntax highlighter; each patch is fetched when its file is shown.

type DiffOptions = NonNullable<ComponentProps<typeof FileDiff>["options"]>;

const WRAP_KEY = "desktopDiffWrap";
const WORKER_POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(
    Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    globalThis.matchMedia?.("(pointer: coarse)")?.matches ? 1 : 2,
  ),
  totalASTLRUCacheSize: 8,
  workerFactory: () =>
    new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
      type: "module",
    }),
};
const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: DEFAULT_THEMES,
  preferredHighlighter: "shiki-js",
};

let nextPatchCacheKey = 0;

function diffLanguageForPath(path: string) {
  const language = syntaxLanguageForPath(path);
  return language in bundledLanguages ? language : "text";
}

export function highlightedPatch(patch: string, path: string) {
  const diff = getSingularPatch(patch);
  // Each parsed patch needs its own worker cache entry.
  diff.cacheKey = `patch:${++nextPatchCacheKey}`;
  const language = diffLanguageForPath(path);
  // Pierre applies lang to both sides; let it infer each side of a rename
  // that changes language.
  if (!diff.prevName || diffLanguageForPath(diff.prevName) === language) {
    diff.lang = language;
  }
  return diff;
}

/** Shows the raw patch if Pierre cannot parse or render it. */
class RawFallback extends Component<
  { patch: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <pre className="change-diff-raw">{this.props.patch}</pre>
    ) : (
      this.props.children
    );
  }
}

function HighlightedPatch({
  patch,
  path,
  options,
}: {
  patch: string;
  path: string;
  options: DiffOptions;
}) {
  const fileDiff = useMemo(() => highlightedPatch(patch, path), [patch, path]);
  return <FileDiff fileDiff={fileDiff} options={options} />;
}

export type ChangeTarget = {
  patch: number;
  line: number;
  side: "addition" | "deletion";
  /** Position within the patch, for scrolling to a not-yet-rendered line. */
  ratio: number;
};

/** The first changed line of every hunk in a unified patch. */
export function hunkTargets(patch: string): ChangeTarget[] {
  const targets: Omit<ChangeTarget, "ratio">[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let pending = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = pending = true;
    } else if (inHunk && (line[0] === "+" || line[0] === "-")) {
      const side = line[0] === "+" ? "addition" : "deletion";
      if (pending) {
        targets.push({
          patch: 0,
          line: side === "addition" ? newLine : oldLine,
          side,
        });
        pending = false;
      }
      if (side === "addition") newLine += 1;
      else oldLine += 1;
    } else if (inHunk && line[0] === " ") {
      oldLine += 1;
      newLine += 1;
    }
  }
  const last = Math.max(1, newLine, oldLine);
  return targets.map((target) => ({ ...target, ratio: target.line / last }));
}

const hunkTargetCache = new WeakMap<GitDiffFile, ChangeTarget[]>();
function cachedHunkTargets(file: GitDiffFile, index: number) {
  let targets = hunkTargetCache.get(file);
  if (!targets) hunkTargetCache.set(file, (targets = hunkTargets(file.diff)));
  return targets.map((target) => ({ ...target, patch: index }));
}

/** Scrolls a change into view; Pierre renders lines near the viewport only. */
function revealChange(section: HTMLElement, target: ChangeTarget, attempt = 0) {
  const patch =
    section.querySelectorAll<HTMLElement>("[data-patch]")[target.patch];
  const line = patch
    ?.querySelector("diffs-container")
    ?.shadowRoot?.querySelector<HTMLElement>(
      `[data-line='${target.line}'][data-line-type='change-${target.side}']`,
    );
  if (line) {
    line.scrollIntoView({ block: "center" });
    return;
  }
  const scroller = section.querySelector<HTMLElement>(".change-diff-scroll");
  if (!patch || !scroller || attempt > 20) return;
  if (attempt === 0) {
    const top =
      patch.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop +=
      top + target.ratio * patch.offsetHeight - scroller.clientHeight / 2;
  }
  requestAnimationFrame(() => revealChange(section, target, attempt + 1));
}

function Patch({
  file,
  error,
  path,
  label,
  options,
}: {
  file?: GitDiffFile;
  error: Error | null;
  path: string;
  label?: string;
  options: DiffOptions;
}) {
  const images = [
    [t("Before"), file?.old_image],
    [t("After"), file?.new_image],
  ].filter((side): side is [string, string] => !!side[1]);
  return (
    <>
      {label ? <div className="change-diff-note">{label}</div> : null}
      {error ? (
        <div className="diff-content-state is-error">{error.message}</div>
      ) : !file ? (
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          {t("Loading diff")}
        </div>
      ) : images.length ? (
        <div className="change-diff-images">
          {images.map(([caption, src]) => (
            <figure key={caption}>
              <figcaption>{caption}</figcaption>
              <img src={src} alt={`${caption}: ${path}`} />
            </figure>
          ))}
        </div>
      ) : !file.diff ? (
        <div className="diff-content-state">
          {t("No textual diff available.")}
        </div>
      ) : (
        <>
          {file.truncated ? (
            <div className="change-diff-note">
              {t("Diff truncated at 512 KB.")}
            </div>
          ) : null}
          {/* Remount on a new patch: Pierre's line cache can index out of
              range when a reload replaces the whole patch. */}
          <RawFallback key={file.diff} patch={file.diff}>
            <HighlightedPatch patch={file.diff} path={path} options={options} />
          </RawFallback>
        </>
      )}
    </>
  );
}

export function ChangeDiff({
  client,
  workspaceId,
  mode,
  entries,
  embedded = false,
  onBack,
  onOpenFile,
}: {
  client: ConnectionClient;
  workspaceId: string;
  mode: GitDiffSummaryMode;
  /** The summary entries of one path (staged and unstaged are separate). */
  entries: GitDiffEntry[];
  /** Inside the file preview, which already names the file. */
  embedded?: boolean;
  onBack?: () => void;
  onOpenFile?: (entry: GitDiffEntry) => void;
}) {
  const theme = useDocumentTheme();
  const [wrap, setWrap] = useState(
    () => thyraLocalStorage.getItem(WRAP_KEY) !== "false",
  );
  const options = useMemo<DiffOptions>(
    () => ({
      theme: DEFAULT_THEMES,
      themeType: theme,
      diffStyle: "unified",
      overflow: wrap ? "wrap" : "scroll",
      disableFileHeader: true,
      diffIndicators: "bars",
      hunkSeparators: "line-info",
      lineDiffType: "word-alt",
      maxLineDiffLength: 2_000,
      tokenizeMaxLineLength: 4_000,
      tokenizeMaxLength: 250_000,
      preferredHighlighter: "shiki-js",
    }),
    [theme, wrap],
  );
  const entry = entries[0];
  const results = useQueries(
    {
      queries: entries.map((candidate) =>
        gitDiffFileQuery(client, workspaceId, mode, candidate),
      ),
    },
    inspectorQueries,
  );
  const files = results.map((result) => result.data);
  const targets = files.flatMap((file, index) =>
    file && !file.old_image && !file.new_image
      ? cachedHunkTargets(file, index)
      : [],
  );
  const sectionRef = useRef<HTMLElement | null>(null);
  const [change, setChange] = useState(-1);
  // A new selection or refresh starts before the first change again.
  useEffect(() => setChange(-1), [entries]);
  const goToChange = (delta: 1 | -1) => {
    if (!targets.length || !sectionRef.current) return;
    const next =
      change < 0
        ? delta > 0
          ? 0
          : targets.length - 1
        : (change + delta + targets.length) % targets.length;
    setChange(next);
    revealChange(sectionRef.current, targets[next]!);
  };
  return (
    <section
      ref={sectionRef}
      className="change-diff"
      aria-label={embedded ? t("File changes") : t("Diff Viewer content")}
      onKeyDown={(event) => {
        const delta = shortcutMatches(event.nativeEvent, "diff.nextChange")
          ? 1
          : shortcutMatches(event.nativeEvent, "diff.previousChange")
            ? -1
            : 0;
        if (!delta) return;
        event.preventDefault();
        goToChange(delta);
      }}
    >
      <div className="ui-bar change-diff-bar">
        {onBack ? (
          <IconButton
            label={t("Changed files")}
            onClick={onBack}
            icon={<ChevronLeft size={14} aria-hidden="true" />}
          />
        ) : null}
        {entry && !embedded ? (
          <>
            <GitStatusTokens entries={entries} />
            <span className="ui-bar-title change-diff-path" title={entry.path}>
              {entry.path}
            </span>
          </>
        ) : null}
        <span className="ui-bar-spacer" />
        {targets.length ? (
          <span className="change-diff-nav" aria-label={t("Change navigation")}>
            <IconButton
              label={t("Previous change")}
              tooltip={shortcutTitle(
                t("Previous change"),
                "diff.previousChange",
              )}
              onClick={() => goToChange(-1)}
              icon={<ChevronUp size={14} />}
            />
            <span>{`${change < 0 ? "-" : change + 1}/${targets.length}`}</span>
            <IconButton
              label={t("Next change")}
              tooltip={shortcutTitle(t("Next change"), "diff.nextChange")}
              onClick={() => goToChange(1)}
              icon={<ChevronDown size={14} />}
            />
          </span>
        ) : null}
        <Button
          aria-pressed={wrap}
          onClick={() => {
            thyraLocalStorage.setItem(WRAP_KEY, String(!wrap));
            setWrap(!wrap);
          }}
        >
          {t("Wrap")}
        </Button>
        {entry && onOpenFile && entry.status !== "deleted" ? (
          <IconButton
            label={t("Open in Files")}
            onClick={() => onOpenFile(entry)}
            icon={<FolderOpen size={15} />}
          />
        ) : null}
      </div>
      {entry ? (
        <WorkerPoolContextProvider
          poolOptions={WORKER_POOL_OPTIONS}
          highlighterOptions={HIGHLIGHTER_OPTIONS}
        >
          <Virtualizer className="change-diff-scroll">
            {entries.map((candidate, index) => (
              <div key={`${candidate.kind}:${candidate.path}`} data-patch>
                <Patch
                  file={files[index]}
                  error={results[index]?.error ?? null}
                  path={candidate.path}
                  label={
                    entries.length > 1
                      ? candidate.kind === "staged"
                        ? t("staged")
                        : t("unstaged")
                      : undefined
                  }
                  options={options}
                />
              </div>
            ))}
          </Virtualizer>
        </WorkerPoolContextProvider>
      ) : (
        <div className="diff-content-state">{t("No changed files.")}</div>
      )}
    </section>
  );
}

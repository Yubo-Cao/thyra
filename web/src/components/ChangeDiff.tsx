import { DEFAULT_THEMES, getSingularPatch } from "@pierre/diffs";
import {
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, FolderOpen } from "lucide-react";
import {
  Component,
  useMemo,
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
import type { GitDiffEntry } from "../types";
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

function Patch({
  client,
  workspaceId,
  mode,
  entry,
  label,
  options,
}: {
  client: ConnectionClient;
  workspaceId: string;
  mode: GitDiffSummaryMode;
  entry: GitDiffEntry;
  label?: string;
  options: DiffOptions;
}) {
  const { data, error } = useQuery(
    gitDiffFileQuery(client, workspaceId, mode, entry),
    inspectorQueries,
  );
  return (
    <>
      {label ? <div className="change-diff-note">{label}</div> : null}
      {error ? (
        <div className="diff-content-state is-error">{error.message}</div>
      ) : !data ? (
        <div className="diff-content-state">
          <span className="file-loading-spinner" />
          {t("Loading diff")}
        </div>
      ) : !data.diff ? (
        <div className="diff-content-state">
          {t("No textual diff available.")}
        </div>
      ) : (
        <>
          {data.truncated ? (
            <div className="change-diff-note">
              {t("Diff truncated at 512 KB.")}
            </div>
          ) : null}
          {/* Remount on a new patch: Pierre's line cache can index out of
              range when a reload replaces the whole patch. */}
          <RawFallback key={data.diff} patch={data.diff}>
            <HighlightedPatch
              patch={data.diff}
              path={entry.path}
              options={options}
            />
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
  return (
    <section
      className="change-diff"
      aria-label={embedded ? t("File changes") : t("Diff Viewer content")}
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
            {entries.map((candidate) => (
              <Patch
                client={client}
                key={`${candidate.kind}:${candidate.path}`}
                workspaceId={workspaceId}
                mode={mode}
                entry={candidate}
                label={
                  entries.length > 1
                    ? candidate.kind === "staged"
                      ? t("staged")
                      : t("unstaged")
                    : undefined
                }
                options={options}
              />
            ))}
          </Virtualizer>
        </WorkerPoolContextProvider>
      ) : (
        <div className="diff-content-state">{t("No changed files.")}</div>
      )}
    </section>
  );
}

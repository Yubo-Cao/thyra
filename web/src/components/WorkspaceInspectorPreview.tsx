import { ArrowUp, File, Folder } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ConnectionClient } from "../api";
import { t } from "../i18n";
import type { FileExplorerEntry } from "../types";
import {
  rawPreviewPath,
  resolveWorkspaceMarkdownImagePath,
  workspaceRawFileUrl,
} from "../workspaceFileUrl";
import {
  entryIsFolder,
  previewKind,
  previewName,
  previewNeighbor,
  previewParent,
} from "./inspectorPreviewModel";
import { MarkdownPreview } from "./markdown";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Spinner } from "./ui/Spinner";
import { type PreviewTarget, useInspectorPreview } from "./useInspectorPreview";
import "./WorkspaceInspectorPreview.css";

const EMPTY: string[] = [];
const NO_ENTRIES: FileExplorerEntry[] = [];

function samePaths(a: string[], b: string[]) {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

function TextPreview({ text, line }: { text: string; line?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const { numbers, count } = useMemo(() => {
    const lines = text.split("\n");
    return {
      count: lines.length,
      numbers: lines.map((_, index) => index + 1).join("\n"),
    };
  }, [text]);
  const selected = line ? Math.min(line, count) : undefined;
  useLayoutEffect(() => {
    const element = box.current;
    const row = element?.querySelector<HTMLElement>("[data-line]");
    if (row && element)
      element.scrollTop =
        row.offsetTop - element.clientHeight / 2 + row.offsetHeight / 2;
  }, [selected, text]);
  return (
    <div ref={box} className="workspace-preview-text" tabIndex={0}>
      {selected ? (
        <span
          aria-hidden="true"
          data-line={selected}
          style={{ top: `calc(8px + ${selected - 1} * 1lh)` }}
        />
      ) : null}
      <pre aria-hidden="true">{numbers}</pre>
      <pre>{text}</pre>
    </div>
  );
}

function HtmlPreview({
  initialUrl,
  version,
  onPaths,
  active,
}: {
  initialUrl: string;
  version: number;
  onPaths: (paths: string[]) => void;
  active: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const reported = useRef("");
  const [src, setSrc] = useState(initialUrl);
  const previousVersion = useRef(version);
  useEffect(() => {
    if (previousVersion.current === version) return;
    previousVersion.current = version;
    const url = new URL(reported.current || initialUrl, location.origin);
    // Refresh from the authenticated route and keep the relative page selected
    // inside the frame, including its query and fragment.
    const parts = url.pathname.split("/");
    parts[9] = "-";
    url.pathname = parts.join("/");
    url.searchParams.set("v", String(version));
    setSrc(url.pathname + url.search + url.hash);
  }, [version, initialUrl]);
  useLayoutEffect(() => {
    const report = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.type !== "thyra-file-preview" ||
        typeof event.data.url !== "string"
      )
        return;
      const path = rawPreviewPath(event.data.url, initialUrl);
      if (!path) return;
      reported.current = event.data.url;
      const assets: unknown[] = Array.isArray(event.data.assets)
        ? event.data.assets
        : [];
      onPaths([
        ...new Set([
          path,
          ...assets
            .slice(0, 64)
            .map((asset) =>
              typeof asset === "string"
                ? rawPreviewPath(asset, initialUrl)
                : null,
            )
            .filter((asset): asset is string => !!asset),
        ]),
      ]);
    };
    window.addEventListener("message", report);
    return () => window.removeEventListener("message", report);
  }, [onPaths, initialUrl]);
  useEffect(() => {
    if (!active) return;
    // Keep the opaque origin's short-lived read grant active while displayed.
    const ping = async () => {
      const current = reported.current;
      if (!current) return;
      const response = await fetch(current, {
        method: "HEAD",
        cache: "no-store",
      }).catch(() => null);
      if (response?.status === 401 && reported.current === current) {
        const url = new URL(current);
        const parts = url.pathname.split("/");
        parts[9] = "-";
        url.pathname = parts.join("/");
        url.searchParams.set("v", String(Date.now()));
        setSrc(url.pathname + url.search + url.hash);
      }
    };
    void ping();
    const timer = setInterval(() => void ping(), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <iframe
      ref={frame}
      src={src}
      title={t("HTML preview")}
      className="workspace-preview-frame"
    />
  );
}

export function WorkspaceInspectorPreview({
  client,
  workspaceId,
  target,
  active,
  hidden,
  onSelect,
  onReady,
}: {
  client: ConnectionClient;
  workspaceId: string;
  target: PreviewTarget;
  active: boolean;
  hidden: boolean;
  onSelect: (path: string, directory?: boolean, fragment?: string) => void;
  onReady: (target: PreviewTarget, kind: "text" | "folder" | "other") => void;
}) {
  const [html, setHtml] = useState<{
    target: PreviewTarget;
    paths: string[];
  }>();
  const [markdown, setMarkdown] = useState<{
    target: PreviewTarget;
    paths: string[];
  }>();
  const markdownRoot = useRef<HTMLDivElement>(null);
  const rawUrl = useCallback(
    (path: string, version?: number) =>
      workspaceRawFileUrl(client, workspaceId, path, version),
    [client, workspaceId],
  );
  const kind = previewKind(target.path);
  const defaultHtmlPaths = useMemo(
    () => (kind === "html" && !target.directory ? [target.path] : EMPTY),
    [target, kind],
  );
  const htmlPaths = html?.target === target ? html.paths : defaultHtmlPaths;
  const markdownImages = markdown?.target === target ? markdown.paths : EMPTY;
  const reportHtml = useCallback(
    (paths: string[]) => {
      setHtml((current) =>
        current?.target === target && samePaths(current.paths, paths)
          ? current
          : { target, paths },
      );
    },
    [target],
  );
  const {
    file,
    folder,
    directory,
    listing,
    listingError,
    error,
    versions,
    htmlVersion,
  } = useInspectorPreview(
    client,
    workspaceId,
    target,
    active && !hidden,
    htmlPaths,
    markdownImages,
  );
  const entries = listing?.entries ?? NO_ENTRIES;
  const initialStamp = useRef<{
    target: PreviewTarget;
    observed?: number;
    url?: number;
  }>(undefined);
  const stamp = versions.get(target.path);
  if (initialStamp.current?.target !== target) {
    initialStamp.current = { target, observed: stamp, url: stamp };
  } else if (stamp !== initialStamp.current.observed) {
    if (initialStamp.current.observed !== undefined)
      initialStamp.current.url = stamp;
    initialStamp.current.observed = stamp;
  }
  const asset = rawUrl(
    target.path,
    kind === "image" ? initialStamp.current.url : undefined,
  );
  const selectEntry = (entry: FileExplorerEntry) =>
    onSelect(entry.path, entryIsFolder(entry));

  useEffect(() => {
    if (folder) onReady(target, "folder");
    else if (
      kind === "text" &&
      file?.text !== undefined &&
      file.text !== null
    ) {
      // Give the native view a paint even if the editor is already warm.
      let paint = 0;
      const first = requestAnimationFrame(() => {
        paint = requestAnimationFrame(() => onReady(target, "text"));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(paint);
      };
    } else if (error || file?.text === null) onReady(target, "other");
  }, [target, folder, kind, file?.text, error, onReady]);

  const nearbyImages = [-1, 1]
    .map(
      (direction) =>
        previewNeighbor(entries, target.path, direction, true)?.path,
    )
    .filter((path): path is string => !!path)
    .map((path) => rawUrl(path, versions.get(path)));
  const previousImage = nearbyImages[0];
  const nextImage = nearbyImages[1];
  const decodedImages = useRef(new Map<string, HTMLImageElement>());
  useEffect(() => {
    if (!active || hidden || kind !== "image") return;
    for (const url of [previousImage, nextImage]) {
      if (!url || decodedImages.current.has(url)) continue;
      if (decodedImages.current.size >= 8)
        decodedImages.current.delete(
          decodedImages.current.keys().next().value!,
        );
      const image = new Image();
      image.src = url;
      decodedImages.current.set(url, image);
      void image.decode().catch(() => decodedImages.current.delete(url));
    }
  }, [active, hidden, kind, previousImage, nextImage]);

  const onKeys = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const horizontally =
      event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (
      horizontally
        ? kind !== "image"
        : event.key !== "ArrowUp" && event.key !== "ArrowDown"
    )
      return;
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const entry = previewNeighbor(
      entries,
      target.path,
      direction,
      horizontally,
    );
    if (entry) {
      event.preventDefault();
      selectEntry(entry);
    }
  };

  // Keep the Markdown HTML stable on unrelated directory changes.
  const markdownVersions = JSON.stringify(
    markdownImages.map((path) => [path, versions.get(path)]),
  );
  const imageUrl = useMemo(() => {
    const stamps = new Map<string, number>(JSON.parse(markdownVersions));
    return (source: string) => {
      const path = resolveWorkspaceMarkdownImagePath(source, target.path);
      return path === undefined
        ? source
        : path
          ? rawUrl(path, stamps.get(path))
          : null;
    };
  }, [markdownVersions, rawUrl, target.path]);
  useLayoutEffect(() => {
    const root = markdownRoot.current;
    if (!root) return;
    const base = rawUrl(target.path);
    const paths = [
      ...new Set(
        Array.from(root.querySelectorAll("img[src]"), (image) =>
          rawPreviewPath(image.getAttribute("src")!, base),
        ).filter((path): path is string => !!path),
      ),
    ];
    setMarkdown((current) =>
      current?.target === target && samePaths(current.paths, paths)
        ? current
        : { target, paths },
    );
  }, [target, file?.text, rawUrl]);
  const linkUrl = useCallback((path: string) => rawUrl(path), [rawUrl]);

  const name = previewName(target.path);
  const openParent = directory && previewParent(directory) !== directory;
  const contents = folder ? null : error ? (
    <p className="workspace-preview-status" role="alert">
      {error}
    </p>
  ) : kind === "image" ? (
    <ImagePreview url={asset} name={name} onKeys={onKeys} />
  ) : kind === "html" ? (
    <HtmlPreview
      key={target.nonce}
      initialUrl={rawUrl(target.path)}
      active={active && !hidden}
      version={htmlVersion}
      onPaths={reportHtml}
    />
  ) : kind === "pdf" ? (
    <iframe
      className="workspace-preview-frame"
      src={asset}
      title={t("PDF preview")}
    />
  ) : kind === "video" ? (
    // biome-ignore lint/a11y/useMediaCaption: user-created files have no supplied caption track.
    <video src={asset} controls />
  ) : kind === "audio" ? (
    // biome-ignore lint/a11y/useMediaCaption: user-created files have no supplied caption track.
    <audio src={asset} controls />
  ) : !file ? (
    <div className="workspace-preview-status">
      <Spinner label={t("Loading preview...")} />
    </div>
  ) : file.text === null ? (
    <p className="workspace-preview-status">{t("Preview unavailable")}</p>
  ) : kind === "markdown" ? (
    <div ref={markdownRoot} className="workspace-preview-document">
      <MarkdownPreview
        text={file.text}
        documentPath={target.path}
        imageUrlResolver={imageUrl}
        linkUrlResolver={linkUrl}
        onOpenDocument={(path, fragment) => onSelect(path, undefined, fragment)}
        fragment={target.fragment}
      />
    </div>
  ) : (
    <TextPreview key={target.nonce} text={file.text} line={target.line} />
  );

  return (
    <div className="workspace-preview" hidden={hidden}>
      <nav
        className="workspace-preview-tree"
        aria-label={t("Files")}
        onKeyDown={onKeys}
      >
        <div className="ui-bar workspace-preview-directory">
          <IconButton
            icon={<ArrowUp size={15} />}
            label={t("Parent folder")}
            disabled={!openParent}
            onClick={() => onSelect(previewParent(directory), true)}
          />
          <code title={directory || listing?.checkout_path}>
            {previewName(directory) || t("Files")}
          </code>
        </div>
        <div className="workspace-preview-entries">
          {entries.map((entry) => (
            <Button
              key={entry.path}
              fullWidth
              aria-current={
                !folder && target.path === entry.path ? "true" : undefined
              }
              onClick={() => selectEntry(entry)}
            >
              {entryIsFolder(entry) ? <Folder size={14} /> : <File size={14} />}
              <span>{entry.name}</span>
            </Button>
          ))}
          {!listing ? (
            listingError ? (
              <p role="alert">{listingError}</p>
            ) : (
              <Spinner label={t("Loading path...")} />
            )
          ) : entries.length === 0 ? (
            <p>{t("Empty")}</p>
          ) : null}
        </div>
      </nav>
      {!folder ? (
        <section className="workspace-preview-view" aria-label={t("Preview")}>
          <div className="ui-bar workspace-preview-filename">
            <span title={target.path}>{name}</span>
          </div>
          {contents}
        </section>
      ) : null}
    </div>
  );
}

function ImagePreview({
  url,
  name,
  onKeys,
}: {
  url: string;
  name: string;
  onKeys: (event: KeyboardEvent) => void;
}) {
  const [failed, setFailed] = useState("");
  return (
    <div className="workspace-preview-image" tabIndex={0} onKeyDown={onKeys}>
      {failed === url ? (
        <p role="alert">{t("Preview unavailable")}</p>
      ) : (
        <img src={url} alt={name} onError={() => setFailed(url)} />
      )}
    </div>
  );
}

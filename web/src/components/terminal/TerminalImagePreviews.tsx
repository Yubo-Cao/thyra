import { useEffect, useState } from "react";
import type { TerminalEngine } from "../../terminalEngine";
import type { ConnectionClient } from "../../api";
import type { FilePreview } from "../../types";
import { findTerminalFileLinkCandidates } from "../../terminalFileLinks";

export function TerminalImagePreviews({
  term,
  client,
  workspaceId,
  cwd,
  onOpen,
}: {
  term: TerminalEngine;
  client: ConnectionClient;
  workspaceId: string;
  cwd?: string;
  onOpen: (path: string) => void;
}) {
  const [images, setImages] = useState<{ path: string; src: string }[]>([]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let epoch = 0;
    let previous = "";
    const cache = new Map<string, { path: string; src: string }>();
    const scan = async () => {
      timer = undefined;
      const rows: string[] = [];
      const buffer = term.buffer.active;
      for (let y = 0; y < term.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        const text = line?.translateToString(true) ?? "";
        if (line?.isWrapped && rows.length) rows[rows.length - 1] += text;
        else rows.push(text);
      }
      const paths = [
        ...new Set(
          rows.flatMap((row) =>
            findTerminalFileLinkCandidates(row)
              .filter((c) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(c.path))
              .map((c) =>
                c.absolute || !cwd
                  ? c.path
                  : `${cwd}/${c.path.replace(/^\.\//, "")}`,
              ),
          ),
        ),
      ].slice(-3);
      const key = JSON.stringify(paths);
      if (key === previous) return;
      previous = key;
      const current = ++epoch;
      setImages([]);
      const next: { path: string; src: string }[] = [];
      for (const path of paths) {
        if (disposed || current !== epoch || !client.isCurrent()) return;
        let image = cache.get(path);
        if (!image) {
          try {
            const preview = (await client.call("file.read", {
              workspace_id: workspaceId,
              path,
            })) as FilePreview;
            if (preview.image_data_url) {
              image = { path, src: preview.image_data_url };
              if (cache.size >= 12) cache.delete(cache.keys().next().value!);
              cache.set(path, image);
            }
          } catch {
            /* A printed path can name an image that does not exist yet. */
          }
        }
        if (image) next.push(image);
      }
      if (!disposed && current === epoch && client.isCurrent()) setImages(next);
    };
    const schedule = () => {
      timer ??= setTimeout(() => void scan(), 300);
    };
    schedule();
    const parsed = term.onWriteParsed(schedule);
    const scroll = term.onScroll(schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      parsed.dispose();
      scroll.dispose();
    };
  }, [term, client, workspaceId, cwd]);
  if (!images.length) return null;
  return (
    <div
      className="terminal-image-previews"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 2,
        display: "flex",
        gap: 6,
        maxWidth: "50%",
        overflow: "auto",
      }}
    >
      {images.map((image) => (
        <button
          key={image.path}
          type="button"
          title={image.path}
          style={{
            padding: 3,
            background: "var(--bg)",
            cursor: "pointer",
          }}
          onClick={() => onOpen(image.path)}
        >
          <img
            src={image.src}
            alt={image.path.split("/").pop()}
            style={{
              display: "block",
              width: 100,
              height: 76,
              objectFit: "contain",
            }}
          />
        </button>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t } from "../i18n";
import "./PdfPreview.css";

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite owns these URLs in development and in embedded standalone builds.
const assets = import.meta.glob<string>(
  "../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm}",
  { eager: true, query: "?url", import: "default" },
);

async function assetBytes(directory: string, name: string) {
  const url = assets[`../../node_modules/pdfjs-dist/${directory}/${name}`];
  if (!url) throw new Error(`Missing PDF asset: ${name}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load PDF asset: ${name}`);
  return new Uint8Array(await response.arrayBuffer());
}

class CMapReaderFactory {
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await assetBytes("cmaps", `${name}.bcmap`),
      isCompressed: true,
    };
  }
}
class StandardFontDataFactory {
  fetch({ filename }: { filename: string }) {
    return assetBytes("standard_fonts", filename);
  }
}
class WasmFactory {
  fetch({ filename }: { filename: string }) {
    return assetBytes("wasm", filename);
  }
}

export function PdfPreview({ url, name }: { url: string; name: string }) {
  const pages = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = pages.current;
    if (!container) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setLoading(true);
    setFailed(false);
    const task = getDocument({
      url,
      isEvalSupported: false,
      useWorkerFetch: false,
      CMapReaderFactory,
      StandardFontDataFactory,
      WasmFactory,
    });
    void (async () => {
      try {
        const document = await task.promise;
        for (let number = 1; number <= document.numPages; number++) {
          if (cancelled) return;
          const page = await document.getPage(number);
          if (cancelled) return;
          const natural = page.getViewport({ scale: 1 });
          // Bound each canvas, including PDFs with unusually large page boxes.
          const viewport = page.getViewport({
            scale: Math.min(
              1.5,
              1800 / Math.max(natural.width, natural.height),
            ),
          });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.setAttribute("role", "img");
          canvas.setAttribute(
            "aria-label",
            t("PDF page {page} of {count}", {
              page: number,
              count: document.numPages,
            }),
          );
          container.append(canvas);
          render = page.render({ canvas, viewport });
          await render.promise;
          page.cleanup();
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
      void task.destroy();
      container.replaceChildren();
    };
  }, [url]);

  return (
    <div
      className="pdf-preview"
      role="region"
      aria-label={t("PDF preview: {name}", { name })}
    >
      {loading ? (
        <div className="file-preview-state" role="status">
          {t("Loading preview")}
        </div>
      ) : null}
      {failed ? (
        <div className="file-preview-state is-error" role="alert">
          {t(
            "PDF could not be rendered. Use Download to open the original file.",
          )}
        </div>
      ) : null}
      <div className="pdf-preview-pages" ref={pages} />
    </div>
  );
}

import { File, Folder, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type IconTarget,
  iconName,
  iconUrl,
  useFileIconLookup,
} from "./fileIcons";

/** Material Icon Theme icon; a generic glyph until the icon table arrives. */
export function FileIcon({
  size = 16,
  light,
  ...target
}: IconTarget & { size?: number; light: boolean }) {
  const lookup = useFileIconLookup();
  if (!lookup) {
    const Glyph = target.directory ? (target.open ? FolderOpen : Folder) : File;
    return <Glyph size={size} className="file-icon-glyph" aria-hidden="true" />;
  }
  return (
    <img
      className="file-icon-image"
      src={iconUrl(lookup, iconName(lookup, target), light)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
    />
  );
}

// One observer for every thumbnail: a tile requests its image only once it
// is within a screen of the scroll viewport, and never blocks the listing.
const visibility = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function observe(element: Element, onVisible: () => void) {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        visibility.get(entry.target)?.();
        visibility.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: "128px" },
  );
  visibility.set(element, onVisible);
  observer.observe(element);
  return () => {
    visibility.delete(element);
    observer?.unobserve(element);
  };
}

/**
 * A thumbnail over its type icon: the image loads when the tile becomes
 * visible and replaces the icon only once decoded; errors keep the icon.
 */
export function FileThumbnail({
  src,
  children,
}: {
  src: string | null;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  useEffect(() => {
    setState("loading");
    if (!src || !ref.current) return;
    return observe(ref.current, () => setVisible(true));
  }, [src]);
  return (
    <span
      ref={ref}
      className="file-thumbnail"
      data-state={src ? state : "none"}
    >
      {state !== "loaded" ? children : null}
      {src && visible && state !== "failed" ? (
        <img
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      ) : null}
    </span>
  );
}

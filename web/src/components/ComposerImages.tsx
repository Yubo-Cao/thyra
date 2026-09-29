import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readComposerImages,
  subscribeComposerImages,
  type ComposerImage,
} from "../terminalComposer";
import "./ComposerImages.css";

export function useComposerImages(draftKey: string) {
  return useSyncExternalStore(
    (notify) => subscribeComposerImages(draftKey, notify),
    () => readComposerImages(draftKey),
  );
}

function Thumbnail({ image }: { image: ComposerImage }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(image.file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [image.file]);
  return (
    <img
      src={url}
      alt={image.file.name}
      title={image.path ?? image.file.name}
      data-uploading={!image.path || undefined}
    />
  );
}

export function ComposerImages({
  images,
}: {
  images: readonly ComposerImage[];
}) {
  if (!images.length) return null;
  return (
    <div className="composer-images">
      {images.map((image) => (
        <Thumbnail key={image.id} image={image} />
      ))}
    </div>
  );
}

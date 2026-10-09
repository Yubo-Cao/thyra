import { useSyncExternalStore } from "react";
import {
  composerImageUrl,
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

export function ComposerImages({
  images,
}: {
  images: readonly ComposerImage[];
}) {
  if (!images.length) return null;
  return (
    <div className="composer-images">
      {images.map((image) => (
        <img
          key={image.id}
          src={composerImageUrl(image)}
          alt={image.file.name}
          title={image.path ?? image.file.name}
          data-uploading={!image.path || undefined}
        />
      ))}
    </div>
  );
}

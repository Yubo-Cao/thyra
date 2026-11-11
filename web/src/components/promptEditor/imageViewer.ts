import "./imageViewer.css";

/**
 * Shows an image full size over the page; a click or Esc closes it. Shared by
 * the prompt editor's draft images and the agent view's transcript.
 */
export function openImageViewer(
  src: string,
  alt: string,
  onClose?: () => void,
) {
  const viewer = document.createElement("div");
  viewer.className = "prompt-md-viewer";
  viewer.setAttribute("role", "dialog");
  viewer.setAttribute("aria-label", alt);
  const image = document.createElement("img");
  image.src = src;
  image.alt = alt;
  viewer.append(image);
  const close = () => {
    viewer.remove();
    window.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  // Esc must not reach what is under the viewer too (an agent, a dialog).
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  viewer.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  document.body.append(viewer);
}

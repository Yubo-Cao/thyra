import { Suspense, type FormEvent, type ReactNode } from "react";
import { LazyDialog, useOpenedOnce } from "./lazyOverlays";

export type DialogSize = "sm" | "md" | "lg" | "full";

export type DialogProps = {
  open: boolean;
  /** Called with false for Escape, backdrop press, the close button, and `close()`. */
  onOpenChange: (open: boolean) => void;
  /** Heading; also the dialog's accessible name. */
  title: ReactNode;
  /** One line under the heading. */
  description?: ReactNode;
  /** Body; scrolls when the dialog reaches the viewport height. */
  children?: ReactNode;
  /** Actions, right-aligned: secondary first, primary last. */
  footer?: ReactNode;
  /** sm 420px, md 560px (default), lg 760px, full = whole viewport. */
  size?: DialogSize;
  /** Close on a backdrop press (default true). */
  dismissable?: boolean;
  /** Close on Escape (default true). */
  keyboardDismissable?: boolean;
  /** Show the header close button (default true). */
  closeButton?: boolean;
  /** Close button name; defaults to t("Close"). */
  closeLabel?: string;
  /** Wrap body and footer in a <form>; a `type="submit"` Button submits it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Controls before the title, e.g. a Back IconButton in a multi-view dialog. */
  headerStart?: ReactNode;
  /** Extra controls in the header, before the close button. */
  headerActions?: ReactNode;
  /** `center` (default) or `side`: a full-height panel at the end edge (a drawer). */
  placement?: "center" | "side";
  /** `alertdialog` for confirmations (ConfirmDialog sets it). */
  role?: "dialog" | "alertdialog";
  /** Marks the dialog busy (aria-busy) while it works. */
  busy?: boolean;
  className?: string;
  bodyClassName?: string;
};

/**
 * Modal dialog (React Aria Modal, HeroUI Modal styling): focus trap, Escape,
 * scroll lock, and focus return. Both placements become a bottom sheet in the
 * mobile layout. The implementation and its CSS load with the overlay chunk
 * the first time `open` is true.
 */
export function Dialog(props: DialogProps) {
  const mounted = useOpenedOnce(props.open);
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <LazyDialog {...props} />
    </Suspense>
  );
}

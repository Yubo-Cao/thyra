import { Dialog, Heading } from "react-aria-components/Dialog";
import { Modal, ModalOverlay } from "react-aria-components/Modal";
import { cn } from "../../../utils";
import { CloseButton } from "../CloseButton";
import type { DialogProps } from "../Dialog";

// React Aria Modal with HeroUI Modal's markup and classes (modal.css).
export function DialogImpl({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissable = true,
  keyboardDismissable = true,
  closeButton = true,
  closeLabel,
  onSubmit,
  headerStart,
  headerActions,
  placement = "center",
  role = "dialog",
  busy,
  className,
  style,
  bodyClassName,
}: DialogProps) {
  const content = (
    <>
      {children != null ? (
        <div
          data-slot="modal-body"
          className={cn(
            "modal__body modal__body--scroll-inside ui-dialog-body",
            bodyClassName,
          )}
        >
          {children}
        </div>
      ) : null}
      {footer ? (
        <div
          data-slot="modal-footer"
          className="modal__footer ui-dialog-footer"
        >
          {footer}
        </div>
      ) : null}
    </>
  );
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable={dismissable}
      isKeyboardDismissDisabled={!keyboardDismissable}
      data-slot="modal-backdrop"
      className="modal__backdrop modal__backdrop--opaque ui-dialog-backdrop"
    >
      <Modal
        data-slot="modal-container"
        data-placement={placement}
        className={cn(
          "modal__container ui-dialog-container",
          size === "full" && "modal__container--full",
        )}
      >
        <Dialog
          role={role}
          aria-busy={busy || undefined}
          data-slot="modal-dialog"
          data-placement={placement}
          data-size={size}
          style={style}
          className={cn(
            "modal__dialog modal__dialog--scroll-inside ui-dialog",
            className,
          )}
        >
          <div
            data-slot="modal-header"
            className="modal__header ui-dialog-header"
          >
            {headerStart}
            <div className="ui-dialog-titles">
              <Heading
                slot="title"
                data-slot="modal-heading"
                className="modal__heading ui-dialog-title"
              >
                {title}
              </Heading>
              {description ? (
                <p className="ui-dialog-description">{description}</p>
              ) : null}
            </div>
            {headerActions}
            {closeButton ? (
              <CloseButton
                label={closeLabel}
                onClick={() => onOpenChange(false)}
              />
            ) : null}
          </div>
          {onSubmit ? (
            <form
              className="ui-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmit(event);
              }}
            >
              {content}
            </form>
          ) : (
            content
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

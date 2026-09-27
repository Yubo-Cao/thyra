import {
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { createStore, useStore } from "zustand";
import {
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
  UNSTABLE_ToastRegion as ToastRegion,
  Text,
} from "react-aria-components/Toast";
import { t } from "../../../i18n";
import type {
  ToastContent as Content,
  ToastController,
  ToastOptions,
  ToastSink,
  ToastTone,
} from "../toastQueue";

const ICONS: Record<ToastTone, typeof Info> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/**
 * Adapts React Aria's toast queue to ToastSink. Content lives here, keyed by
 * toast, so updates re-render in place; a changed timeout re-adds the toast
 * because React Aria timers cannot be restarted.
 */
class AriaToastSink implements ToastSink {
  readonly queue = new ToastQueue<{ key: string }>({ maxVisibleToasts: 4 });
  private readonly contents = new Map<
    string,
    { content: Content; timeout: number }
  >();
  private readonly replaced = new Set<string>();
  /** Bumped when content changes in place. */
  readonly version = createStore<number>()(() => 0);

  add(content: Content, options: Required<ToastOptions>): string {
    const holder = { key: "" };
    holder.key = this.queue.add(holder, {
      timeout: options.timeout || undefined,
      onClose: () => {
        this.contents.delete(holder.key);
        if (this.replaced.delete(holder.key)) return;
        options.onClose();
      },
    });
    this.contents.set(holder.key, { content, timeout: options.timeout });
    return holder.key;
  }

  update(
    key: string,
    content: Content,
    options: Required<ToastOptions>,
  ): string | null {
    const current = this.contents.get(key);
    if (!current) return null;
    if (current.timeout !== options.timeout) {
      this.replaced.add(key);
      this.queue.close(key);
      return this.add(content, options);
    }
    this.contents.set(key, { content, timeout: options.timeout });
    this.version.setState((version) => version + 1, true);
    return key;
  }

  close(key: string): void {
    this.queue.close(key);
  }

  content(key: string): Content | undefined {
    return this.contents.get(key)?.content;
  }
}

// React Aria toast region (F6 landmark, pause on hover/focus, focus
// recovery) laid out as a plain list at the top end.
export function ToastRegionImpl({
  controller,
}: {
  controller: ToastController;
}) {
  const sink = useMemo(() => new AriaToastSink(), []);
  useStore(sink.version);
  useEffect(() => {
    const detach = controller.attach(sink);
    return () => {
      detach();
      sink.queue.clear();
    };
  }, [controller, sink]);

  return (
    <ToastRegion
      queue={sink.queue}
      aria-label={t("Notifications")}
      data-slot="toast-region"
      className="ui-toast-region"
    >
      {({ toast: item }) => {
        const content = sink.content(item.key) ?? { title: "" };
        const tone = content.tone ?? "neutral";
        const Icon = content.loading ? LoaderCircle : ICONS[tone];
        return (
          <Toast
            toast={item}
            data-slot="toast"
            data-tone={tone}
            className="ui-toast"
          >
            <span
              className={
                content.loading ? "ui-toast-icon is-spinning" : "ui-toast-icon"
              }
              aria-hidden="true"
            >
              <Icon size={15} strokeWidth={2.2} />
            </span>
            <ToastContent className="ui-toast-content">
              <Text slot="title" className="ui-toast-title">
                {content.title}
              </Text>
              {content.description ? (
                <Text slot="description" className="ui-toast-description">
                  {content.description}
                </Text>
              ) : null}
              {content.action ? (
                <div className="ui-toast-actions">
                  <button
                    type="button"
                    data-slot="button"
                    className="button button--sm button--secondary"
                    onClick={() => {
                      content.action?.onAction();
                      sink.close(item.key);
                    }}
                  >
                    {content.action.label}
                  </button>
                </div>
              ) : null}
            </ToastContent>
            <button
              type="button"
              data-slot="button"
              className="button button--sm button--ghost button--icon-only ui-toast-close"
              aria-label={t("Dismiss notification")}
              onClick={() => sink.close(item.key)}
            >
              <X size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </Toast>
        );
      }}
    </ToastRegion>
  );
}

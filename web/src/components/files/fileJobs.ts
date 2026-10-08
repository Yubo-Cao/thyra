import { t } from "../../i18n";
import { type ToastContent, toast } from "../ui/toastQueue";
import { baseName, formatSize } from "./fileManagerModel";
import type { ArchiveJob, FileOperationsClient } from "./fileOperations";

const POLL_MS = 500;

export function jobProgress(job: ArchiveJob) {
  const size = formatSize(job.bytes);
  if (job.kind === "compress") return t("{size} written", { size });
  // The entry list is read (and checked) before anything is written.
  if (!job.files && !job.bytes) return t("Checking the archive...");
  if (job.total_bytes) {
    return t("{percent}% · {count} files", {
      percent: Math.min(99, Math.floor((job.bytes / job.total_bytes) * 100)),
      count: job.files,
    });
  }
  return t("{size} · {count} files", { size, count: job.files });
}

/**
 * Follow an archive job in a toast with progress and Cancel; resolves to
 * the new folder or archive, or null when it failed or was canceled.
 */
export async function followArchiveJob(
  ops: FileOperationsClient,
  start: () => Promise<{ job_id: string }>,
  titles: { running: string; done: string; failed: string },
) {
  let id = "";
  const toastId = toast.show(
    {
      title: titles.running,
      loading: true,
      description: t("Starting..."),
      action: {
        label: t("Cancel"),
        onAction: () => {
          if (id) void ops.cancelJob(id).catch(() => {});
        },
      },
    },
    { timeout: 0 },
  );
  // Cancel closes the progress toast, so the outcome may need a new one.
  const finish = (content: ToastContent) => {
    const final = { ...content, loading: false, action: undefined };
    if (!toast.update(toastId, final, { timeout: 6000 })) {
      toast.show(final, { timeout: 6000 });
    }
  };
  try {
    id = (await start()).job_id;
    let job: ArchiveJob;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      job = await ops.job(id);
      if (job.state !== "running") break;
      toast.update(toastId, { description: jobProgress(job) });
    }
    if (job.state === "done" && job.result) {
      finish({
        title: titles.done,
        tone: "success",
        description: baseName(job.result),
      });
      return job.result;
    }
    finish(
      job.state === "canceled"
        ? { title: t("Canceled"), tone: "neutral" }
        : { title: titles.failed, tone: "danger", description: job.error },
    );
  } catch (reason) {
    finish({
      title: titles.failed,
      tone: "danger",
      description: (reason as Error).message,
    });
  }
  return null;
}

/** "Moved ... to the trash" with Undo, worded for where the files went. */
export function trashToast(
  method: "freedesktop" | "macos" | "thyra",
  paths: string[],
  onUndo: () => void,
) {
  const name = baseName(paths[0] ?? "");
  const count = paths.length;
  const title =
    method === "thyra"
      ? count === 1
        ? t("Moved {name} to the Thyra trash folder", { name })
        : t("Moved {count} items to the Thyra trash folder", { count })
      : count === 1
        ? t("Moved {name} to the trash", { name })
        : t("Moved {count} items to the trash", { count });
  toast.show(
    {
      title,
      tone: "neutral",
      action: { label: t("Undo"), onAction: onUndo },
    },
    { timeout: 10000 },
  );
}

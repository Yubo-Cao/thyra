import { useEffect, useState } from "react";
import { type Notice, useStoreSelector } from "../store";

/** Notices briefly take priority, including toasts that require dismissal. */
export function useDocumentTitle(pageTitle: string) {
  const notice = useStoreSelector((state) => state.notice);
  const [expiredNotice, setExpiredNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setExpiredNotice(notice), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const title = notice && notice !== expiredNotice ? notice.message : pageTitle;
  useEffect(() => {
    document.title = title ? `${title} - Thyra` : "Thyra";
  }, [title]);
}

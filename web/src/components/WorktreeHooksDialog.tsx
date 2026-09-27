import { useEffect, useRef, useState } from "react";
import { msg, t } from "../i18n";
import { store } from "../store";
import { useConnectionClient } from "../useConnectionClient";
import { Checkbox } from "./ui/Checkbox";
import { Dialog } from "./ui/Dialog";
import "./WorktreeHooksDialog.css";

const HOOKS = [
  ["setup", msg("Setup")],
  ["opened", msg("Opened")],
  ["teardown", msg("Teardown")],
  ["removed", msg("Removed")],
] as const;

type HookName = (typeof HOOKS)[number][0];

type WorktreeHookInfo = {
  key: string | null;
  enabled: boolean;
  repo_name?: string;
  repo_root?: string;
  checkout_path?: string;
  source_checkout_path?: string;
  paseo_path?: string | null;
  hooks?: Partial<Record<HookName, string>>;
  error?: string;
};

export function WorktreeHooksDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId?: string;
  onClose: () => void;
}) {
  const connectionClient = useConnectionClient();
  const [info, setInfo] = useState<WorktreeHookInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const scopeKey = JSON.stringify([
    open,
    workspaceId ?? null,
    connectionClient.connectionId,
    connectionClient.generation,
  ]);
  const priorScopeKeyRef = useRef(scopeKey);
  const scopeVersionRef = useRef(0);
  if (priorScopeKeyRef.current !== scopeKey) {
    priorScopeKeyRef.current = scopeKey;
    scopeVersionRef.current += 1;
  }

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    const scopeVersion = scopeVersionRef.current;
    const request = ++requestRef.current;
    const requestIsCurrent = () =>
      !cancelled &&
      scopeVersionRef.current === scopeVersion &&
      requestRef.current === request &&
      connectionClient.isCurrent();
    setLoading(true);
    setSaving(false);
    setError("");
    setInfo(null);
    connectionClient
      .call("settings.worktree_hooks.get", { workspace_id: workspaceId })
      .then((result) => {
        if (requestIsCurrent()) setInfo(result as WorktreeHookInfo);
      })
      .catch((err) => {
        if (requestIsCurrent()) setError((err as Error).message);
      })
      .finally(() => {
        if (requestIsCurrent()) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionClient, open, scopeKey, workspaceId]);

  const setEnabled = async (enabled: boolean) => {
    if (!info?.key || !connectionClient.isCurrent()) return;
    const infoKey = info.key;
    const scopeVersion = scopeVersionRef.current;
    const request = ++requestRef.current;
    const requestIsCurrent = () =>
      scopeVersionRef.current === scopeVersion &&
      requestRef.current === request &&
      connectionClient.isCurrent();
    setSaving(true);
    setError("");
    try {
      const result = await store.setRepoWorktreeHooksEnabled(infoKey, enabled);
      if (!requestIsCurrent()) return;
      if (result === undefined) {
        setError(
          store.get().error || t("Unable to update worktree hook settings"),
        );
        return;
      }
      setInfo((current) =>
        current?.key === infoKey ? { ...current, enabled } : current,
      );
    } catch (err) {
      if (requestIsCurrent()) setError((err as Error).message);
    } finally {
      if (requestIsCurrent()) setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      className="worktree-hooks-dialog"
      title={t("Worktree Hooks")}
    >
      <p className="hook-doc-note">
        {withCode(
          t(
            "Hooks are loaded from the current repository's {file} {key} config.",
          ),
          { file: "paseo.json", key: "worktree" },
        )}{" "}
        <a
          href="https://paseo.sh/docs/worktrees"
          target="_blank"
          rel="noreferrer"
        >
          {t("View docs")}
        </a>
      </p>

      {loading ? (
        <div className="hook-loading" role="status">
          <span>{t("Loading worktree hooks...")}</span>
        </div>
      ) : (
        <>
          {error || info?.error ? (
            <p className="modal-error">{error || info?.error}</p>
          ) : null}

          <div className="hook-summary">
            <SummaryRow label={t("Repo")} value={info?.repo_name ?? "-"} />
            <SummaryRow label={t("Store key")} value={info?.key ?? "-"} />
            <SummaryRow label="paseo.json" value={info?.paseo_path ?? "-"} />
            <SummaryRow
              label={t("Checkout")}
              value={info?.checkout_path ?? "-"}
            />
          </div>

          <Checkbox
            className="hook-enabled"
            checked={info?.enabled ?? true}
            disabled={!info?.key}
            onChange={(checked) => {
              if (!saving) void setEnabled(checked);
            }}
          >
            {saving ? t("Saving...") : t("Enable worktree hooks for this repo")}
          </Checkbox>

          <div className="hook-fields">
            {HOOKS.map(([name, label]) => {
              const value = info?.hooks?.[name] ?? "";
              return (
                <section key={name} className="hook-field">
                  <span>{t(label)}</span>
                  <pre className={value ? "" : "is-empty"}>
                    <code>{value || t("Not configured")}</code>
                  </pre>
                </section>
              );
            })}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Fill {name} placeholders in translated text with inline code elements. */
function withCode(text: string, values: Record<string, string>) {
  return text.split(/(\{\w+\})/).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name && name in values ? (
      <code key={index}>{values[name]}</code>
    ) : (
      part
    );
  });
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="hook-summary-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  );
}

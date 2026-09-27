import {
  CircleAlert,
  Pause,
  Pencil,
  Plug,
  Plus,
  Server,
  Star,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { bridge, type ConnectionSummary } from "../api";
import {
  connectionErrorDetail,
  connectionLifecycleLabel,
  connectionProfileCapabilities,
  connectionTypeLabel,
  localConnectionProfilePayload,
  reconnectConnectionProfile,
  selectConnectionProfile,
  sshConnectionProfilePayload,
  suggestConnectionId,
} from "../connectionProfiles";
import { t } from "../i18n";
import { shallowEqual, store, useStoreSelector } from "../store";
import { browserTransportPresentation } from "./browserTransport";
import {
  ConnectionSwitcherTrigger,
  type MenuFocus,
  runtimeStateClass,
} from "./ConnectionSwitcherTrigger";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import { Menu, type MenuEntry } from "./ui/Menu";
import { TextField } from "./ui/TextField";
import { Token } from "./ui/Token";
import "./ConnectionSwitcher.css";

type ProfileDraft = {
  id: string;
  label: string;
  autoConnect: boolean;
};

type LocalDraft = ProfileDraft & {
  controlSocketPath: string;
  clientSocketPath: string;
};

type SshDraft = ProfileDraft & {
  sshDestination: string;
  remoteControlSocketPath: string;
  remoteClientSocketPath: string;
};

type Feedback = { kind: "success" | "error"; message: string } | null;

type Editing = ConnectionSummary | "new-local" | "new-ssh";

function localDraftFor(connection?: ConnectionSummary): LocalDraft {
  return {
    id: connection?.id ?? "",
    label: connection?.label ?? "",
    controlSocketPath: connection?.control_socket_path ?? "",
    clientSocketPath: connection?.client_socket_path ?? "",
    autoConnect: connection?.auto_connect ?? true,
  };
}

function sshDraftFor(connection?: ConnectionSummary): SshDraft {
  return {
    id: connection?.id ?? "",
    label: connection?.label ?? "",
    sshDestination: connection?.ssh_destination ?? "",
    remoteControlSocketPath: connection?.remote_control_socket_path ?? "",
    remoteClientSocketPath: connection?.remote_client_socket_path ?? "",
    autoConnect: connection?.auto_connect ?? true,
  };
}

/** Browser-to-bridge state shared by the switcher menu and the manager. */
function useBrowserTransport() {
  const state = useStoreSelector(
    (snapshot) => ({
      bridgeStatus: snapshot.bridgeStatus,
      connectionPaused: snapshot.connectionPaused,
      status: snapshot.status,
      navigationMode: snapshot.navigationMode,
    }),
    shallowEqual,
  );
  const presentation = browserTransportPresentation(
    state.connectionPaused,
    state.status,
    state.bridgeStatus?.clients,
  );
  const { label, clientCount } = presentation;
  const statusLabel = `${label}${
    typeof clientCount === "number"
      ? ` · ${
          clientCount === 1
            ? t("{count} browser", { count: clientCount })
            : t("{count} browsers", { count: clientCount })
        }`
      : ""
  }`;
  const browserLocal = state.navigationMode === "browser-local";
  return {
    ...presentation,
    statusLabel,
    dotState: state.connectionPaused ? "paused" : state.status,
    navigationLabel: browserLocal
      ? t("Local navigation")
      : t("Shared navigation"),
    navigationHint: browserLocal
      ? t(
          "Workspace, tab and pane selection stays in this browser. Topology and sizes are shared.",
        )
      : t(
          "Legacy navigation follows shared Herdr focus and can move other clients.",
        ),
  };
}

function BrowserTransportStatus() {
  const transport = useBrowserTransport();
  return (
    <div className="connection-browser-status" role="status">
      <span
        className={`connection-browser-dot browser-${transport.dotState}`}
      />
      <span>{transport.statusLabel}</span>
      <span title={transport.navigationHint}>{transport.navigationLabel}</span>
    </div>
  );
}

function FeedbackMessage({
  feedback,
  id,
}: {
  feedback: NonNullable<Feedback>;
  id?: string;
}) {
  return (
    <div
      id={id}
      role={feedback.kind === "error" ? "alert" : "status"}
      aria-live="polite"
      className="connection-feedback"
      data-tone={feedback.kind}
    >
      {feedback.message}
    </div>
  );
}

type FieldSpec<D> = {
  key: Exclude<keyof D & string, "id" | "label" | "autoConnect">;
  label: string;
  placeholder: string;
  maxLength?: number;
};

type ProfileFormSpec<D extends ProfileDraft> = {
  draft: D;
  idKind?: "ssh";
  labelPlaceholder: string;
  idPlaceholder: string;
  fields: FieldSpec<D>[];
  securityNote: string;
};

function localFormSpec(connection?: ConnectionSummary) {
  return {
    draft: localDraftFor(connection),
    labelPlaceholder: t("Local development"),
    idPlaceholder: "local-dev",
    fields: [
      {
        key: "controlSocketPath",
        label: t("Control socket path"),
        placeholder: "/absolute/path/to/herdr.sock",
      },
      {
        key: "clientSocketPath",
        label: t("Render socket path"),
        placeholder: "/absolute/path/to/herdr-client.sock",
      },
    ],
    securityNote: t(
      "Local profiles store socket paths only. SSH commands, credentials, keys, and passphrases are never accepted here.",
    ),
  } satisfies ProfileFormSpec<LocalDraft>;
}

function sshFormSpec(connection?: ConnectionSummary) {
  return {
    draft: sshDraftFor(connection),
    idKind: "ssh",
    labelPlaceholder: t("Remote development"),
    idPlaceholder: "remote-dev",
    fields: [
      {
        key: "sshDestination",
        label: t("OpenSSH destination"),
        placeholder: t("user@dev-box or config-alias"),
        maxLength: 320,
      },
      {
        key: "remoteControlSocketPath",
        label: t("Remote control socket path (optional)"),
        placeholder: t("Auto: ~/.config/herdr/herdr.sock"),
      },
      {
        key: "remoteClientSocketPath",
        label: t("Remote render socket path (optional)"),
        placeholder: t("Auto: ~/.config/herdr/herdr-client.sock"),
      },
    ],
    securityNote: t(
      "Leave the socket paths empty and Thyra infers the default Herdr sockets under the remote home directory at connect time. Authentication comes from the bridge service user's OpenSSH config, ssh-agent, or system Keychain. Establish host trust outside Thyra. Passwords, keys, passphrases, commands, ports, and SSH options are never stored here.",
    ),
  } satisfies ProfileFormSpec<SshDraft>;
}

/** Label, ID, the type's socket/destination fields, and the startup policy. */
function ProfileForm<D extends ProfileDraft>({
  formId,
  spec,
  isEditing,
  pending,
  feedback,
  onSave,
  draftRef,
}: {
  formId: string;
  spec: ProfileFormSpec<D>;
  isEditing: boolean;
  pending: string | null;
  feedback: Feedback;
  onSave: (draft: D) => void;
  /** Lets the dialog footer's Test button read the current draft. */
  draftRef: { current: D | null };
}) {
  const [draft, setDraft] = useState(spec.draft);
  const [idWasEdited, setIdWasEdited] = useState(false);
  const feedbackId = `${formId}-feedback`;
  draftRef.current = draft;
  const update = <K extends keyof D>(key: K, value: D[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <form
      id={formId}
      className="connection-profile-form"
      aria-busy={!!pending}
      aria-describedby={feedback ? feedbackId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <TextField
        label={t("Label")}
        autoFocus
        fullWidth
        value={draft.label}
        maxLength={80}
        placeholder={spec.labelPlaceholder}
        onValueChange={(label) =>
          setDraft((current) => ({
            ...current,
            label,
            id:
              !isEditing && !idWasEdited
                ? suggestConnectionId(label, spec.idKind)
                : current.id,
          }))
        }
      />
      <TextField
        label={t("Connection ID")}
        fullWidth
        value={draft.id}
        disabled={isEditing}
        maxLength={128}
        placeholder={spec.idPlaceholder}
        autoCapitalize="none"
        spellCheck={false}
        onValueChange={(id) => {
          setIdWasEdited(true);
          update("id", id);
        }}
      />
      {spec.fields.map((field) => (
        <TextField
          key={field.key}
          label={field.label}
          fullWidth
          value={String(draft[field.key])}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          autoCapitalize="none"
          spellCheck={false}
          onValueChange={(value) =>
            update(field.key, value as D[typeof field.key])
          }
        />
      ))}
      <Checkbox
        checked={draft.autoConnect}
        onChange={(autoConnect) => update("autoConnect", autoConnect)}
      >
        {t("Connect automatically when Thyra starts")}
      </Checkbox>
      <p className="connection-profile-security-note">{spec.securityNote}</p>
      {feedback ? (
        <FeedbackMessage id={feedbackId} feedback={feedback} />
      ) : null}
    </form>
  );
}

function ConnectionCard({
  connection,
  pending,
  onAction,
  onEdit,
  onRemove,
}: {
  connection: ConnectionSummary;
  pending: string | null;
  onAction: (
    key: string,
    operation: () => Promise<unknown>,
    success: string,
  ) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const capabilities = connectionProfileCapabilities(connection);
  const run =
    (key: string, operation: () => Promise<unknown>, success: string) => () =>
      onAction(`${key}-${connection.id}`, operation, success);
  const method = (name: string, success: string) =>
    run(
      name,
      () => bridge.call(`connections.${name}`, { id: connection.id }),
      success,
    );
  const actions: [shown: boolean | undefined, string, () => void][] = [
    [
      capabilities.canSetDefault,
      t("Set default"),
      method("set_default", t("Default connection changed.")),
    ],
    [
      capabilities.canConnect,
      t("Connect"),
      method("connect", t("Connection started.")),
    ],
    [
      capabilities.canReconnect,
      t("Reconnect"),
      run(
        "reconnect",
        () =>
          reconnectConnectionProfile({
            connectionId: connection.id,
            call: (name, params) => bridge.call(name, params),
          }),
        t("Connection restarted."),
      ),
    ],
    [
      capabilities.canDisconnect,
      t("Disconnect"),
      method("disconnect", t("Herdr connection disconnected.")),
    ],
  ];
  const removeHelpId = `connection-remove-help-${connection.id}`;
  return (
    <section className="connection-manager-card">
      <div className="connection-manager-card-head">
        <span
          className={`connection-runtime-dot ${runtimeStateClass(connection)}`}
        />
        <div>
          <strong>{connection.label}</strong>
          <span>{connectionTypeLabel(connection)}</span>
        </div>
        <div className="connection-profile-badges">
          {connection.is_default ? (
            <Token icon={<Star size={11} aria-hidden="true" />}>
              {t("Default")}
            </Token>
          ) : null}
          {connection.read_only ? <Token>{t("Read-only")}</Token> : null}
          <Token>{connectionLifecycleLabel(connection.state)}</Token>
        </div>
      </div>
      <div className="connection-profile-paths">
        {connection.type === "ssh" ? (
          <>
            <code title={connection.ssh_destination}>
              {t("Destination: {destination}", {
                destination: connection.ssh_destination ?? "",
              })}
            </code>
            <code
              title={
                connection.remote_control_socket_path ||
                t("Inferred under the remote home directory")
              }
            >
              {t("Remote control: {path}", {
                path:
                  connection.remote_control_socket_path ||
                  t("auto (~/.config/herdr/herdr.sock)"),
              })}
            </code>
            <code
              title={
                connection.remote_client_socket_path ||
                t("Inferred under the remote home directory")
              }
            >
              {t("Remote render: {path}", {
                path:
                  connection.remote_client_socket_path ||
                  t("auto (~/.config/herdr/herdr-client.sock)"),
              })}
            </code>
          </>
        ) : (
          <>
            <code title={connection.control_socket_path}>
              {t("Control: {path}", {
                path:
                  connection.control_socket_path ?? t("Legacy configuration"),
              })}
            </code>
            <code title={connection.client_socket_path}>
              {t("Render: {path}", {
                path:
                  connection.client_socket_path ?? t("Legacy configuration"),
              })}
            </code>
          </>
        )}
      </div>
      <div className="connection-profile-policy">
        {connection.auto_connect === undefined
          ? t("Startup policy from legacy configuration")
          : connection.auto_connect
            ? t("Auto-connect enabled")
            : t("Manual connection")}
      </div>
      {connection.error?.message ? (
        <div className="connection-profile-error">
          <CircleAlert size={13} aria-hidden="true" />{" "}
          {connection.error.message}
        </div>
      ) : null}
      <div className="connection-profile-actions">
        <Button
          variant="secondary"
          disabled={!!pending}
          onClick={method("test", t("Connection succeeded."))}
        >
          {pending === `test-${connection.id}` ? t("Testing...") : t("Test")}
        </Button>
        {capabilities.canEdit ? (
          <Button
            variant="secondary"
            disabled={!!pending}
            data-editor={connection.id}
            onClick={onEdit}
          >
            <Pencil size={13} aria-hidden="true" /> {t("Edit")}
          </Button>
        ) : null}
        {actions.map(([shown, label, onClick]) =>
          shown ? (
            <Button
              key={label}
              variant="secondary"
              disabled={!!pending}
              onClick={onClick}
            >
              {label}
            </Button>
          ) : null,
        )}
        {!connection.read_only ? (
          <Button
            variant="danger-soft"
            disabled={!!pending || !capabilities.canRemove}
            aria-describedby={connection.is_default ? removeHelpId : undefined}
            onClick={onRemove}
          >
            {t("Remove")}
          </Button>
        ) : null}
      </div>
      {connection.is_default && !connection.read_only ? (
        <p id={removeHelpId} className="connection-profile-policy">
          {t(
            "To remove this default connection, use Set default on another connection first. If none is available, add a connection first.",
          )}
        </p>
      ) : null}
    </section>
  );
}

function ConnectionManagerDialog({ onClose }: { onClose: () => void }) {
  const connections = useStoreSelector((snapshot) => snapshot.connections);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ConnectionSummary | null>(
    null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const requestToken = useRef(0);
  const mounted = useRef(false);
  // The button that opened the profile form (its data-editor key) gets
  // focus back when the list returns.
  const editOpener = useRef<string | null>(null);
  const draftRef = useRef<LocalDraft | SshDraft | null>(null);
  const formId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestToken.current += 1;
    };
  }, []);

  useEffect(() => {
    if (editing) return;
    const opener = editOpener.current;
    editOpener.current = null;
    if (opener) {
      document
        .querySelector<HTMLElement>(`[data-editor="${CSS.escape(opener)}"]`)
        ?.focus();
    }
  }, [editing]);

  const openEditor = (target: Editing) => {
    editOpener.current = typeof target === "string" ? target : target.id;
    setFeedback(null);
    setEditing(target);
  };
  const closeEditing = useCallback(() => {
    requestToken.current += 1;
    setPending(null);
    setFeedback(null);
    setEditing(null);
  }, []);

  const performAction = async (
    key: string,
    operation: () => Promise<unknown>,
    success: string,
  ) => {
    const token = ++requestToken.current;
    const isCurrent = () => mounted.current && requestToken.current === token;
    setPending(key);
    setFeedback(null);
    try {
      const result = await operation();
      await store.refreshConnections().catch(() => undefined);
      if (!isCurrent()) return undefined;
      const tested = result as { version?: unknown; protocol?: unknown };
      const suffix =
        typeof tested.protocol === "number"
          ? ` ${t("Herdr {version} (protocol {protocol})", {
              version: typeof tested.version === "string" ? tested.version : "",
              protocol: tested.protocol,
            })}`.trimEnd()
          : "";
      setFeedback({ kind: "success", message: `${success}${suffix}` });
      return result;
    } catch (error) {
      await store.refreshConnections().catch(() => undefined);
      if (isCurrent()) {
        setFeedback({ kind: "error", message: connectionErrorDetail(error) });
      }
      return undefined;
    } finally {
      if (isCurrent()) setPending(null);
    }
  };

  const formConnection =
    editing && typeof editing === "object" ? editing : undefined;
  const editingSsh = editing === "new-ssh" || formConnection?.type === "ssh";
  // Validation errors from the payload builders show as form feedback.
  const payloadFor = (draft: LocalDraft | SshDraft) => {
    try {
      return editingSsh
        ? sshConnectionProfilePayload(draft as SshDraft)
        : localConnectionProfilePayload(draft as LocalDraft);
    } catch (error) {
      setFeedback({ kind: "error", message: connectionErrorDetail(error) });
      return null;
    }
  };
  const testDraft = () => {
    const profile = draftRef.current ? payloadFor(draftRef.current) : null;
    if (!profile) return;
    void performAction(
      "test-form",
      () => bridge.call("connections.test", { profile }),
      t("Connection succeeded."),
    );
  };
  const saveDraft = (draft: LocalDraft | SshDraft) => {
    const profile = payloadFor(draft);
    if (!profile) return;
    void performAction(
      "save",
      () =>
        formConnection
          ? bridge.call("connections.update", {
              id: formConnection.id,
              profile,
            })
          : bridge.call("connections.create", { profile }),
      formConnection ? t("Connection updated.") : t("Connection added."),
    ).then((result) => {
      if (result && mounted.current) setEditing(null);
    });
  };

  const isEditing = !!formConnection;
  const title = !editing
    ? t("Manage connections")
    : editingSsh
      ? isEditing
        ? t("Edit SSH connection")
        : t("Add SSH connection")
      : isEditing
        ? t("Edit local connection")
        : t("Add local connection");
  const description = !editing
    ? t("Profiles are shared by authenticated browsers on this bridge.")
    : editingSsh
      ? t("Forward an existing remote Herdr server through OpenSSH.")
      : t("Attach to existing Herdr control and render Unix sockets.");

  const formFooter = (
    <>
      <Button
        size="md"
        variant="secondary"
        disabled={!!pending}
        onClick={testDraft}
      >
        {pending === "test-form" ? t("Testing...") : t("Test connection")}
      </Button>
      <Button
        size="md"
        variant="secondary"
        disabled={!!pending}
        onClick={closeEditing}
      >
        {t("Cancel")}
      </Button>
      <Button
        size="md"
        variant="primary"
        type="submit"
        form={formId}
        disabled={!!pending}
      >
        {pending === "save"
          ? t("Saving...")
          : isEditing
            ? t("Save")
            : t("Add connection")}
      </Button>
    </>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || pending) return;
        // In a profile form, Escape and the header button go back to the list.
        if (editing) closeEditing();
        else onClose();
      }}
      title={title}
      description={description}
      size="lg"
      closeLabel={editing ? t("Back") : undefined}
      dismissable={!pending}
      keyboardDismissable={!pending}
      busy={!!pending}
      className="connection-manager-dialog"
      bodyClassName="ui-dialog-stack"
      footer={editing ? formFooter : undefined}
    >
      {editing ? (
        editingSsh ? (
          <ProfileForm<SshDraft>
            key={formConnection?.id ?? "new-ssh"}
            formId={formId}
            spec={sshFormSpec(formConnection)}
            isEditing={isEditing}
            pending={pending}
            feedback={feedback}
            onSave={saveDraft}
            draftRef={draftRef as { current: SshDraft | null }}
          />
        ) : (
          <ProfileForm<LocalDraft>
            key={formConnection?.id ?? "new-local"}
            formId={formId}
            spec={localFormSpec(formConnection)}
            isEditing={isEditing}
            pending={pending}
            feedback={feedback}
            onSave={saveDraft}
            draftRef={draftRef as { current: LocalDraft | null }}
          />
        )
      ) : (
        <>
          <BrowserTransportStatus />
          <div className="connection-manager-toolbar">
            <Button
              variant="secondary"
              disabled={!!pending}
              data-editor="new-local"
              onClick={() => openEditor("new-local")}
            >
              <Plus size={14} aria-hidden="true" /> {t("Add Local")}
            </Button>
            <Button
              variant="secondary"
              disabled={!!pending}
              data-editor="new-ssh"
              onClick={() => openEditor("new-ssh")}
            >
              <Plus size={14} aria-hidden="true" /> {t("Add SSH")}
            </Button>
          </div>
          {feedback ? <FeedbackMessage feedback={feedback} /> : null}
          <div className="connection-manager-list">
            {connections.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                pending={pending}
                onAction={(key, operation, success) =>
                  void performAction(key, operation, success)
                }
                onEdit={() => openEditor(connection)}
                onRemove={() => setRemoveTarget(connection)}
              />
            ))}
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={t("Remove Connection")}
        message={
          removeTarget
            ? t(
                "Remove connection {name}? This disconnects Thyra but does not stop the Herdr server.",
                { name: `"${removeTarget.label}"` },
              )
            : t("Remove this connection?")
        }
        confirmLabel={t("Remove")}
        tone="danger"
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          void performAction(
            `remove-${target.id}`,
            () => bridge.call("connections.remove", { id: target.id }),
            t("Connection removed."),
          );
        }}
      />
    </Dialog>
  );
}

export type ConnectionSwitcherProps = {
  /** Open on mount with this focus: the lazy shell mounts the menu on its
   *  first open request. */
  defaultOpen?: MenuFocus;
};

export function ConnectionSwitcher({ defaultOpen }: ConnectionSwitcherProps) {
  const state = useStoreSelector(
    (snapshot) => ({
      activeConnectionId: snapshot.activeConnectionId,
      connections: snapshot.connections,
    }),
    shallowEqual,
  );
  const transport = useBrowserTransport();
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectionRequestRef = useRef(0);
  // Opened from the lazy stand-in trigger, which this one replaced: focus
  // the real trigger before opening so the menu returns focus to it.
  useLayoutEffect(() => {
    if (!defaultOpen) return;
    if (document.activeElement === document.body) triggerRef.current?.focus();
    setOpen(true);
  }, [defaultOpen]);
  const closeManager = useCallback(() => {
    setManageOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const selectConnection = (connection: ConnectionSummary) => {
    setOpen(false);
    const selectionRequest = ++selectionRequestRef.current;
    const stillSelected = () =>
      selectionRequestRef.current === selectionRequest &&
      store.get().activeConnectionId === connection.id;
    void selectConnectionProfile({
      connection,
      select: (id) => store.selectConnection(id),
      call: (method, params) => bridge.call(method, params),
      refresh: () => store.refreshConnections(),
    })
      .then(() => {
        if (!stillSelected()) return;
        store.notify({
          kind: "success",
          message: t("Selected {name}", { name: connection.label }),
        });
      })
      .catch((error) => {
        if (!stillSelected()) return;
        store.notify({
          kind: "error",
          message: t("Failed to connect {name}", { name: connection.label }),
          detail: connectionErrorDetail(error),
        });
      });
  };

  const items: MenuEntry[] = [
    {
      id: "browser",
      items: [
        {
          id: "browser-sync",
          label: transport.toggleLabel,
          icon: transport.needsResume ? (
            <Plug size={14} className="connection-resume-icon" />
          ) : (
            <Pause size={14} />
          ),
          onAction: () => {
            if (transport.needsResume) store.resumeConnection();
            else store.pauseConnection();
          },
        },
        ...(transport.pauseOthersLabel
          ? [
              {
                id: "browser-pause-others",
                label: transport.pauseOthersLabel,
                icon: <Users size={14} />,
                onAction: () => void store.pauseOtherClients(),
              },
            ]
          : []),
      ],
    },
    {
      id: "connections",
      selectionMode: "single",
      items: state.connections.map((connection) => ({
        id: `connection:${connection.id}`,
        label: connection.label,
        icon: (
          <span
            className={`connection-runtime-dot ${runtimeStateClass(connection)}`}
          />
        ),
        description: [
          connectionTypeLabel(connection),
          connectionLifecycleLabel(connection.state),
          ...(connection.read_only ? [t("Read-only")] : []),
          ...(connection.is_default ? [t("Default")] : []),
        ].join(" / "),
        checked: connection.id === state.activeConnectionId,
        onAction: () => selectConnection(connection),
      })),
    },
    {
      id: "manage",
      items: [
        {
          id: "manage",
          label: t("Manage connections"),
          icon: <Server size={14} />,
          onAction: () => setManageOpen(true),
        },
      ],
    },
  ];

  return (
    <div className="connection-switcher">
      <Menu
        trigger={<ConnectionSwitcherTrigger ref={triggerRef} active={open} />}
        items={items}
        aria-label={t("Connections")}
        header={{
          title: transport.statusLabel,
          subtitle: transport.navigationLabel,
        }}
        open={open}
        onOpenChange={setOpen}
        defaultFocus={
          defaultOpen === "first" || defaultOpen === "last"
            ? defaultOpen
            : "menu"
        }
      />
      {manageOpen ? <ConnectionManagerDialog onClose={closeManager} /> : null}
    </div>
  );
}

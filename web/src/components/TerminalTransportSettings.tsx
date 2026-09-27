import { useCallback, useEffect, useRef, useState } from "react";
import { Info, Wifi } from "lucide-react";
import { bridge } from "../api";
import { msg, t } from "../i18n";
import { useConnectionClient } from "../useConnectionClient";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Popover } from "./ui/Popover";
import { Switch } from "./ui/Switch";

const TRANSPORT_DESCRIPTION = msg(
  "Reduces Herdr-to-Thyra traffic when the server supports delta and reuse frames. Saved on the Thyra server for this connection and shared by all viewers. Changes briefly reconnect terminal displays; running tasks are not stopped. Older Herdr servers keep their existing transport.",
);

export function TerminalTransportSettings() {
  const client = useConnectionClient();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{
    message: string;
    value?: boolean;
  } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await client.call("settings.terminal_transport.get");
      if (typeof result?.surface_codecs !== "boolean")
        throw new Error(t("Invalid terminal transport settings"));
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(result.surface_codecs);
      setError(null);
    } catch (e) {
      if (
        !mounted.current ||
        !client.isCurrent() ||
        request !== sequence.current
      )
        return;
      setEnabled(null);
      setError({ message: (e as Error).message });
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const off = bridge.onEvent((event) => {
      if (
        event.event === "settings.terminal_transport.updated" &&
        event.connection_id === client.connectionId &&
        client.acceptsServerGeneration(event.connection_generation) &&
        client.isCurrent()
      )
        void load();
    });
    return () => {
      mounted.current = false;
      sequence.current += 1;
      off();
    };
  }, [client, load]);

  const save = async (value: boolean) => {
    if (pending.current || !client.isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    sequence.current += 1;
    try {
      await client.call("settings.terminal_transport.update", {
        surface_codecs: value,
      });
      if (mounted.current && client.isCurrent()) await load();
    } catch (e) {
      if (mounted.current && client.isCurrent())
        setError({ message: (e as Error).message, value });
    } finally {
      pending.current = false;
      if (mounted.current && client.isCurrent()) setSaving(false);
    }
  };

  return (
    <>
      <div className="config-preference-row">
        <span className="config-item-icon">
          <Wifi size={15} />
        </span>
        <div className="config-item-copy">
          <div className="configuration-setting-label">
            <strong>{t("Terminal incremental transport")}</strong>
            <Popover
              aria-label={t("About terminal incremental transport")}
              className="configuration-help-content"
              trigger={
                <IconButton
                  label={t("About terminal incremental transport")}
                  icon={<Info size={14} aria-hidden="true" />}
                  tooltip={false}
                />
              }
            >
              {t(TRANSPORT_DESCRIPTION)}
            </Popover>
          </div>
          <span role="status">
            {saving
              ? t("Saving...")
              : enabled === null
                ? error
                  ? t("Unavailable")
                  : t("Loading...")
                : enabled
                  ? t("Enabled")
                  : t("Disabled")}
          </span>
        </div>
        <Switch
          aria-label={t("Terminal incremental transport")}
          checked={enabled === true}
          disabled={enabled === null || !client.isCurrent()}
          onChange={(checked) => {
            if (enabled !== null) void save(checked);
          }}
        />
      </div>
      {error ? (
        <div className="configuration-error" role="alert">
          <span>{error.message}</span>
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() =>
              void (error.value === undefined ? load() : save(error.value))
            }
          >
            {t("Retry")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

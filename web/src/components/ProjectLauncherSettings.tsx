import { Description, Input, Label, TextField } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useConnectionClient } from "../useConnectionClient";
import { Button } from "./ui/Button";
import "./ProjectLauncher.css";

export type LauncherAgent = {
  id: string;
  label: string;
  command: string;
  default_command: string;
};

/**
 * Agent commands the project launcher types into a new pane. Saved on the
 * Thyra server per connection, so every device launches the same commands.
 */
export function ProjectLauncherSettings({
  agents: initialAgents,
  onSaved,
  heading = false,
}: {
  agents?: LauncherAgent[];
  onSaved?: (agents: LauncherAgent[]) => void;
  /** Title the section when it is embedded in Configuration. */
  heading?: boolean;
}) {
  const client = useConnectionClient();
  const [agents, setAgents] = useState<LauncherAgent[] | null>(
    initialAgents ?? null,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initialAgents ?? []).map((agent) => [agent.id, agent.command]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!initialAgents)
      void client
        .call("launcher.commands.get")
        .then((result: { agents: LauncherAgent[] }) => {
          if (!mounted.current || !client.isCurrent()) return;
          setAgents(result.agents);
          setDrafts(
            Object.fromEntries(
              result.agents.map((agent) => [agent.id, agent.command]),
            ),
          );
        })
        .catch((reason: Error) => {
          if (mounted.current) setError(reason.message);
        });
    return () => {
      mounted.current = false;
    };
  }, [client, initialAgents]);

  const dirty =
    agents?.some((agent) => (drafts[agent.id] ?? "") !== agent.command) ??
    false;

  const save = async () => {
    if (!agents || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result: { agents: LauncherAgent[] } = await client.call(
        "launcher.commands.set",
        {
          commands: Object.fromEntries(
            agents.map((agent) => [agent.id, drafts[agent.id] ?? ""]),
          ),
        },
      );
      if (!mounted.current || !client.isCurrent()) return;
      setAgents(result.agents);
      setDrafts(
        Object.fromEntries(
          result.agents.map((agent) => [agent.id, agent.command]),
        ),
      );
      setStatus(t("Saved"));
      onSaved?.(result.agents);
    } catch (reason) {
      if (mounted.current) setError((reason as Error).message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <form
      className="project-launcher-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {heading ? (
        <h3 className="project-launcher-settings-heading">
          {t("Agent launcher commands")}
        </h3>
      ) : null}
      <p className="project-launcher-settings-intro">
        {t(
          "Commands typed into the new tab. Saved on the Thyra server for this connection and shared by your devices. Leave empty for the default.",
        )}
      </p>
      {agents === null && !error ? (
        <p className="project-launcher-note">{t("Loading...")}</p>
      ) : null}
      {agents?.map((agent) => (
        <TextField
          key={agent.id}
          className="project-launcher-command"
          value={drafts[agent.id] ?? ""}
          onChange={(value) =>
            setDrafts((current) => ({ ...current, [agent.id]: value }))
          }
          isDisabled={saving}
        >
          <Label>{t("{agent} command", { agent: agent.label })}</Label>
          <Input
            placeholder={agent.default_command}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <Description>
            {t("Default: {command}", { command: agent.default_command })}
          </Description>
        </TextField>
      ))}
      {error ? (
        <p className="project-launcher-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="project-launcher-settings-actions">
        <span role="status">{saving ? t("Saving...") : status}</span>
        <Button
          type="submit"
          variant="primary"
          disabled={!agents || !dirty || saving}
        >
          {t("Save")}
        </Button>
      </div>
    </form>
  );
}

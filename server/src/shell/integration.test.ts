import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ShellName } from "../../../shared/shell";
import { readShellRecord, ShellStateTracker, type ShellRecord } from "./state";

for (const shell of ["bash", "zsh"]) {
  test.skipIf(!Bun.which(shell))(
    `${shell} JSON fast path skips the control loop and still escapes controls`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "thyra-json-"));
      try {
        const script = join(import.meta.dir, `integration/thyra.${shell}`);
        const proc = Bun.spawnSync(
          [
            shell,
            ...(shell === "bash" ? ["--noprofile", "--norc"] : ["-d", "-f"]),
            "-ic",
            `
        source '${script}'
        trap - DEBUG
        count=0
        printf() { count=$((count+1)); builtin printf "$@"; }
        __thyra_json 'plain "quoted" text'
        builtin printf '%s\\n%s\\n' "$count" "$REPLY"
        count=0
        __thyra_json $'control\\001\\n\\037'
        builtin printf '%s\\n%s\\n' "$count" "$REPLY"
      `,
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              ZDOTDIR: home,
              HERDR_PANE_ID: "json",
              XDG_RUNTIME_DIR: join(home, "run"),
              XDG_STATE_HOME: join(home, "state"),
            },
          },
        );
        expect(proc.exitCode).toBe(0);
        const lines = proc.stdout.toString().trim().split("\n");
        expect(lines[0]).toBe("0");
        expect(JSON.parse(lines[1])).toBe('plain "quoted" text');
        expect(Number(lines[2])).toBeGreaterThan(0);
        expect(JSON.parse(lines[3])).toBe("control\u0001\n\u001f");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
}

for (const [shell, debug] of [
  ["bash", false],
  ["bash", true],
  ["zsh", false],
  ["fish", false],
] as [ShellName, boolean][]) {
  test.skipIf(!Bun.which(shell))(
    `${shell}${debug ? " with DEBUG and array PROMPT_COMMAND" : ""} interactive hooks preserve status, last argument and hook chains`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), `thyra-hook-${shell}-`));
      const dir = join(home, "run/thyra/shell");
      await mkdir(dir, { recursive: true });
      const cwd = join(home, 'cwd "quoted" \\ \u2603\n');
      await mkdir(cwd);
      const stateFile = join(dir, "test_pane.json");
      const script = join(import.meta.dir, `integration/thyra.${shell}`);
      let output = "";
      const proc = Bun.spawn(
        shell === "bash"
          ? [shell, "--noprofile", "--norc", "-i"]
          : shell === "zsh"
            ? [shell, "-d", "-f", "-i"]
            : [shell, "--no-config", "-i"],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            ZDOTDIR: home,
            HERDR_PANE_ID: "test:pane",
            XDG_RUNTIME_DIR: join(home, "run"),
            XDG_STATE_HOME: join(home, "state"),
            HISTFILE: join(home, "history"),
            TERM: "xterm-256color",
            // The test PTY answers no terminal queries; fish 4 would stall.
            fish_features: "no-query-term",
          },
          terminal: {
            cols: 160,
            rows: 24,
            data(_terminal, bytes) {
              output += Buffer.from(bytes).toString();
            },
          },
        },
      );
      const waitState = (predicate: (value: ShellRecord) => boolean) =>
        new Promise<ShellRecord>((resolve, reject) => {
          let done = false;
          const watcher = watch(dir, () => {
            void check();
          });
          // fs.watch may coalesce atomic renames; mirror the service's fallback.
          const rescan = setInterval(() => {
            void check();
          }, 50);
          const timer = setTimeout(async () => {
            finish();
            reject(
              new Error(
                `state timeout (${shell}): ${await readFile(stateFile, "utf8").catch(String)}\n${output}`,
              ),
            );
          }, 5000);
          const finish = () => {
            done = true;
            watcher.close();
            clearTimeout(timer);
            clearInterval(rescan);
          };
          async function check() {
            const value = await readShellRecord(stateFile);
            if (!done && value && predicate(value)) {
              finish();
              resolve(value);
            }
          }
          void check();
        });
      const send = (line: string) => {
        proc.terminal!.write(line + "\n");
      };
      try {
        if (shell === "bash" && debug)
          send(
            `shopt -s extdebug; trap 'true' DEBUG; PROMPT_COMMAND=('printf "CHAIN:%s\\n" "$?"'); HISTCONTROL=ignorespace; PS1='PROMPT>'; source '${script}'; source '${script}'`,
          );
        else if (shell === "bash")
          send(
            `PROMPT_COMMAND='printf "CHAIN:%s\\n" "$?"'; PS1='PROMPT>'; source '${script}'; source '${script}'`,
          );
        else if (shell === "zsh")
          send(
            `precmd() { print -r -- "CHAIN:$?"; }; PS1='PROMPT>'; HISTSIZE=100; source '${script}'; source '${script}'`,
          );
        // --no-config sets fish_history to "", which disables history.
        else
          send(
            `set -g fish_history thyra_test; source '${script}'; source '${script}'`,
          );
        let initial = await waitState((state) => state.state === "prompt");
        expect(initial.cwd).toBe(cwd);
        send(" echo thyra-private-leading-space");
        initial = await waitState(
          (state) => state.state === "prompt" && state.seq > initial.seq,
        );
        send(
          shell === "fish"
            ? "read __thyra_test_reply; false"
            : "read -r __thyra_test_reply; false",
        );
        const running = await waitState((state) => state.state === "running");
        expect(running.seq).toBe(initial.seq);
        send("reply");
        const prompt = await waitState(
          (state) => state.state === "prompt" && state.seq > initial.seq,
        );
        expect(prompt.exit).toBe(1);
        if (shell !== "fish") {
          send('printf "STATUS:%s\\n" "$?"');
          await waitState(
            (state) => state.state === "prompt" && state.seq > prompt.seq,
          );
          expect(output).toContain("STATUS:1");
          send("false sentinel");
          const last = await waitState(
            (state) => state.state === "prompt" && state.exit === 1,
          );
          send('printf "LAST:%s STATUS:%s\\n" "$_" "$?"');
          await waitState(
            (state) => state.state === "prompt" && state.seq > last.seq,
          );
          expect(output).toContain("LAST:sentinel STATUS:1");
          expect(output).toContain("CHAIN:1");
        }
        const spool = await readFile(
          join(home, "state/thyra/shell-history.jsonl"),
          "utf8",
        );
        expect(spool).toContain('"exit":1');
        expect(spool).not.toContain("thyra-private-leading-space");
        for (const line of spool.trim().split("\n"))
          expect(() => JSON.parse(line)).not.toThrow();
        if (shell !== "fish") {
          const beforeAlias = await readShellRecord(stateFile);
          send("alias __thyra_alias='printf ALIAS-OK'");
          const ready = await waitState(
            (state) => state.state === "prompt" && state.seq > beforeAlias!.seq,
          );
          const tracker = new ShellStateTracker({
            dir,
            call: async (method, params) => {
              if (method === "pane.process_info")
                return {
                  process_info: {
                    shell_pid: proc.pid,
                    foreground_process_group_id: proc.pid,
                  },
                };
              if (method === "pane.send_input") {
                // Mirror Herdr: wrap text for a bracketed-paste PTY, then keys.
                const text = String(params.text ?? "");
                const keys = (params.keys ?? []) as string[];
                proc.terminal!.write(
                  (text ? `\x1b[200~${text}\x1b[201~` : "") +
                    keys.map((key) => (key === "Enter" ? "\r" : "")).join(""),
                );
                return {};
              }
              throw new Error("unexpected method");
            },
          });
          expect(
            await tracker.submit({
              pane_id: "test:pane",
              seq: ready.seq,
              text: "__thyra_alias",
              execute: true,
            }),
          ).toEqual({ ok: true });
          await waitState(
            (state) => state.state === "prompt" && state.seq > ready.seq,
          );
          expect(output).toContain("ALIAS-OK");
          expect((await tracker.refresh("test:pane")).available).toBe(true);
          await tracker.stop();
        }
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
        proc.terminal!.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20000,
  );
}

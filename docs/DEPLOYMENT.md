# Installation and Deployment

Configuration reference for Thyra. For a guided workflow and private remote
access, use the [tutorial](./TUTORIAL.md#networking).

## Requirements

- A running Herdr server, or [managed local setup](#managed-herdr-setup).
- Default Unix sockets: `~/.config/herdr/herdr.sock` and
  `~/.config/herdr/herdr-client.sock`; Windows uses corresponding named pipes
  under `%APPDATA%\herdr\`.
- [Bun](https://bun.sh) 1.4.1+ for source builds only; standalone needs no Bun/Node.js.

### Herdr compatibility

This source build supports verified legacy protocols 14–20 (Herdr 0.7.0–0.8.2)
and **tagged Herdr 0.9.0 / protocol 22**. Protocol 21 and unknown versions are
rejected at control/binary probes. Use a compatible Thyra build or separate
server; **do not downgrade a live server**. Published binaries follow their
[release notes](https://github.com/Yubo-Cao/thyra/releases).
The [plugin](#herdr-plugin) separately requires Herdr 0.7.2+.

Herdr 0.9.0 uses stable endpoint generation 1, distinct from protocol 22.
`THYRA_DISABLE_ENDPOINT=1` explicitly selects legacy direct-terminal fallback.

| Area | Behavior / limitation |
| --- | --- |
| Attachment | Endpoints crop the server-rendered tab per pane. Unknown codecs/generations or missing required `pane.focus` fail without silent fallback. Legacy fallback uses takeover and may disconnect another owner. |
| Optional methods | Creation/history controls require advertised methods; unavailable controls explain why. Input, mouse, paste, resize, and rendering can work without optional history. |
| Navigation | Endpoint workspace/tab selection is browser-local across reconnects, not reload/runtime replacement. Same-tab pane focus, topology, and terminal sizes remain shared; size follows Herdr's last-interacting client. Legacy uses shared navigation. |
| Creation | Requires a connected source terminal, except first-workspace bootstrap. Preserves `terminal.new_cwd` (`follow`, `home`, `current`, fixed path); explicit cwd wins. Shared pane focus means `follow` is not browser-isolated. |
| Input | Pixel mouse and enhanced Kitty keyboard / modifyOtherKeys parity are unsupported; legacy keyboard-mode messages are decoded but not applied in-browser. |

**OSC 52 clipboard writes:** only the browser with input in the last 30 seconds
matching the receiving endpoint session receives them, never passive viewers.
Input counts whether typed into the terminal or sent through pane RPCs
(composer, paste, keys) for a pane that browser is viewing.
Herdr supplies no producing-pane/input identity: a delayed write from A after B
becomes foreground can reach B's recent input owner. This is not source-PTY or
original-browser isolation. Detach/replacement/disposal invalidates ownership.
Reads are disabled; permission failures show copy-retry UI. Ordinary copy/paste
is unchanged. OSC 52 is unavailable on the **0.9.0 legacy fallback**; older
servers retain their existing relay.

Closing one workspace never implicitly closes its linked group. If Herdr requires
that, inspect all linked workspaces before explicitly running:

```bash
herdr --session <name> workspace close <workspace_id> --group
```

See [endpoint contracts](./ARCHITECTURE.md#terminal-endpoints) and
[creation/timeouts](./ARCHITECTURE.md#browser-navigation-and-creation).

## Install a release

Releases provide Linux/macOS/Windows x86-64 and ARM64 assets.
Unpublished versions require a [source build](#build-a-standalone-executable).

On Linux/macOS, the checksum-verifying installer writes `~/.local/bin/thyra`:

```bash
curl -fsSL \
  https://github.com/Yubo-Cao/thyra/releases/latest/download/install-thyra.sh \
  | sh
```

Add `~/.local/bin` to PATH, run `thyra --version`, then `thyra` and open the
printed URL. Rerun the installer to update.

On Windows, download matching `thyra-windows-<arch>.tar.xz` and `.sha256`
files from the [latest release](https://github.com/Yubo-Cao/thyra/releases/latest),
verify with `Get-FileHash`, extract with Windows 11's `tar.exe`, and run `thyra.exe`.

Installer overrides apply to the `sh` command above:

| Setting | Example / behavior |
| --- | --- |
| Pin a version | `THYRA_VERSION=X.Y.Z sh` (no `v`; empty means latest) |
| System directory | `sudo env THYRA_INSTALL_DIR=/usr/local/bin sh` (empty rejected) |
| Release mirror | `THYRA_RELEASE_BASE_URL` selects a compatible flat asset directory |

Mirrors require HTTPS except loopback testing; URLs cannot contain credentials,
queries, or fragments. Installer and in-app updater preserve the old executable
as `thyra.previous` for manual recovery.

## Managed Herdr setup

```bash
thyra herdr setup
thyra herdr status
```

If absent, setup downloads **Herdr 0.9.0**, verifies build-pinned SHA-256 hashes,
and installs to `~/.local/bin/herdr` on Unix or
`%APPDATA%\thyra\herdr\0.9.0` on Windows. It never replaces a binary it did not
install. If already installed, it uses the first binary on PATH or in those
locations, leaving it in place. Unix's standard location supports `herdr update`;
Windows uses Thyra's private versioned directory, not the official junctioned
store, and needs a newer verified Thyra install for replacement.

Setup installs/starts `herdr server` as a user service: `thyra-herdr.service`
(Linux), `dev.thyra.herdr` (macOS), or a per-user Windows scheduled task.
Definitions carry a Thyra marker; unrelated existing definitions are untouched.
The web UI offers the same confirmed **Set up Herdr / Start Herdr** action when
the default local server is unreachable, with visible failures/retry.

Only default local configuration is supported. SSH profiles/`--ssh-host`, named
sessions, and explicit control/render socket flags or environment variables are
refused; start Herdr yourself for those configurations.

To stop and disable, use native tools:

```bash
systemctl --user disable --now thyra-herdr.service  # Linux
launchctl bootout gui/$(id -u)/dev.thyra.herdr      # macOS
# Windows: find dev.thyra.herdr-<key> in herdr-task.ps1
schtasks /End /TN "<task-name>"
schtasks /Delete /TN "<task-name>" /F
```

Then remove only its generated definition:
`~/.config/systemd/user/thyra-herdr.service`,
`~/Library/LaunchAgents/dev.thyra.herdr.plist`, or
`%APPDATA%\thyra\herdr-task.ps1`. Linux also needs
`systemctl --user daemon-reload`. Remove an installed binary only if unwanted
and owned by this setup; never delete the shared `~/.local/bin` directory.

## Herdr plugin

Requires Herdr 0.7.2+ and Bun for the shim. The plugin ID is `thyra`.
Thyra never edits Herdr's plugin registry.

For an **unreleased checkout**, build before linking (existing binaries are not
validated). Keep the checkout and rebuild after updates:

```bash
git clone https://github.com/Yubo-Cao/thyra.git
cd thyra
bun scripts/thyra-plugin.ts build-source
herdr plugin link .
```

`build-source` installs workspace dependencies and builds `server/thyra`
(`thyra.exe` on Windows). Linking after success skips release download;
neither step starts the service.

For a **published release**, replace `X.Y.Z` with its version:

```bash
herdr plugin install Yubo-Cao/thyra --ref vX.Y.Z
```

The manifest downloads/checksum-verifies that version's binary. Failure never
falls back to compilation; unpublished versions cannot use this path.

Plugin actions manage the same [user service](#run-as-a-user-service):

```bash
herdr plugin action invoke thyra.start      # install/start
herdr plugin action invoke thyra.url        # login URL
herdr plugin action invoke thyra.status
herdr plugin action invoke thyra.restart
herdr plugin action invoke thyra.uninstall  # remove service, retain data
```

Actions are asynchronous. Inspect `herdr plugin log list --plugin thyra` or
open `herdr plugin pane open --plugin thyra --entrypoint panel` for status,
URL, version, and start/restart/uninstall controls. Default is a session-modal
popup; `--placement split`, `tab`, `zoomed`, or `overlay` creates a regular pane
visible to other Herdr clients.

## Basic runtime configuration

Flags override environment variables, then defaults; `thyra --help` lists all
options. Standalone ignores cwd `.env`/`bunfig.toml`: export variables, pass flags,
or edit the service environment file. Source `bun run` retains normal Bun loading.

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--host <addr>` | `HOST` | `127.0.0.1` |
| `--port <n>` | `PORT` | `8787` |
| `--password <pw>` | `THYRA_PASSWORD` | Generated token for non-loopback |
| `--tls-cert <path>` | `THYRA_TLS_CERT` | Disabled; PEM chain, requires key |
| `--tls-key <path>` | `THYRA_TLS_KEY` | Disabled; PEM key, requires certificate |
| `--socket-path <path>` | `HERDR_SOCKET_PATH` | Default control socket/pipe |
| `--client-socket-path <path>` | `HERDR_CLIENT_SOCKET_PATH` | Default render socket/pipe |
| `--ssh-host <user@host>` | `HERDR_SSH_HOST` | Disabled; Linux/macOS only |
| `--session <name>` | `HERDR_SESSION` | Default session |
| `--public-dir <path>` | `PUBLIC_DIR` | Embedded assets |
| `--log-level <level>` | `THYRA_LOG_LEVEL` | `info` |
| `--open` | `OPEN_BROWSER=1` | Disabled |

| Additional environment variable | Purpose |
| --- | --- |
| `THYRA_UPDATE_BASE_URL` | Latest-release mirror directory |
| `THYRA_DISABLE_UPDATE_CHECK=1` | Disable update checks |
| `THYRA_RESTART_SUPERVISOR=0\|1` | Override external supervisor detection |
| `THYRA_DISABLE_ENDPOINT=1` | Legacy terminal fallback; see compatibility |

Update mirrors need platform archives, `.sha256` files, and
`thyra-<platform>.update.json` with `name: "thyra"`. Missing or invalid manifests
fail closed without archive discovery. HTTPS is required except loopback tests;
credentials, queries, and fragments in URLs are rejected.

```bash
thyra                              # local, no login
thyra --host 0.0.0.0 --port 8787     # generated token
```

For a fixed password, prefer `THYRA_PASSWORD` over process-visible
`--password`. Read [Security](../SECURITY.md) before non-loopback use.

### Native HTTPS

Supply both a PEM chain (leaf first) and matching unencrypted private key:

```bash
thyra --host 0.0.0.0 --port 8443 \
  --tls-cert /path/to/cert-chain.pem \
  --tls-key /path/to/private-key.pem
```

Missing/unreadable/malformed/mismatched files stop startup, never fall back to
HTTP. Without TLS settings, HTTP is used. HTTPS adds `Secure` cookies and HTTPS
startup links, but **does not change authentication**: loopback bypasses login;
non-loopback requires a token/password. Do not expose directly to the public internet.

For private LAN testing, use your issuer or [mkcert](https://github.com/FiloSottile/mkcert).
Replace this reserved example IP with the host's actual LAN address:

```bash
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem localhost 127.0.0.1 ::1 192.0.2.10
thyra --host 0.0.0.0 --port 8443 \
  --tls-cert "$PWD/cert.pem" --tls-key "$PWD/key.pem"
```

- SANs must match each client hostname/IP; `localhost` does not cover LAN addresses.
- Every device must trust the issuer. Transfer only mkcert's `rootCA.pem` from
  `mkcert -CAROOT`, **never `rootCA-key.pem`**. On iOS, install the CA profile and
  enable full trust in Settings > General > About > Certificate Trust Settings.
- Bypassing warnings does not enable Service Workers/secure APIs. Verify trusted
  HTTPS before Home Screen installation; remove temporary CA profiles after tests.
- Protect keys and keep them out of Git. Issuance/renewal is external; restart
  after replacement. Services need absolute paths in their environment file.

## Web Push notifications

1. Use trusted HTTPS; on iOS/iPadOS 16.4+, open the installed Home Screen app.
2. Enable **Task notifications**, grant permission, and choose **Agent needs input**
   and/or **Task completed**. **Background push** confirms enrollment; existing
   local-only users should toggle off/on once.

Server push is enabled by default; every device still needs enrollment.
`THYRA_WEB_PUSH_SUBJECT` optionally sets a `mailto:`/HTTPS operator contact,
not a delivery destination. Default: `https://github.com/Yubo-Cao/thyra/issues`.
An explicitly empty value disables push; restart after changes. Removing the
variable restores the default and enables delivery.

Private VAPID keys/subscriptions live in `~/.config/thyra/web-push.json` or
`%APPDATA%\thyra\web-push.json`; override with `THYRA_WEB_PUSH_PATH`.
**Protect/back up this file, never share/commit it, and use one writer per file.**
Corrupt data is preserved and push disabled rather than silently rotating keys.
After intentional key replacement, reopen/toggle notifications to re-enroll.
Browser profiles/subscriptions are device-specific.

Delivery needs outbound HTTPS to Apple (`*.push.apple.com`), Google
(`fcm.googleapis.com`), Mozilla (`*.push.services.mozilla.com`), or Windows
(`*.notify.windows.com`); other providers are rejected. No public inbound endpoint
is needed. Devices must reach their provider and Thyra when opening an alert.

The bridge and relevant Herdr runtimes must stay connected. It observes
`working -> blocked` and `working -> done/idle` without open browsers; startup
snapshots are silent. Delivery is best-effort: OS/Focus settings, outages, expired
subscriptions, or stopped runtimes can prevent it. Messages expire after five
minutes, with no durable replay; HTTP 404/410 removes expired subscriptions.

Turning notifications off revokes on the server before browser unsubscribe.
If revocation fails, reconnect/retry or revoke OS/browser permission immediately;
already-accepted messages may arrive. Server-wide disable retains the registry
for reuse when re-enabled. Password changes do not revoke device subscriptions.

**Active page only** is the fallback when push is unavailable; do not rely on it
while suspended/closed. Encrypted payloads contain agent names/routing IDs, not
terminal output, and may appear on lock screens.

## Voice input

The microphone in each pane header (the floating microphone on touch devices) types dictation into the terminal, and the composer's microphone dictates into its draft.
The bridge transcribes each speech segment with the first configured provider and falls back to the next configured one when a provider fails, so a cloud outage or exhausted quota degrades to local recognition instead of failing.
With no provider, the button reports that voice input is unavailable.
Keys stay in the service environment (`~/.config/thyra/thyra.env`) and never reach the browser.

| Variable | Provider |
| --- | --- |
| `ELEVENLABS_API_KEY` with optional `THYRA_VOICE_ELEVENLABS_MODEL` (default `scribe_v2`) | ElevenLabs Scribe |
| `THYRA_VOICE_API_KEY` with optional `THYRA_VOICE_BASE_URL` (default OpenAI) and `THYRA_VOICE_MODEL` (default `gpt-transcribe`) | Any OpenAI-compatible `/audio/transcriptions` endpoint |
| `THYRA_VOICE_FUNASR_MODEL_DIR`, optional `THYRA_VOICE_FUNASR_CLI` | Local Fun-ASR-Nano through `llama-funasr-cli` |
| `THYRA_VOICE_COMMAND` | A local command as a JSON argv array containing `{input}` (the WAV path); stdout is the transcript |

The chain order is command, ElevenLabs, OpenAI-compatible, Fun-ASR.
`THYRA_VOICE_PROVIDER` (`elevenlabs`, `openai`, `funasr`, `command`, or `off`) moves one provider to the front, and `THYRA_VOICE_FALLBACK=off` uses only the first.
`THYRA_VOICE_LANGUAGE` pins the language; by default providers detect it, and `gpt-transcribe` receives the `THYRA_VOICE_LANGUAGES` hint (default `zh,en`).
`THYRA_VOICE_ELEVENLABS_ZERO_RETENTION=on` sends `enable_logging=false`, which ElevenLabs honors only for enterprise accounts.

### Personal dictionary

`THYRA_VOICE_DICTIONARY` names a YAML file in Aoide's format, so both can share `~/.config/aoide/dictionary.yaml`:

```yaml
terms:
  - Claude Code
  - { term: Codex, aliases: [code x] }
```

`term` is the canonical spelling and `aliases` are confirmed misrecognitions that are always replaced with it.
Terms become the OpenAI transcription prompt and cleanup hints; `THYRA_VOICE_DICTIONARY_KEYTERMS=on` also sends them to ElevenLabs as keyterms.
Edits apply to the next request; an invalid edit keeps the last valid version.
The file is limited to 64 KiB, 200 terms, and 20 aliases per term.
Browsers allow microphone capture only on HTTPS or localhost origins, so a phone needs the tailnet or native HTTPS address.

### Dictation cleanup

When the microphone stops, the whole dictation is rewritten once by a language model and replaces the raw text, unless the user edited that text in the meantime.
OpenAI (`api.openai.com`) is called through the Responses API; any other base URL through Chat Completions, which OpenAI-compatible providers such as DeepSeek implement.
**Configuration > Behavior > Voice cleanup** picks the mode per browser: Off, Tidy (default; Aoide's cleanup prompt: removes fillers and false starts, tightens phrasing, and uses Markdown lists only for real enumerations), Clean (fillers and punctuation only), Typeset (adds light Markdown), or Polish (rewrites into prose).
If a rewrite loses too much text, English words, numbers, or a dictionary term, the recognized text is used instead.

| Variable | Meaning |
| --- | --- |
| `THYRA_VOICE_LLM_API_KEY`, else `OPENAI_API_KEY` | Enables cleanup |
| `THYRA_VOICE_LLM_BASE_URL` | API base URL (default `https://api.openai.com/v1`; for DeepSeek, `https://api.deepseek.com`) |
| `THYRA_VOICE_LLM_API` | `responses` or `chat`, overriding the choice made from the base URL |
| `THYRA_VOICE_LLM_MODEL` | Model (default `gpt-5.6-luna`) |
| `THYRA_VOICE_LLM_REASONING_EFFORT` | Optional reasoning effort; without it, DeepSeek's thinking mode is turned off |
| `THYRA_VOICE_LLM=off` | Disables cleanup |

Responses API requests set `store: false`.

## Logging

Logs use one line per event: timestamp, severity, scope, bounded key/value context.
`info` covers lifecycle/failures, not routine RPC/events/frames/successful auto-sync.
Use `thyra --log-level debug` or `THYRA_LOG_LEVEL=debug` temporarily;
restart services after editing their environment. Debug can expose paths/IDs;
return to `info` afterwards. Logs omit URL auth tokens, which remain in protected files.

## Multiple and remote Herdr connections

The title's selector adds/tests/connects/disconnects/edits/removes shared profiles;
each browser selects independently. Local profiles attach to sockets, not start
Herdr. The first saved profile retains the default as writable `Local`.

![Connection selector with local and SSH profiles](./screenshots/multi-connection-selector.png)

Use Enter/Space/Up/Down to open; arrows/Home/End navigate. There is no global
next/previous-connection shortcut.

SSH requires an already-running remote Herdr and accepts an OpenSSH alias or
`user@host`. Leave socket paths empty to resolve remote home defaults. Put ports,
jump hosts, keys, and other options in `~/.ssh/config`; Thyra stores no SSH
passwords/keys/passphrases/options. Verify host keys and noninteractive service-user
authentication first. SSH forwarding requires a Linux/macOS bridge; Windows only
supports native local profiles because forwarded Unix sockets are not named pipes.

Profiles live atomically in `~/.config/thyra/connections.json` or Windows
`%APPDATA%\thyra\connections.json` (`THYRA_CONNECTIONS_PATH` overrides).
Unix directory/file modes are `0700`/`0600`; registry/direct-parent symlinks are
rejected. Version 1 migrates on first successful mutation. Invalid files remain
intact with mutations disabled; repair before retry. Failed durable rollback
retires routing and blocks edits rather than letting memory/disk disagree.

`auto_connect` controls startup, not browser selection. Disconnect/removal stops
only the runtime/tunnel, never Herdr/workspaces. SSH retries transient failures,
not auth/host-key/permanent protocol errors. There is no idle cleanup or aggregate
resource budget; disconnect unused profiles.

Explicit CLI/environment connection settings create a read-only `legacy-default`
profile. Change those settings to edit it. Old browser preferences migrate once
into the first real profile without overwriting values.

```bash
thyra --ssh-host user@host
```

CLI SSH forwards both sockets; file, image-paste, Git, and hooks run remotely.
Explicit socket flags/environment variables override automatic tunnel paths.
See [isolation](./ARCHITECTURE.md#connection-isolation) and
[SSH lifecycle](./ARCHITECTURE.md#ssh-transport).

## Project launcher

The [project launcher](../FEATURES.md#project-launcher) stores its state in the Thyra `settings.json` (`~/.config/thyra/settings.json`, or `%APPDATA%\thyra\settings.json` on Windows) under `launcher.<connection profile ID>`:

```json
{
  "launcher": {
    "local": {
      "pinned": ["/home/me/code/thyra"],
      "commands": { "claude": "c", "codex": "x" },
      "history": [{ "path": "/home/me/code/thyra", "count": 3, "last_used_at": 1790000000000 }]
    }
  }
}
```

`commands` overrides the defaults `claude` and `codex`; each command is one line of at most 256 characters, typed into the new pane's shell on the connection's host, so it can be an alias or a script on that host's `PATH`.
Edit it from the launcher's settings button or **Configuration > Connection** rather than by hand while Thyra runs.
Pinned paths must be existing directories when added; `history` keeps the 60 most recent launch folders.
Recent folders also use `zoxide query --list --score` when `zoxide` is on the bridge user's `PATH` (local) or the SSH login shell's `PATH` (remote).

## Worktree hooks

Configure [Paseo hooks](https://paseo.sh/docs/worktrees) in `paseo.json`:

```json
{
  "worktree": {
    "setup": "bun install",
    "opened": "./scripts/worktree-opened.sh",
    "teardown": "./scripts/worktree-teardown.sh",
    "removed": "./scripts/worktree-removed.sh"
  }
}
```

| Hook | Timing / working directory |
| --- | --- |
| `setup` | After create/open; new worktree |
| `opened` | After opening an existing worktree; opened worktree |
| `teardown` | Before removal; target worktree |
| `removed` | After removal; source checkout |

For the first three, the target's config wins; only an absent file falls back to
the source. `removed` normally uses source config because the target is gone.
Commands run through `sh -c`, remotely for SSH connections.

| Variable | Value |
| --- | --- |
| `PASEO_HOOK` | Hook name |
| `PASEO_CHECKOUT_PATH` | Target path, including former path after removal |
| `PASEO_SOURCE_CHECKOUT_PATH` | Source checkout when known |
| `THYRA_HOOK_EVENT` | `worktree.created`, `worktree.opened`, `worktree.before_remove`, or `worktree.removed` |
| `THYRA_HOOK_CHECKOUT_PATH` | Same target path |
| `THYRA_HOOK_SOURCE_CHECKOUT_PATH` | Same source path |

Notices show bounded diagnostics.
**Failed teardown stops removal; other failures do not roll back completed actions.**
Hooks default on; inspect/disable per repository under **Worktree hooks** or
**Worktree Lifecycle**. They are trusted, unsandboxed code: review before acting.

## Run as a user service

| Command | Behavior |
| --- | --- |
| `thyra service install` | Create/update definition and start |
| `thyra service install --force` | Replace a non-Thyra definition |
| `thyra service status` | Native manager status |
| `thyra service restart` | Restart after environment changes |
| `thyra service reload` | Reload definition, then restart |
| `thyra service uninstall` | Stop/remove service; retain configuration/tokens |

| Platform | Definition / behavior |
| --- | --- |
| Linux | `~/.config/systemd/user/thyra.service`, `Restart=always` |
| macOS | `~/Library/LaunchAgents/dev.thyra.plist`, label `dev.thyra`, `KeepAlive`; logs `~/Library/Logs/thyra.stdout.log` / `thyra.stderr.log` |
| Windows | Task `dev.thyra-<user-key>` (config-path hash), `%APPDATA%\thyra\thyra-task.ps1`; login start, normal privileges, restart on failure |

**New services bind `0.0.0.0:8787`**, generate a persistent token, and print
localhost/LAN token URLs. Config lives in `~/.config/thyra/thyra.env` or
`%APPDATA%\thyra\thyra.env`, preserved on reinstall/uninstall. Edit HOST,
PORT, password, and Herdr settings there, then restart. For local-only installation,
set `HOST=127.0.0.1` first. On Windows, allow Private networks only if prompted;
on Linux, `sudo loginctl enable-linger "$USER"` keeps services after logout.

```bash
curl -fsS http://127.0.0.1:8787/healthz
```

Tokens live in `~/.config/thyra/auth-token` or `%APPDATA%\thyra\auth-token`.
A `?token=...` visit sets an HttpOnly cookie and removes the URL token. To rotate,
stop the service, replace the file with a fresh 64-character lowercase hexadecimal
secret (mode `0600`), then restart.

Manual templates live under `deploy/`. Keep systemd as restart owner for wrappers:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/service-wrapper -- %h/.local/bin/thyra --host 0.0.0.0
```

The updater saves `thyra.previous`, atomically installs a verified binary, and
exits; it never starts its replacement. Reinstall preserves custom `ExecStart`
in a managed unit when it still invokes the same binary.

## Replace a systemd Herdr server without restarting panes

Do not use `systemctl --user restart herdr.service` to deploy the Herdr core.
Herdr agents and their pane processes live in the server service's cgroup, so a
normal systemd restart stops that entire cgroup. Session restore can relaunch
supported agents afterward, but that is a cold restart rather than process
continuity.

The forked Herdr core supports a live handoff: the old server transfers its
session snapshot, collaboration leases, terminal PTY file descriptors, and
runtime ownership to a replacement process. The systemd drop-in at
`deploy/systemd/herdr-live-handoff.conf` sets `ExitType=cgroup`, allowing the
original main PID to exit while the replacement and pane processes remain in
the service cgroup. It also sets `Delegate=yes` so Herdr can create one cgroup
v2 memory leaf per detected Claude/Codex process tree, and
`OOMPolicy=continue` so an agent reaching `memory.max` does not stop the whole
workspace service. The drop-in overrides `ExecStart` so reboots and intentional
cold starts use `~/.local/bin/herdr`, even when a distro-owned stock binary is
installed under `/usr/bin`. This requires systemd 250 or newer.

During the first live deployment, Herdr moves the existing service-root PIDs
into an unbounded control leaf before enabling the memory controller. This is a
cgroup membership change only: pane PTYs and processes keep running, after
which detected Claude/Codex trees move into their own limited leaves. Future
live handoffs preserve those leaf names and limits. If delegation or cgroup v2
is unavailable, Herdr falls back to its RSS watchdog instead. Configure limits
in `~/.config/herdr/config.toml`; reload applies changes to running agents:

```toml
[resources]
claude_memory_limit_bytes = 4294967296
codex_memory_limit_bytes = 4294967296
```

Use `0` to disable one agent's limit. Linux cgroup enforcement is a hard
physical-memory boundary and allows at most the same amount of swap per agent;
macOS uses a 300 ms process-tree RSS watchdog.

Build versioned candidates on the build machine:

```bash
build_id=$(date -u +%Y%m%dT%H%M%SZ)
cd /path/to/herdr
# Keep the stock release identity so stock clients of the same version reuse
# the forked remote binary instead of offering a destructive remote update.
HERDR_BUILD_CHANNEL=stable HERDR_BUILD_ID="$build_id" cargo build --release

cd /path/to/thyra
bun run build:linux-x64
```

Build Herdr on the target's distribution (or an older glibc) because the Rust
binary links the build host's glibc; the Thyra binary needs only glibc 2.17.
Copy `target/release/herdr`, `server/thyra-linux-x64`, this repository's
`scripts/deploy-herdr-stack-live.sh`, and the `deploy/systemd/` directory to the
target. Run the deployment script on that target host:

```bash
./scripts/deploy-herdr-stack-live.sh \
  --herdr ./artifacts/herdr \
  --thyra ./artifacts/thyra-linux-x64 \
  --stock-version 0.9.1 \
  --build-id "$build_id"
```

The script refuses a stopped or non-`Type=simple` Herdr unit, verifies that the
candidate advertises the requested stock-client version and contains the
collaboration API, installs a versioned release, applies the systemd drop-in,
performs the live handoff, and verifies all pre-existing non-server PIDs remain
in the cgroup. Only after that does it atomically update
`~/.local/bin/herdr` and `~/.local/bin/thyra`. If Thyra was active, the
script restarts it; if it was inactive, the new binary is installed without
starting the service. Herdr itself is never restarted. Previous binaries are
retained as `.previous` files.

After the first installation, this is the process-preserving server operation:

```bash
systemctl --user reload herdr.service
```

Reserve `stop` and `restart` for an intentional cold shutdown. Test candidate
handoffs against a disposable named Herdr session before promoting them to a
machine that hosts active agents.

## Build a standalone executable

```bash
bun scripts/thyra-plugin.ts build-source
# Output: server/thyra (server/thyra.exe on Windows)
```

This installs dependencies and embeds frontend/Bun. Afterward, `bun run build`
rebuilds; targets need no Bun. Cross-build/package with `bun run build:<target>`
or `bun run package:<target>`:

| Targets | Architectures |
| --- | --- |
| `linux-x64`, `linux-arm64` | Linux x86-64 / ARM64 |
| `darwin-x64`, `darwin-arm64` | macOS Intel / Apple Silicon |
| `windows-x64`, `windows-arm64` | Windows x86-64 / ARM64 |

`bun run build:all` builds all targets. Bun downloads runtimes automatically.
Use glibc Linux x64 for Ubuntu/Debian/Fedora/CentOS; musl is unsupported there
because Bun's musl binary still dynamically links `libstdc++`/`libgcc_s`.
Run `./server/thyra`; `bun run clean` removes generated builds.
Release packaging/publishing follows [AGENTS.md](../AGENTS.md#release-notes).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Cannot connect to Herdr | Check server and both socket paths; default local setup can use `thyra herdr setup`. Override with `--socket-path /path/to/herdr.sock` only deliberately. |
| Another device cannot open the page | Check bind, token URL, network/firewall, and [private access setup](./TUTORIAL.md#networking). |
| SSH connects locally | Remove explicit socket flags/`HERDR_SOCKET_PATH`/`HERDR_CLIENT_SOCKET_PATH`; they override tunnel paths. |
| Want automatic browser launch | Use `thyra --open` or `OPEN_BROWSER=1`. |
| Slow first load behind a reverse proxy | Pass Thyra's `Content-Encoding`, `ETag`, and `Cache-Control` through unchanged; Thyra already sends quality-11 Brotli. Repeat loads are served from the browser's service-worker cache only on trusted HTTPS or `localhost`; see [web delivery](./ARCHITECTURE.md#web-delivery-and-caching). |
| A page still shows the previous version after an update | Reload once: on a very slow link the cached app shell answers first and the new one is used on the next load. Clearing the site's data resets the cache. |

For step-by-step diagnosis, see [the tutorial](./TUTORIAL.md#troubleshooting).

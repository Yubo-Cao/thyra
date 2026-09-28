# Architecture

Thyra's system contracts. See [Features](../FEATURES.md) for UI behavior,
[Deployment](./DEPLOYMENT.md) for configuration, and [Security](../SECURITY.md)
for the trust model.

## System overview

```text
Browser (React + Vite)
   | same-origin HTTP / WebSocket
   v
Bridge (Bun + TypeScript) -- node:net --> Herdr sockets
```

Browsers cannot open Unix sockets or Windows named pipes. The bridge connects
`herdr.sock` (NDJSON control) and `herdr-client.sock` (binary terminal traffic),
serves the frontend, and owns authentication, local/SSH runtimes, host operations,
notifications, health, and updates. React owns presentation and browser-local
preferences; xterm displays Herdr-rendered output, not a bridge-owned PTY.

Browser RPC sends `{ id, method, params }` and receives `{ id, result }` or
`{ id, error }`. Subscribed events use `{ event: ... }`; downstream traffic also
carries connection identity. Subscription acknowledgements trigger snapshots;
events during refresh queue another refresh. This reconciles missed changes,
not an atomic or replayable event log.

## Connection isolation

A bridge-global `ConnectionManager` owns shared profiles and independent
`ConnectionRuntime` instances. Each runtime owns its transport, viewers,
subscriptions, clipboard relay, services, caches, and reconnect lifecycle.
Render streams open only while viewed. Disconnect/removal stops the runtime and
SSH tunnel, not Herdr or its workspaces.

- Downstream RPC/HTTP requires an immutable connection ID, runtime generation,
  and request-local ready-runtime lease. Replies, events, frames, and clipboard
  pushes carry that identity; HTTP streams recheck it per chunk.
- Replacement retires leases before publishing status. Already-dispatched effects
  may finish on the original host, but retired results cannot publish. Explicit
  malformed, unknown, stale, or unready identities fail without fallback.
  Omitted identities and legacy HTTP aliases are a bounded, logged compatibility
  path for older single-connection clients only.
- Authentication, health, updates, client accounting, and profile management are
  bridge-global and independent of downstream readiness. Global RPC rejects
  misleading connection fields. Starts/stops serialize; shutdown is bounded;
  one failed runtime does not block healthy connections or management.
- Browser caches, storage, mount keys, notifications, and async actions are
  connection-scoped. Switching connections retires the browser lease; same-ID
  runtime replacement clears active and inactive sessions before IDs can recur.
  Inspector RPC results (diff summaries, file previews) are TanStack Query
  entries keyed by connection and client generation; a new lease drops every
  other scope and aborts its requests, and previews stay within 16 MiB.

## Terminal endpoints

### Negotiation and transport

Backend selection uses a verified protocol allowlist, not browser inference.
[Compatibility](./DEPLOYMENT.md#herdr-compatibility) defines supported versions,
legacy fallback, and clipboard limitations.

Herdr 0.9.0 endpoints require generation 1 and exact codecs
`shell.snapshot.v1`, `shell.surface.v1`, `shell.input.semantic.v1`, and
`shell.blob.v1`. Unknown generations/codecs fail closed. Attachment waits for the
initial snapshot; each viewer crops its pane from the shared tab surface.

Capabilities belong to **each terminal socket**, are renegotiated on reattach,
and are checked again at dispatch:

| Capability | Contract |
| --- | --- |
| `pane.focus` | Required for attachment; absence fails without legacy takeover. |
| `pane.scroll` | Gates explicit history scrolling, not semantic page keys. |
| `tab.create`, `workspace.create` | Gate creation on the existing source endpoint. |
| `health_check` | Enables ping/pong; input and resize are core codec operations. |
| `surface_interest`, `presentation_effects_fence` | Do not authorize surface-setting or fencing controls. |

Endpoint hellos opt into `surface_delta` and `surface_reuse` by default, unless
disabled; each requires a matching welcome capability. Full surfaces, legacy patches,
Base64-bincode deltas, and JSON reuse controls share a connection-local baseline
before cropping. Legacy patches update named panes and replace the cursor
(including `null`); delta/reuse replaces pane, cursor, hyperlink, and scroll
metadata. Geometry changes require a full surface.

Decoders bound collections and validate boot/projection/surface revisions, spans,
and hyperlink indices. Invalid updates close the stream and clear its baseline;
viewers reattach for a fresh full frame rather than keep stale output. A
connection-wide endpoint observer follows the focused Space to report popup
identity even without pane viewers; the popup terminal uses direct attach.
Kitty graphics are not presented.

A Herdr restart or live handoff keeps pane ids but gives every pane a new terminal id, and drops every endpoint stream.
When a stream closes under live viewers, the bridge looks its pane up in `pane.list` (retrying for about 8 seconds while Herdr is unreachable) and sends `terminal_closed` with `reason: "terminal_replaced"`, `pane_id` and `replacement_terminal_id`, or `reason: "terminal_gone"`; a takeover or dropped socket keeps the plain reason and the browser re-attaches the same id.
The browser moves the pane to its new terminal at once, attaches it and refreshes its snapshot, and never re-attaches a replaced id.
An attach that the endpoint refuses as an unknown terminal is resolved the same way, and for 10 minutes an attach of a retired id is answered from memory without opening an endpoint.
When the event subscription recovers, the bridge re-resolves every terminal a viewer holds, forgets cached protocol and authorization locations, and browsers refresh.

`settings.terminal_transport.get/update` persists `surface_codecs` per connection
in `settings.json`. Changes close that runtime's endpoint displays and broadcast
`settings.terminal_transport.updated`; viewers reattach with fresh baselines.
Queued attachments reread settings. Configuration closes do not consume takeover
retries; tasks, legacy sessions, and other runtimes are unaffected. This is a
shared preference, not an authorization boundary.

These codecs reduce **Herdr-to-bridge** traffic. On the bridge-to-browser leg,
a viewer that attaches with `frame_delta: true` receives endpoint repaints as
row updates (`shared/terminalFrame.ts`, `server/src/bridge/terminal-frame-stream.ts`).
Each frame carries `frame_seq`. A full frame sends every styled row in `rows`
plus the cursor `tail`. A row update names its `base_seq` and sends only
`changed` rows, plus `tail` when the cursor changed. Frames identical to the
last one sent to that viewer are not sent. The browser acknowledges each frame
with `terminal.frame_ack { terminal_id, seq }`. At most four frames or 16 KiB
are unacknowledged per viewer and terminal; newer frames replace the pending
one, so a slow link skips to the newest screen instead of queueing repaints.
A missing base makes the browser send `terminal.frame_ack { resync: true }` and
the bridge answers with a full frame. Attach and resize also restart from a
full frame, and a 10 s acknowledgement timeout releases the window. Viewers
that do not opt in, popups, and legacy streams keep base64 `bytes` repaints.
A viewer may thin only its own stream: `min_frame_interval_ms` (0–10000, on `terminal.attach` or `terminal.stream`) sends at most the newest frame per interval, and `terminal.stream { paused: true }` sends none until it is resumed with a full frame.
Full repaints (attach, resize, resync) are never held back, and other viewers of the same terminal keep their rate.
The browser writes only changed rows into xterm while its viewport is unchanged.

The browser reports its terminal colors with `terminal.host_theme`
(`appearance`, `foreground`, `background`, 16-color `palette`). Every endpoint
client of that connection forwards them as Herdr `ClientShellHostTheme`
updates (default colors, palette, then appearance), including right after each
welcome, so a Thyra client promoted to foreground never resets panes to an
empty host theme. A light/dark change also blurs and refocuses the focused pane
once so apps that re-probe colors on focus pick it up.

Messages of at least 128 bytes use negotiated WebSocket compression with
per-connection context for WebKit compatibility, so repeated rows and poll
replies compress against earlier messages. Clipboard payloads stay
uncompressed. Inbound decompression is shared with client context takeover
disabled; backpressure and generation checks still apply.

### Geometry, input, and selection

`terminal.attach` supplies pane `cols`/`rows` and optionally tab
`surface_cols`/`surface_rows` (both integers in 1..65535). Tab dimensions include
pane borders, not app chrome; surface feedback corrects stale hints. Legacy
attachments use pane dimensions. Repaints clip wide characters and cursors to
the viewer's viewport; browsers reject oversized frames after shrinking.

Root CSS zoom scales the UI. Terminals cancel it and scale xterm fonts directly,
keeping cell measurements, IME, selection, and mouse input in viewport CSS pixels.
Popover positioning likewise cancels zoom and reapplies it to content.

The first output renders with xterm's DOM renderer in a fallback font; the WebGL renderer and the bundled font load after it (`terminalRenderer.ts`).
Neither may change `cols`/`rows`, which would reflow a full-screen app: cell widths snap to device pixels as the WebGL renderer's do, the fit uses that grid whichever renderer is active, and the bundled font's cell size is fixed before it downloads (its nominal metrics, or the size this browser measured on an earlier load).

Input waits for readiness and revalidates attachment/session/runtime leases;
it is never replayed into a replacement terminal. Disconnect rejects pending
requests and invalidates clipboard ownership.

- Full PageUp/PageDown sends semantic input for Herdr to route by PTY mode;
  explicit half-page history uses `pane.scroll`, even in mouse-aware apps.
  Legacy attachments retain PageKey/Wheel routing.
- Wheel and touch scrolls (`source: "wheel"`) reach a mouse-reporting app as wheel input.
  Over a full-screen app without mouse reporting (the surface's `alternate_screen_active`, e.g. `less`, `man`), Herdr builds advertising the `alternate_scroll` endpoint capability get the wheel too, at most 8 lines per request, and turn it into that many Up/Down cursor keys in the app's cursor key mode, as terminals do in alternate scroll mode.
  Herdr alone decides keys versus scrollback from the app's DECSET 1007 and its `[terminal] alternate_scroll` setting (default on); without the capability, or on the normal screen, the wheel scrolls Herdr's history with `pane.scroll`.
  Only the pane's writer sends wheel input: the bridge turns anyone else's scroll into history.
- Herdr keeps one history position per pane, shared by every viewer, so a read-only viewer (workspace viewer or share-link guest) never sends `terminal.scroll` (the bridge refuses it).
  Its first scroll up reads the last 1000 lines with `terminal.history` (`pane.read`, `recent`, ANSI: Herdr's passive snapshot, never input) into a second, input-less xterm over the live one, at the live terminal's size, font and colors.
  Scrolling back to the bottom, Escape, End, or **Back to live** closes it; the live stream never stops.
- Mouse cells are zero-based and pane-local. Only an in-pane press owns a drag;
  subsequent positions clamp to edges. Reporting changes/closure cancel ownership.
- History scrolling coalesces wheel intent while awaiting RPC and viewport
  feedback, without blocking other commands. No-op replies need no repaint.
  Completed movement is not rebased by history growth; external viewport changes
  become authoritative when no newer intent is queued. Input, missing metrics or
  panes, and closure cancel queued movement.
- Browser selection holds the latest repaint until cleared. Session changes
  retire pending presentation; replay never sends input. Edge-drag, or a wheel
  over an existing selection, promotes it to absolute history rows and reads one
  overlapping viewport at a time, retaining immutable cells for the complete
  copied range. New output may change the content revision; each new viewport
  must reproduce the captured rows it overlaps (the live bottom page excepted),
  otherwise history shifted and further requests stop with captured text kept.
  Release, blur, lost mouse-up, resize, or reset stops edge scrolling; after
  release, wheel scrolling keeps the range and Shift-click extends it.
- Finished selections are copied inside the releasing gesture (mouseup,
  touchend, handle pointerup) because WebKit rejects clipboard writes outside
  user activation. A drag handed to a mouse-aware app reserves a
  `ClipboardItem` write at mouseup that its later OSC 52 copy fulfills.

### Links

Local detection scans soft-wrapped text with cell coordinates. File detection
also considers bounded, indented continuations because endpoint cell repaints
lack soft-wrap metadata; inferred paths must resolve within the pane's workspace.
Blank lines separate contexts. Local URL detection never guesses missing tails.

Endpoint repaints carry an opaque `link_frame` identity, stable across identical,
cursor-only, and focus-only surfaces. Content, hyperlink, viewport/scroll, input,
or resize changes invalidate it. Identical repaints do not rewrite xterm, keeping
native link IDs and in-progress clicks intact.

`terminal.link.resolve` verifies attachment ownership and frame identity. OSC 8
uses the cropped frame's hyperlink table; optional plain-text resolution runs on
that exact socket with its content revision and scroll offset. Coordinates are
zero-based **cropped-pane display cells**, never surface origins or CSS pixels.
Hover probes are bounded and independently timed out; hover never activates.

Herdr 0.9.1's `pane.link.resolve` returns inclusive visible regions, not URLs.
Thyra reconstructs complete HTTP(S) targets, including wrapped/wide cells,
but rejects ambiguous viewport-clipped URLs. It never calls `pane.link.activate`,
which can invoke host plugin handlers. OSC 8 retains explicit destinations even
for partial labels. Local `file://` targets require decoded absolute host paths
and empty/`localhost` authorities; network hosts, UNC paths, credentials,
queries/fragments, malformed encoding, and control characters are rejected.
Other URI schemes are not opened.

Async lookups recheck frame, buffer, geometry, navigation, and connection state,
even while selection freezes presentation. Once clicked, a file menu survives
ordinary output but closes on connection/workspace/navigation changes. Web links
open in the browser; files use the pane's workspace, not later global focus.

Touch long-press resolves the original touched cell, with at most one upstream
probe, then requires an explicit **Open link** or **File actions** gesture.
Selection edits, cancellation, multitouch, scrolling, frame changes, resize, and
reconnect retire lookups. Unsafe explicit OSC 8 targets and failed endpoint touch
reads never fall back to URL-looking labels. Legacy touch supports plain-text
URLs/paths only, without explicit OSC 8 cell metadata.

## Browser navigation and creation

`browserNavigation.ts` projects endpoint browser-local selections into shared UI
fields. Snapshots supply topology, not subsequent navigation; stale layouts and
results cannot overwrite newer selections. Legacy navigation, topology changes,
terminal dimensions, and native same-tab pane focus remain shared.

Active selection/clicks send `terminal.focus` through the attached `pane.focus`
endpoint. Focus restores after split attachment, not on routine frames/snapshots.
Requests serialize per browser across endpoint lanes; superseded selections are
discarded and ownership/leases rechecked. Same-tab cursor ownership remains shared.

Creation uses explicit context and `focus: false`; returned IDs are adopted only
while the initiating selection and lease remain current. The bridge validates
and strips Thyra-only `browser_source`, then uses the existing endpoint's
serialized focus/scroll lane without another endpoint or focus call. Omitting
synthetic cwd preserves Herdr's `terminal.new_cwd`; explicit cwd wins. Shared
same-tab focus still controls the `follow` source.

Missing source attachments fail. Only first-workspace bootstrap uses control
creation, serializing an empty-topology check per runtime. Competing requests
retry when topology becomes nonempty. A 20-second admission deadline covers
readiness, validation, and queuing: expired undispatched mutations never execute;
dispatched timeouts report uncertain completion, requiring inspection before retry.

The project launcher's `launcher.launch { path, agent }` is the one other control-API creation.
It always passes an explicit cwd, so no source terminal or `terminal.new_cwd` policy is involved, and it uses `focus: false` under browser-local navigation (the initiating browser then selects the returned pane).
The bridge accepts only a known agent ID, expands `~` with the runtime host's home, and checks that the path is a directory on that host before creating anything.
It adds a tab to the workspace whose checkout (or, failing that, most panes) is that folder, or creates a workspace there, waits up to three seconds for the shell to draw output, then sends the server-configured command with `pane.send_input` and Enter.
A failed send is returned as `start_error` next to the created tab rather than hiding it.

## Workspace resource ownership

A **checkout** owns Files/Changes; a workspace supplies routing, a tab a return
location, and a pane optional path/session context. Repository groups are not
merged working trees. Changes and Last step snapshots do not prove agent ownership.

Git resource keys pair endpoint-qualified `worktree.gui_settings_key` with the
normalized checkout path, scoped by connection. Blank keys fall back to the
trimmed repository key, which cannot distinguish endpoints; enriched identities
do not inherit fallback state. Persistent keys exclude runtime generations.
Non-Git resources use workspace identity.

Shared-checkout workspaces may share caches, but requests retain workspace/runtime
leases and resource revisions. Refresh/removal retires old prefetches. Tab/pane
IDs never own caches. Legacy repository-wide Inspector state is retained but not
automatically migrated because it lacks checkout identity.

Actions capture the originating workspace. A vanished workspace can rebind only
to the same checkout; missing paths never fall back to siblings. Agent cwd is
used only inside the checkout. Removal clears only that checkout's state; closing
one workspace retains resources another workspace still uses. Terminals stay
mounted across Inspector changes; layout preferences and content caches are separate.

## Filesystem browsing

Workspace scope is checkout-relative and lexically confined: `..` escapes are
rejected, while explicit symlinks inside the checkout may be followed. Each
filesystem request explicitly sends `scope: "filesystem"` with an absolute host
path or `~`/`~/...`; the bridge expands `~` with the runtime host's home (the
bridge user locally, the remote shell's `$HOME` over SSH, cached per host), and
replies confirm scope and return absolute paths. The mode is view-local, not a
persisted permission: each explorer remembers its mode and directory in memory
for the page session only, and retired responses cannot replace a new view.
Search filters loaded entries only.

`file.list`, `file.read`, download, upload, delete, and `file.mkdir` accept both
scopes. Upload targets an explicit directory; delete and `file.mkdir` target an
entry inside an existing parent. `file.mkdir` takes `kind: "directory" | "file"`,
creates one empty entry, and fails when the name exists. Deleting the checkout
root, a filesystem root, or the host home directory itself is refused.

Absolute previews use `scope=filesystem` download URLs; relative Markdown links
and images resolve beside their source. Explorer caches are separate from lazy
UI code. Mermaid previews share a lazy
renderer, strip wrappers/metadata only for detection, and retain original source.
Images are inert elements; SVG is never inserted into the app DOM, and direct
SVG responses carry a sandbox CSP blocking scripts and external resources.

HTML previews use a separate empty-sandbox iframe and an enforcing response CSP,
including on direct navigation. The server embeds workspace CSS, images and fonts
as data URLs; Bun's CSS bundler resolves imports and asset URLs. Relative paths
resolve beside their document or stylesheet; root-relative paths resolve within
its workspace. Realpath checks reject resources outside that workspace. HTTPS
stylesheets and their CSS imports are loaded directly by the browser, not fetched
by the bridge; protocol-relative stylesheet URLs use HTTPS. Stylesheet links use
`no-referrer`, and document-supplied referrer metadata is removed. CDN requests
expose the viewer's IP address and are not covered by workspace read limits.
Scripts, forms, embedded documents, external images/fonts and HTTP stylesheets
are blocked. Missing or unsupported workspace resources are omitted. Ordinary
downloads retain original bytes.

HTML and each workspace stylesheet are limited to 512 KiB, each workspace
image/font to 5 MiB, and a preview to 64 resource paths and 10 MiB of resource
bytes. Resource-bearing style processing is limited to 256 blocks/attributes,
with a 20 MiB embedding/output budget. Local and SSH readers check size and read
at most the limit plus one byte to detect growth; oversized previews return
HTTP 413. HTML requests have a 120-second HTTP idle timeout for preparation over
SSH. The source view and downloads remain available.
These limits do not bound decoded image memory or browser rendering cost. User
links and deliberate copy/drag into other controls remain untrusted user actions.

## File editing

`file.write` saves UTF-8 editor content: `{ workspace_id, path, content,
expected_mtime_ms?, force?, scope? }` returns `{ path, size, mtime_ms, created }`.
Workspace scope takes checkout-relative paths with the same lexical confinement
as other file operations; `scope: "filesystem"` takes an absolute host path.
Writes replace an existing regular file (resolving symlinks to their target) or
create one in an existing directory, never a directory. Content lands in a
sibling temporary file that keeps the original mode and is renamed into place.
`expected_mtime_ms` must match the current modification time unless `force` is
set; a mismatch fails with "file changed on disk". SSH runs the check, temporary
write, and rename in one remote script with one-second mtime resolution, matching
previews. Bodies are limited to 5 MiB. Clean drafts follow reloads; saves
invalidate the preview cache and refresh rendered previews.

The Monaco editor is a lazy chunk with Monarch grammars and only the base editor
worker; language-service workers are excluded and nothing loads from a CDN.

## Agent activity

`agent.list` adds optional `last_activity_at` from session-file mtime without
parsing transcripts. Checks have bounded concurrency and a 1.5-second budget;
missing metadata never removes agents. Remote IDs needing local directory search
stay unresolved. Idle ordering uses mtime, then Herdr state-change sequence,
without browser activity history. [History synchronization](./HISTORY.md) owns
projection, caching, and incremental transcript contracts.

## Agent integrations

`integration.list` keeps Herdr's targets and installation states authoritative.
Missing versions are supplemented by read-only `herdr integration status` on the
selected host: locally for local connections, or through that connection's SSH
account. The CLI binary version must match the running server's `ping` version;
per-agent state and any existing version fields must agree before merging.
The bridge/SSH account must use the same agent configuration environment as Herdr.
RPC metadata is never overwritten, and a `current` state alone does not imply an
available version. CLI commands have five-second timeouts; missing binaries,
failed SSH commands, malformed output, and version mismatches leave missing
metadata unknown without failing the list. There is no remote-to-local fallback.

## MCP

`server/src/mcp` exposes a read-only [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP at `/mcp` and over stdio through `thyra mcp`; setup is in [Deployment](./DEPLOYMENT.md#mcp-server).
It uses the official `@modelcontextprotocol/server` SDK in stateless mode, so every HTTP request is served by a fresh server instance, 2025-era and 2026-07-28 clients both work, and no session state is kept.
The stdio subcommand serves the same tool definitions locally and forwards each `tools/call` to a running Thyra's `/mcp`, so authentication, scope, redaction, rate limiting, and audit always happen in the server.

Tools: `list_workspaces`, `get_pane_output`, `list_agent_sessions`, `get_agent_session`, `search_sessions`, `get_git_status`, `get_git_diff`, `read_file`, `list_files`, and `get_activity`.
They reach Herdr and the workspace only through `gateway.ts`, which maps each tool need to one fixed read operation with an explicit parameter set (for example, file reads never carry `scope: "filesystem"`).
`assertMcpReadOperation` gates every call: the operation must be in the MCP read list and classified `read`, deferring to the RPC policy table's class for methods it lists.
No tool can send input, resize, focus, claim panes, run commands, or write files.
Pane output uses Herdr `pane.read` in ANSI format (then strips ANSI) because a plain-text read of an alternate-screen app may replay wheel input to harvest history.

Authentication uses dedicated bearer tokens (`thyra mcp token create`), never the login cookie; `mcp-tokens.json` in the data directory stores only SHA-256 digests and is reread when it changes, so revocation needs no restart.
A token's scope is `all` or a list of workspace ids; an unqualified id names a workspace on the default connection, and `connection/w1` names one elsewhere.
Out-of-scope workspaces and panes are reported as not found and are never read.
`/mcp` passes the same Host allowlist as other routes and the Origin check in `read` mode: agents may omit `Origin`, but a present browser Origin must be allowed (and must match the request host), because the endpoint trusts only the bearer header, never ambient cookies.
Each token has a token-bucket rate limit, and repeated failed authentication is limited per client address.

Every tool result passes through `redact.ts` (provider keys, bearer and basic credentials, JWTs, private key blocks, URL passwords, and secret-named `KEY=value` or JSON fields) and is capped at 100,000 characters; tools also page and cap their own output.
`read_file`, `list_files`, and `get_git_diff` apply a deny-list (`.env*`, `*.pem`, `*.key`, `id_*`, credential and keystore files, `.ssh`, `.aws`, `.git`, and others) to the requested path and, on local connections, to the symlink-resolved path; paths that resolve outside the checkout are refused, and remote connections refuse symlinked path components.
`mcp-audit.jsonl` records each call's time, token, transport, tool, summarized redacted arguments, outcome, duration, and size, keeping one rotated generation.

## Voice input

The AudioContext is created and resumed synchronously in the tap handler, before any `await`, because iOS Safari only starts audio during a user gesture; an interrupted context (calls, app switches) resumes when the page is visible again.
Capture requests the browser's WebRTC audio processing (noise suppression, echo cancellation, automatic gain control).
The AudioContext runs at the device rate, because browsers resample a 48 kHz microphone into a 16 kHz context without adequate filtering and recognition accuracy suffers; the AudioWorklet applies a windowed-sinc low-pass filter, downsamples to 16 kHz, and runs voice activity detection.
Detection uses the WebRTC VAD (libfvad from the pinned `@echogarden/fvad-wasm` build, mode 3) on 20 ms frames together with an adaptive energy threshold: a frame is voiced only when both agree, because energy alone accepts typing and broadband noise and the WebRTC VAD alone accepts quiet steady noise.
Worklets cannot fetch, so the main thread passes the 20 KiB WASM as bytes and the worklet compiles it synchronously; if that fails, detection falls back to energy alone.
A segment commits after 500 ms of trailing silence, needs 320 ms of voiced audio, is forced out at 12 s, and is dropped unless it lasts 650 ms and reaches RMS 0.006 or peak 0.025; the speech threshold adapts to the background level between utterances.
Segments are posted in order as canonical 16 kHz mono PCM16 WAV to bridge-global `POST /api/voice/transcribe`, which validates the header, bounds size (300 s) and concurrency, and tries each configured provider in order until one succeeds.
Segment transcripts are a live preview. On stop, when a session produced more than one segment, its speech-only audio (segments joined by 250 ms of silence, up to 300 s) is recognized again as one request, and that transcript replaces the preview, because recognizers lose context at segment boundaries; if the pass fails, the segment transcripts stand.
The personal dictionary (Aoide's `dictionary.yaml` format) is re-read when its file changes; its terms go to OpenAI as the transcription prompt, optionally to ElevenLabs as keyterms, and to cleanup as hints, and confirmed aliases are replaced in every transcript and cleanup result.

Pane voice typing follows Aoide's speak-then-commit flow: transcripts collect in a preview, and stopping cleans the whole dictation once through `POST /api/voice/cleanup` and sends it with `pane.send_input` like a composer Insert (Send adds Enter).
The active pane also listens for the `voice.pushToTalk` shortcut in the window capture phase, ahead of the terminal: a press held at least 350 ms is push-to-talk and its release inserts, a shorter tap starts dictation that the next press inserts, and while dictating Enter sends and Escape discards.
The key press is the gesture that unlocks audio, and a release that arrives while the microphone is still opening stops it as soon as it is ready.
If the send fails, the text is kept in that pane's composer draft.
In the composer, transcripts are inserted at the caret, and the composer records the contiguous range one session wrote.
On stop, the cleanup result replaces that range only if the draft still holds the raw dictation at the recorded offset, so edits made while tidying are never overwritten.

Cleanup keeps the recognized text instead of the model's rewrite when the rewrite keeps under 45% of the word characters (for inputs of at least 25), under half of the English words (for at least five), changes the digits (ignoring added list markers), or drops a dictionary term that was spoken; the bridge logs which check fired.
The capture code loads on first use; unmounting the pane or closing the composer releases the microphone.

## Task notifications

Each runtime tracks agent transitions through per-pane subscriptions and periodic
reconciliation, even without browsers. Initial state is silent; snapshots cannot
overwrite newer events. Transitions emit once; disposal stops observation and
queued sends recheck the owning lease.

Web Push persists private VAPID keys and device subscriptions. Authenticated
same-origin HTTP manages enrollment/revocation; encrypted sends use a provider
allowlist, ten-second deadline, four concurrent requests, and a bounded
256-delivery memory queue. Failures/overflow are logged, not durably replayed.
The Service Worker checks connection generation when routing clicks; enrolled
pages suppress duplicate local notifications. See [delivery limits](./DEPLOYMENT.md#web-push-notifications).

## Browser collaboration and terminal ownership

Each browser page receives an ephemeral participant ID, which keeps tabs, windows, and separate browser sessions distinct for pane claims while allowing one participant session to hold claims on several panes.
The bridge assigns it: a page opens `/ws?client_session=<random per page load>`, and the bridge derives `web-<keyed hash of the device cookie and that nonce>` and returns it as `participant_id` in the hello.
Reconnects of the same page keep the id (and its claims); other browsers cannot reproduce it.
The bridge replaces `participant_id` and `role` (`editor`) in every `collaboration.*` call, so a page can update, claim, release, or leave only as itself; claiming needs the editor role on the pane's workspace ([single writer](#trust-boundary)).
Presence reports include the active workspace, tab, and pane.
Who a participant is (person and device) is decided by the bridge, not the page; see [collaborator identity](#collaborator-identity).

Browsers group presence by person and list each person's devices ("Yubo · iphone, liveopt"); every tab or browser context of one device collapses into that device.
Sidebar pane rows and the phone tab sheet show one avatar per person looking at the pane (this page excluded, hidden pages ignored, real Herdr TUI clients included) and mark the holder of the pane's layout claim with an accent ring and keyboard badge.
These are derived in the browser from the presence snapshot, which the bridge already forwards at most once per second, so they add no traffic.

Focus changes skip that throttle: when a page's workspace, tab, pane, visibility, or follow target changes, the bridge sends a `collaboration.focus` event with only those ids at once, and browsers patch their latest snapshot.
The bridge also keeps what Herdr's API does not carry: `following` (the presence key a page follows, stripped before the call reaches Herdr) and `active_at_unix_ms` (last focus change, typing, or return to the page), and overlays both, with the latest forwarded focus, on every snapshot it sends, so a throttled snapshot never moves anyone back.
A person's focus is that of their visible page with the latest `active_at_unix_ms`; the collaboration popover shows it ("Viewing: workspace › tab › pane") with Jump and Follow.
Following moves this page to that focus whenever it changes and ends when the user navigates (any `store` focus action outside `navigateProgrammatically`), presses Escape, switches connection, or the person has had no live page for three seconds.
A closed socket leaves its participants at once instead of waiting for the 45-second lease, unless the page already reconnected on another socket.

Pane claims are exclusive per pane, not per Herdr session. The bridge shares one
render stream for a terminal among all watching browsers. One writer at a time:
`Take control` claims the pane with a 15-second takeover protection, typing into
an unclaimed pane claims it, and the bridge refuses input, resizing and focus
from anyone else ([single writer](#trust-boundary)). Non-owners preserve an existing shared terminal's
dimensions on attachment. Pane viewing mode blocks local keyboard, IME, paste,
composer, focus, and resize commands while allowing explicit history scrolling;
it is a browser-local preference, and it is on whenever another person holds the
pane or the caller is a viewer of the workspace.

### Display owner and input owner

Who sizes a pane (its **display owner**) is separate from who types into it (the holder of its claim, the **input owner**).
`terminal.display { pane_id, action }` records the display owner in the bridge: `pin` ("Display on this device") binds it to the calling device, so other tabs and reloads of that device keep it and it outlives the device going idle; `take` ("Resize here") binds it to the calling page until that participant leaves or its lease expires; `release` (owning device only) removes it.
Records are per connection runtime, live in bridge memory, and are announced at once as `collaboration.display` events and as `display_owners` on every presence snapshot, carrying pane, participant, pinned flag, and time, never device keys.

While a pane has a display owner, the bridge enforces it for every other device regardless of what the page asks:

- `terminal.resize` and `terminal.relay_resize` are skipped (`skipped: true`), and `terminal.focus` is skipped because focusing makes Thyra's shell Herdr's size owner.
- `terminal.attach` behaves as `preserve_size`; a stream opened for such a follower starts at the display owner's last size, not the follower's.
- Followers always receive the whole surface at the shared size; after the owner resizes, every follower's viewport moves with it.
- Their input tells Herdr not to claim size ownership (below).

Panes without a display owner keep the claim-based browser rules above.
In the browser, a device that may not size the pane mirrors the shared size and scales xterm down to fit; its pinch zoom magnifies and pans that scaled view and never sends a resize, while a device that sizes the pane refits it once when the pinch ends.
The claim holder of a pane another device displays is input-only: it opens the composer, previews at one frame per second (`min_frame_interval_ms: 1000`), or pauses frames and polls `terminal.preview_text` (last 60 lines, every 1.5 s while visible) for a text preview; the bridge reads it with Herdr `pane.read` in ANSI format and strips ANSI, like the MCP pane read, so the page never picks read parameters that could replay input.
"Type here, keep size on {device}" claims the pane without touching the display; "Take control and resize here" also takes it.

Herdr decides which of its clients sizes a tab: pane input, focus, and navigation from a shell make it Herdr's foreground client and the tab's geometry controller.
Thyra's bridge shares one endpoint shell per terminal among all browsers, so this matters only when a native Herdr TUI views the same tab.
Herdr builds advertising the `input_geometry` endpoint capability accept `input_claims_geometry` in the hello and an `endpoint.input-geometry.v1` control (`{"claims_geometry": bool}`), ordered with pane input on the same socket.
The bridge sends the control only when the value changes: `false` before input from a device that may not size the pane, `true` before the display owner's.
Older Herdr ignores both, and such input moves Herdr's size owner to Thyra's shell as before.

The bridge first forwards `collaboration.*` calls to the Herdr control socket.
Herdr versions without that API return an unknown-method response, which selects
a bridge-local lease map with the same response shape. If a stock direct client
or another bridge already controls the terminal, the browser falls back to
observe mode and does not evict it until the user chooses **Take control**.

Herdr lists every client-socket shell as a `tui:<client id>` participant, including the bridge's own endpoint shells (terminal sessions and the popup observer).
Herdr does not tell a shell its id, so the bridge brackets each of its handshakes with `collaboration.list` calls and records the new `tui:` id; a window claims ids only when there are no more of them than its concurrent bridge handshakes, so a real client attaching at the same moment stays visible.
Recorded ids are shared by every profile using the same client socket, reset when the endpoint boot ID changes, and removed from forwarded events and collaboration RPC results, so browsers see only other browsers and real Herdr clients.

### Collaborator identity

The bridge resolves every WebSocket to a device and a person when it upgrades and when the page calls `bridge.identity`:

- **Client address.** The socket peer, unless the peer is a trusted reverse proxy (`THYRA_TRUSTED_PROXIES`, loopback by default).
  From a trusted proxy, `X-Forwarded-For` is read from the right, skipping trusted hops, so a client cannot choose its address; `X-Real-IP` is used only without `X-Forwarded-For`.
  Forwarded headers from any other peer are ignored. The address is used only for identity, never for authentication.
- **Account.** A logged-in page's person is its account, whatever the device; its account display name is the default name.
- **Tailscale (preferred).** A tailnet address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) belongs to one node, so `whois` through the tailscaled LocalAPI socket or the `tailscale` CLI names the device (node StableID and MagicDNS name) and, for user-owned nodes, the person (login, display name, profile picture).
  Lookups are cached per address for five minutes (30 seconds for misses), time out after 1.5 seconds, and fail soft.
  Without `whois`, a tailnet address still identifies one device, but no person.
- **Fallback.** A random `thyra_device` cookie (HttpOnly, `SameSite=Lax`, 400 days, `Secure` over HTTPS or behind an HTTPS proxy) is issued with the first page or WebSocket handshake and identifies one browser context.
  Contexts that cannot share cookies, such as an iOS home screen app and Safari, are matched to one device only when a new cookie context reports the same OS, screen size, and time zone (and no conflicting model, OS version, or language) as exactly one device seen from the same client address in the last 12 hours.
  This is a likely, not certain, match; the same address alone never merges devices, because home and office NATs share one public address among many devices.
  Without Tailscale the person is the device.
  Hints are the User-Agent, User-Agent Client Hints where offered, screen size, time zone, language, and display mode; there is no canvas, audio, or font fingerprinting.

The bridge replaces the name and color of each `collaboration.update` it forwards to Herdr with the resolved profile: a custom name stored on the server for the person (or device), else the Tailscale display name, else the page's device-based default.
Browser-stored names from earlier versions are migrated once on connect.
Presence snapshots sent to browsers gain opaque `person_id`/`device_id` fields and one `people` and one `devices` table; they never contain client addresses, cookie values, or other people's logins, and a page learns its own login only from `bridge.identity`.
Herdr TUI participants are labelled `Herdr TUI` on the Herdr host.
`bridge.status` reports distinct `devices` beside browser `clients`; **Pause other browsers** still pauses every other browser connection, including other tabs on this device.

Identity state lives in `~/.config/thyra/identities.json` (`THYRA_IDENTITY_PATH` overrides), mode `0600`: device records with keyed hashes of client addresses, custom profiles, and the key for opaque ids.

## SSH transport

Each runtime supervises one OpenSSH process forwarding both sockets into a private
temporary directory. Readiness requires control `ping` and render handshake.
Transient failures retry six times with cancellable backoff capped at 30 seconds,
reset after 30 seconds stable-ready. Authentication, host-key, and permanent
protocol failures do not retry. Post-ready exit retires the generation first.
CLI SSH uses the same probes without persistence or automatic retry.

Only OpenSSH aliases or `user@host` are accepted, after `--` with fixed options.
Host-key checks remain enabled; service authentication is noninteractive. OpenSSH
configuration owns credentials/options. Stderr is bounded/sanitized. Cleanup
removes owned paths only after confirmed child exit; otherwise it preserves them
and reports failure. Host operations share this boundary; see [connection setup](./DEPLOYMENT.md#multiple-and-remote-herdr-connections).

## Distribution model

Production embeds frontend assets and Bun into one executable; targets need no
Bun/Node.js. Builds use the `thyra` release identity across binaries, archives,
checksums, and manifests. Missing or invalid manifests fail closed without archive
discovery. Publication requires exactly the six platform asset sets.

## Web delivery and caching

Caching contract (`server/src/http/static-files.ts`):

| Response | `Cache-Control` | Login and cookies |
| --- | --- | --- |
| `/assets/**` (Vite output, terminal font slices, WebAssembly) | `public, max-age=31536000, immutable` | Served to everyone on every listener before any session work; never `Set-Cookie` |
| Missing `/assets/**` | `no-store` (a `404`, never the SPA entry) | Same |
| Icons, `/favicon.ico`, `/manifest.json` | `no-cache, must-revalidate` | Same |
| `index.html`, the service worker, `/thyra-assets.json` | `private, no-cache, must-revalidate` | Need a login; tailnet login may set the session cookie here |
| Login, enrollment and share pages, API responses | `no-store` | |

Everything under `/assets/` is content-addressed; never write an unfingerprinted file there.
Because those files are public open-source bundles with identical bytes and `ETag` on both listeners, Cloudflare caches them for the public listener (see [Cloudflare edge caching](./DEPLOYMENT.md#cloudflare-edge-caching)); the primary listener routes them (`static.asset` in `http-policy.ts`) before authentication, so tailnet login sets its cookie on navigations, API calls and the WebSocket upgrade only.
Revalidated files carry a strong per-encoding `ETag`, so revalidation costs a `304`.
Text files of at least 1 KiB are sent as Brotli (quality 11) or else gzip with `Vary: Accept-Encoding`, compressed once per file version off the event loop.
At startup the bridge compresses the entry document's assets and the build's `boot` list (the terminal view's static closure and font stylesheets) before the first request.

The first screen downloads only the entry and the terminal view's closure; the page opens its WebSocket before rendering, so the socket does not queue behind those chunks for a browser's six HTTP/1.1 connections.
Everything else waits for the first terminal output (`startupGate.ts`): the WebGL renderer, the terminal font (a small ASCII/Latin-1/Powerline stylesheet, then the CJK and icon chunks when idle), warmups, prefetches and the service worker.
The gate's fallback for output that never comes starts only once a terminal attach has completed, so it cannot expire while the terminal code is still downloading.
Zstandard and compression dictionaries are not offered: WebKit supports neither, and quality-11 Brotli is smaller than zstd for these bundles.

The build splits long-lived vendor code into `vendor-react`, `vendor-xterm`, `vendor-ui` (only UI-library modules the entry loads eagerly) and the lazy `vendor-aria` (React Aria for overlays) chunks, so an app-only update does not re-download them (`web/vite.chunks.ts`).
Chunks that import from the entry still change with it.
It also writes `thyra-assets.json` with a build `version`, every file under `/assets/`, the `boot` list, and the `precache` list: the entry and terminal closures, the WebGL renderer, and the core font stylesheet with its regular and bold slices.

### Service worker

Production pages that are not yet controlled register one service worker, `/task-notifications-sw.js` at scope `/`, after the `load` event and the first terminal output (`startupGate.ts`); it also handles Web Push, so there is never a second worker.
The worker holds no build-specific code, so a deploy does not replace it; it follows builds through `/thyra-assets.json`.
Once active it claims open pages; the page then asks it to copy the assets it loaded before control from the HTTP cache (`only-if-cached`, falling back to `force-cache` because WebKit can miss a file it has just loaded), after which the worker downloads the rest of the build's `precache` list one file at a time (through the HTTP cache).
- `/assets/*` GETs without a query or `Range` are cache-first in `thyra-assets-v1`; misses are cached on first use, and a page request joins a precache download of the same file.
  Only `200` same-origin, non-redirected, non-HTML responses marked `immutable` are stored.
- Navigations to `/` or `/index.html` without a query are network-first: the network response (including login redirects and errors) is returned unchanged, and the cached shell in `thyra-shell-v1` answers only when the network fails or has not answered within 4 seconds.
  Only `200` same-origin, non-redirected HTML is stored as the shell.
- Every other request (API routes, `/ws`, `/login`, `/enroll`, `/s/` share pages, navigations with a query, file previews, non-GET methods) bypasses the worker.
- When the stored shell changes, the worker fetches `/thyra-assets.json` and deletes cached assets used by neither the new build nor the two builds before it.
  Activation deletes every other `thyra-*` cache; bump the cache names when the stored format or strategy changes.

A warm load therefore transfers only the entry document (or its `304`), revalidations of the icons and web manifest, and API and WebSocket data.

### Deploys and open pages

The hello carries `web_entry`, the entry script of the build the bridge serves.
A deploy restarts the bridge, so every open page reconnects; one whose own entry script differs shows a "new version" toast with **Reload page** instead of reloading by itself (an in-app update, which restarts and reloads on its own, is excluded).
It also asks the worker to prepare the update: the worker stores the new shell, so the reload starts the new build even when the network is slower than the shell timeout, and precaches the new build's `precache` list in the background.

A page left running on an older build must still be able to lazy-load its chunks.
The worker keeps the cached assets of the two builds before the current one, and the bridge answers `/assets/` misses from an on-disk archive (`server/src/http/asset-archive.ts`): after each start it copies the running build's files there (existing names are skipped) and keeps the newest five builds.
The standalone binary archives under `~/.config/thyra/asset-archive` by default; `THYRA_ASSET_ARCHIVE_DIR` moves or disables it.
A chunk that is in neither place still fails, and the lazy loader then reloads the page once (`lazyWithReload.ts`).
A stale shell can also run one load after a deploy when the network is slower than the fallback timeout; that page offers the reload as above.

## Trust boundary

Thyra runs as one operating-system user; accounts and workspace grants decide what each person sees and may change, not what a shell they may type into can do.
See [Security](../SECURITY.md#trust-model) for the roles and the outer access controls.

Each HTTP request is classified before routing (`server/src/http/request-access.ts`): its effective host and scheme (from `X-Forwarded-Host`/`-Proto` only for trusted proxies), whether it was proxied, and whether it is direct local use.
Unknown hosts are refused; `/ws` and non-GET/HEAD requests require an allowed `Origin` unless local; `/api` reads refuse foreign initiators.

**Principals.** `server/src/auth/principal.ts` resolves every request to a principal: `local` (direct use of a loopback listener, an instance admin without an account), a `user` from the `thyra_session` cookie, or a `user` from tailnet login, which maps a proxied tailnet address through Tailscale `whois` (the identity service's cache) to an account, creating and linking it (identity `tailscale`/login) on first sight, and issues a session cookie on that response or WebSocket upgrade.
A live share-link guest cookie yields a `guest` principal (see share links below) only when the request has no account (local use, session cookie or tailnet login), or when the browser also carries `thyra_as_guest=1` (`__Host-` on the public listener), which redemption sets only for an explicit "Open as guest"; an account in the same browser otherwise keeps its own authority.
A session whose privilege epoch is older than its user's is rotated to a new id on its next request.
`requireLogin(req, access)` returns the principal and cookie headers, or the login redirect/401, for listeners that require an account.
Passkey registration and login (`server/src/auth/passkeys.ts`, `@simplewebauthn/server`) use discoverable credentials; the relying party is the effective host name, and challenges are single-use and held in memory for five minutes.
**Sign-in providers.** `server/src/auth/providers.ts` turns email (Resend), GitHub and Google on from their variables (and `auth-providers.env`); `sign-in-routes.ts` serves the email code and link, OAuth start, callback, confirmation and poll, and invitation routes, and `sign-in.ts` maps a verified identity to an account (by subject; by verified address only when both sides are verified; otherwise "no access" or, with `THYRA_SIGNUP=open`, a new member).
OAuth goes through arctic's `OAuth2Client` with PKCE; a flow is a row keyed by its state, the starting page holds its poll secret and pairing number, a callback with the flow cookie signs that browser in, and one without asks first and leaves the session for the poll.
`account-routes.ts` serves the account page: profile, avatar (WebP or JPEG up to 256x256 and 128 KiB, stored under its SHA-256 in `avatars/` beside the database and served with an immutable cache), sign-in methods with last-method protection, other sessions, and invitations by email.
A profile change closes the account's sockets with 4003 so presence picks up the new name and picture.
The login and enrollment pages are small server-rendered documents outside the application bundle; their strings travel in a JSON data block and their logic is the same-origin `/auth/passkey.js`, so they need no inline script under the public listener's CSP.

**Account database.** `server/src/accounts/` keeps a `bun:sqlite` database (`thyra.db`, WAL, mode `0600`) with numbered migrations in `PRAGMA user_version`:

| Table | Contents |
| --- | --- |
| `users` | id, unique name, display name, instance role (`admin`/`member`), disabled flag, privilege epoch, avatar file (content hash) |
| `identities` | `(provider, subject)` linked to a user: `tailscale`/login, `email`/address, `github`/user id, `google`/`sub`; address, whether it is verified, picture URL |
| `sessions` | SHA-256 of the cookie value, public id, user, method, epoch, user agent, created/last seen/expiry |
| `passkeys` | credential id, user, COSE public key, counter, transports, RP ID, name |
| `enrollments` | SHA-256 of single-use enrollment secrets, user, expiry |
| `workspace_grants` | `(connection, workspace id, user)` with `owner`/`editor`/`viewer` and who granted it |
| `share_links` | public id, SHA-256 of the link secret, connection, workspace, optional pane, role (`viewer` only), label, creator, expiry, max uses, uses, revocation time |
| `guest_sessions` | SHA-256 of a guest cookie value, public id, link, user agent, created/last seen/expiry (the link's) |
| `email_codes` | mailed sign-in and verification codes: SHA-256 of the 6-digit code and of the link secret, address, purpose, attempts, expiry (10 minutes), use |
| `oauth_flows` | GitHub/Google flows in progress: SHA-256 of state and poll secret, PKCE verifier, intent (`login`/`link`), pairing number, status and result |
| `invites` | SHA-256 of invitation secrets, invited account, address, expiry (7 days) |
| `tailnet_sso_codes` | SHA-256 of single-use tailnet sign-in codes, user, PKCE challenge, return origin, expiry (60 seconds) |
| `audit_log` | account, session, passkey, grant and share-link changes (bounded) |

Every change to a user's role, grants or status bumps its privilege epoch.
The server checks `PRAGMA data_version` every second, so changes made by the CLI apply at once: sockets of ended sessions close with code 4001 and sockets whose epoch changed close with 4003 and reconnect under the new authority.
Herdr keeps workspace ids across restarts and live handoff (they are restored from the session snapshot), so grants name the workspace id; a `workspace.closed` event deletes the workspace's grants and revokes its share links, because Herdr may reuse the id of a closed workspace.

**Share links.** `server/src/accounts/share-links.ts` issues anonymous read-only links, `<base>/s/<id>#<secret>`: a 256-bit secret shown once and stored as its SHA-256, scoped to one workspace or one of its panes, always with the viewer role, valid for 5 minutes to 30 days (24 hours by default), optionally limited in uses.
The landing page `/s/<id>` is server-rendered like the login page; `/auth/passkey.js` reads the fragment, drops it from the address bar and, when the visitor opens the view, posts `{id, secret}` to `/api/share/redeem`.
A visitor already signed in (checked without starting a session) is offered **Open with my account**, which just opens Thyra, or **Open as guest**, which posts `as_guest: true`; redemption without it answers `409 signed_in` for a signed-in browser and creates nothing.
`POST /api/logout` from the effective guest (no account, or `thyra_as_guest`) ends that guest session on the server and clears both guest cookies; otherwise it logs the account out.
Redemption compares digests in constant time (unknown ids cost the same), counts the use atomically, and creates a guest session whose `thyra_guest` cookie (`__Host-thyra_guest` on the public listener) resolves to a `guest` principal (no account) until the link expires or is revoked; a browser redeeming a link it already watches keeps its session and use.
Failed redemptions are rate-limited per client address like passkey attempts, and create, redeem, leave and revoke are audited without secrets.
Revocation deletes the link's guest sessions and expiry is checked every second, so both close guest sockets with 4001 within a second; the page then lands on a "Shared view ended" notice served in place of the login page.
Owners and admins list, create and revoke links over `/api/share-links` (the **Share workspace** dialog) and `thyra share`.

**Authorization.** Every WebSocket method and HTTP route has an entry in `server/src/authz/policy.ts` or `server/src/authz/http-policy.ts`; anything else is refused before routing.
An entry names a class (`read`, `write`, `admin`, `dangerous`), a scope (`session`, `workspace`, `list`, `host`, and for HTTP also `public`, `connection`, `editor`), and for workspace methods `resolve(params)`, which names the workspace, tab, pane or terminal the request acts on.
`authorize()` in `server/src/authz/authorize.ts` applies it after connection routing: `admin`, `dangerous` and `host` entries need an instance admin; every id a request names must resolve to a workspace where the caller holds the entry's minimum role (viewer for reads, editor for writes, owner for renaming, closing and sharing).
Pane and tab ids carry their workspace (`w1:p3`); terminal ids are located through a per-connection map loaded from `pane.list`, marked stale by structural events, and reloaded at most once a second for unknown ids; ids it cannot place are refused for members.
Terminal methods without `terminal_id` act on the socket's current terminal, which the bridge fills in before authorizing.
A share-link guest holds the viewer role on its link's workspace only, and reaches only the `session` methods and routes marked `guest` (no profile, passkeys, sessions, push or voice); a link narrowed to one pane admits only requests that name that pane, its terminal or its tab, never workspace-wide ones such as files and Git.
The interface offers only what this table allows: `server/src/authz/capabilities.ts` derives `capabilities` from it, `edit` (as `pane.split`) and `manage` (as `workspace.close`) on every workspace the caller lists, and `host` (as `workspace.create`) on the principal in the hello and `/api/auth/me`.
The browser hides or disables menus, buttons, shortcuts and command-menu entries that need a capability the caller lacks (`web/src/capabilities.ts`), with no role lists of its own; the bridge still refuses them.
A test compares the decisions for an instance admin, a workspace owner, editor and viewer, an outsider, a guest and a pane-scoped guest over every table entry with a reviewed matrix, so a new method or route fails until its row is added, and another test fails when a method the server dispatches or `web/src` calls has no entry.
Cross-workspace results and events are filtered per principal (`server/src/authz/filters.ts`): workspace, tab, pane and agent lists (workspaces gain the caller's `access` role), presence snapshots, claims and display owners (`collaboration.display` events and `terminal.display` results too), bridge status and connection lists (no profile details), and forwarded Herdr events, which pass, are filtered, become a bare `session.resync_required`, or are dropped (unknown events without a workspace are dropped).
For a pane-scoped guest the same filters keep only the pane, the tab holding it and the workspace, shrink `pane.layout` to the one pane, pass events about only that pane, resync on ones that reshape it, and drop the rest; its presence updates never name another place.
Web Push subscriptions record their account and receive only notifications for workspaces it may see; guests cannot subscribe.
Routine host-level calls a member's page makes (`terminal.host_theme`, `terminal.watch_popup`) get a fixed harmless answer instead of an error.

**Single writer.** The bridge mirrors each connection's pane claims from every collaboration snapshot and from the results of the claim, release and leave calls it makes.
`writer` entries (`terminal.input`, `pane.send_*`, `pane.paste`, `terminal.focus`, `terminal.resize`, `terminal.relay_resize`, `terminal.display`) are refused while another principal's participant holds the pane; input to an unclaimed pane first claims it for the caller with 15 seconds of protection.
`collaboration.claim` needs the editor role, protection is capped at 15 seconds, and a workspace owner's or admin's takeover first releases a protected claim.
`terminal.scroll` from a caller who may not write stays in Herdr's history.
The [display owner](#display-owner-and-input-owner) rules compose with these checks inside the terminal bridge: only a person who may control a pane can take or pin its display, and that person's own devices may split display and input between them.

**Listeners.** Each listener has a fixed kind (`server/src/http/listener.ts`) that is threaded into the request-access policy and tailnet login: the primary listener is `tailnet` (tailnet login on) or `local`, and `THYRA_PUBLIC_LISTEN` binds a `public` listener.
No header changes a request's kind.
On `public`, the policy accepts only `THYRA_PUBLIC_ORIGIN` as host and origin, is never local, treats the scheme as HTTPS, and takes the client address from `CF-Connecting-IP` of a trusted peer only (never loopback or tailnet values); tailnet login refuses anything but the `tailnet` kind and any request with Cloudflare headers.
The public router (`publicFetch` in `server/src/index.ts`) rate-limits per client, then asks its `PublicAuthenticator` (`server/src/auth/public.ts`, interface in `server/src/http/public-auth.ts`) to serve the login, enrollment, passkey, share-link and logout routes and to resolve the principal from its own `__Host-thyra_session` or `__Host-thyra_guest` cookie.
It shares the account database and routes with the primary listener, but its authenticator has no local bypass and no tailnet login, and the primary listener's cookie name differs, so neither listener accepts the other's cookie.
**Tailnet sign-in** (`server/src/auth/tailnet-sso.ts`, `THYRA_TAILNET_SSO_URL`) bridges the two: the `tailnet` listener issues a code (`sso.code` for the public login page's silent CORS request, `sso.authorize` for the redirect flow) to the account that Tailscale `whois` names for the proxied connection, and the `public` listener redeems it (`sso.redeem`, `sso.callback` after `sso.start`) for its own session, and `sso.config` tells the public login page the tailnet origin, which its HTML never names (the redirect button appears only in a browser with an earlier tailnet sign-in, the `__Host-thyra_tailnet_device` cookie, or a refused Chrome Local Network Access prompt); each route answers `404` on the other listener kind.
Codes live in `tailnet_sso_codes`, bound to a PKCE challenge and `THYRA_PUBLIC_ORIGIN`, and are deleted by the redeeming `DELETE … RETURNING`, so a replay finds nothing; the primary listener skips its Origin allowlist only for `sso.code`, whose handler allows exactly the public origin.
Without a principal only those routes and fingerprinted assets are served and everything else is `401` or a redirect to `/login`; with one, requests go through the same HTTP and RPC authorization as on the primary listener, and MCP is never served.
Public responses add HSTS, a strict CSP (the SPA entry's inline scripts are allowed by hash), and `__Host-` cookies.

The browser accepts one unscoped bridge hello before other messages. Message kinds
are exclusive and validated; downstream events cannot inject reserved bridge
fields. NDJSON lines/acknowledgements are bounded; malformed terminal frames are
dropped. Observable HTTP traversal is rejected, but Bun may normalize dot segments
before routing; legacy aliases prevent distinguishing every such normalization.

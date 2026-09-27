# Security Policy

## Supported Versions

Security fixes cover the latest release.

## Reporting a Vulnerability

**Do not open a public issue.** Use a private repository security advisory with versions, reproduction steps, and impact.
If unavailable, use the maintainer's GitHub-profile contact address.

## Trust Model

Thyra runs as one operating-system user and drives that user's Herdr.
**A terminal is that user's shell:** anyone who may type into a pane can run any command the Thyra user can, read any file it can, and reach anything on its network.
Workspace grants decide which terminals, files and events a person sees and whether they may type; they are not a sandbox.
Grant **editor** only to people you would give a shell account on the host.

### Who is logged in

- **Direct local use.** Listeners on `127.0.0.1`, `localhost` or `::1` skip login for a loopback peer that sends no forwarding headers, addresses a loopback host, and carries no foreign `Origin` (an SSH port forward counts).
  It acts as the host owner (instance admin) without an account.
  A request that arrived through a reverse proxy (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`) is never local.
- **Tailnet login** (`THYRA_TAILNET_AUTH=admin`, the default when Tailscale `whois` works).
  A proxied request from a proxy in `THYRA_TRUSTED_PROXIES` whose forwarded client address is a tailnet address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) that `whois` maps to a user is logged in to that user's account, which is created on first sight and linked to the Tailscale login.
  New tailnet accounts are **instance admins** (`THYRA_TAILNET_AUTH=member` makes them members); a later `thyra user role` change or `thyra user disable` is kept.
  Restrict who reaches the proxy with Tailscale ACLs.
  Tagged nodes, unknown peers and `whois` failures get the login page.
  Never enable tailnet login on a proxy or listener reachable from outside the tailnet, such as a public tunnel.
- **Passkeys** (WebAuthn) for everyone else.
  `thyra user add <name>` on the host prints a single-use enrollment link, valid for 24 hours, whose secret is in the URL fragment (never sent to servers or logs).
  A passkey belongs to the host name it was created on and needs HTTPS or `localhost`; plain HTTP to a LAN address cannot log in.
  A logged-in user adds passkeys for the current host under **Configuration > Account**.

- **Share-link guests** have no account.
  A workspace owner or instance admin creates an anonymous, read-only link (`https://<host>/s/<id>#<secret>`) in **Share workspace… > Links** or with `thyra share create`; see [share links](docs/DEPLOYMENT.md#read-only-share-links).
  The 256-bit secret is in the URL fragment, which browsers never send: the landing page (`Referrer-Policy: no-referrer`) posts it once the visitor opens the view, and the database stores only its SHA-256, compared in constant time.
  Redeeming it creates a guest session (a random 256-bit cookie, `thyra_guest` or `__Host-thyra_guest` on the public listener, stored as a digest) that is the viewer of that one workspace, or of one pane of it, until the link expires (24 hours by default, 30 days at most) or is revoked; both disconnect the guest within a second.
  Links may be limited to a number of uses; failed redemptions count toward the same per-address limit as passkey attempts; creating, redeeming and revoking are audited, never with a secret.
  **Anyone holding the link can watch** the shared terminals, their scrollback and agent status, and for a whole-workspace link its files and Git changes, until it ends; share it privately and keep it short-lived.
  A guest cookie takes precedence in its browser, so an admin who opens a link in the same browser watches as that guest until the link ends.

There is no shared password or token login.
The session cookie `thyra_session` holds a random 256-bit id; the database stores only its SHA-256 digest.
Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, and last 30 days.
When a user's role, grants or status change, their sessions are rotated to a new id on the next request, and their open pages are disconnected (close code 4003) and reconnect under the new authority.
**Log out** and **Sign out** (Configuration > Account), `thyra session revoke`, `thyra user disable` and `thyra user remove` end sessions at once: live connections close within a second, including sessions ended from the CLI while the server runs.
Passkey and enrollment attempts allow 10 failures a minute per client address (forwarded only by trusted proxies), then block that address for a minute, doubling up to 15 minutes.

**Listeners decide trust, never headers.**
The primary listener (`HOST`/`PORT`) is `tailnet` when tailnet login is on and `local` otherwise.
The optional **public listener** (`THYRA_PUBLIC_LISTEN`, for Cloudflare Tunnel) is always `public`: only a passkey session in its own `__Host-thyra_session` cookie (or a share link's `__Host-thyra_guest`) authenticates there, never the loopback bypass, tailnet login or the primary listener's cookies.
On the public listener `X-Forwarded-*` and Tailscale headers are ignored, `CF-Connecting-IP` sets only the rate-limit address (and only from `THYRA_PUBLIC_TRUSTED_PROXIES`, loopback by default), and `Host` and `Origin` must be `THYRA_PUBLIC_ORIGIN`.
It sends HSTS and a strict Content Security Policy (the login page's script is the same-origin `/auth/passkey.js`), and sets only `__Host-` cookies.
Before login it serves the login and enrollment pages, the passkey ceremonies, share-link landing and redemption, and static assets, and refuses every other API, MCP and WebSocket request; MCP is never served there.
On the primary listener, the public host gets `421` and a request carrying Cloudflare headers never gets tailnet login, so a misrouted tunnel fails closed.
See [public access](docs/DEPLOYMENT.md#public-access-through-cloudflare-tunnel).

### What each role may do

Instance **admins** (and direct local use) may do everything, including host-wide file browsing (`scope: "filesystem"`), the project launcher, worktree creation and hooks, repository settings, connections and SSH profiles, Herdr setup, updates, plugins and integrations, and every workspace.
**Members** see only workspaces granted to them:

| Workspace role | May |
| --- | --- |
| viewer | list and watch its terminals, scroll history, read its files, Git state and agent history |
| editor | also type (single writer, below), change layout, edit files, run Git actions, use voice input |
| owner | also rename, close and share the workspace, and take control of a pane at any time |

A **share-link guest** is a viewer of its link's workspace only, or of just one pane (never that workspace's other panes, files or Git), and cannot change a display name, subscribe to Web Push, use voice input, or see accounts and sessions.
Guests appear in presence as "Guest" plus the link's label.

Workspace lists, events, presence, pane claims, bridge status and Web Push notifications are filtered to the caller's workspaces (and a pane-scoped guest's pane).
Grants name a connection and a Herdr workspace id; Herdr keeps ids across restarts and live handoff, and a workspace's grants are deleted when Herdr reports it closed.

**Single writer.** Only the holder of a pane's claim may send it input, resize it or move its terminal focus; the same person's other pages may type too.
Typing into an unclaimed pane claims it with 15 seconds of protection.
An editor takes control with **Take control** once the protection ends; owners and admins may take it at any time.
Viewers and guests never write; they, and editors while another person holds the pane, scroll only Herdr's history (Herdr keeps one history position per pane, so everyone watching the pane sees the scroll).

### Browser request checks

Browser requests are bound to Thyra's own origin, so another web page open in a signed-in (or local) browser cannot drive the bridge:

- **Host allowlist.** `Host` (or a trusted proxy's `X-Forwarded-Host`) must be a loopback name, an IP literal, the bind host, or a host in `THYRA_PUBLIC_BASE_URL`; anything else gets `421`.
  This defeats DNS rebinding.
- **Origin allowlist.** WebSocket upgrades and every non-GET/HEAD request need an `Origin` equal to the request's own origin (as seen through a trusted proxy), a `THYRA_PUBLIC_BASE_URL` origin, or `http://localhost:<port>`/`127.0.0.1:<port>`.
  Without `Origin` they are accepted only as direct local use.
  API reads are also refused for a foreign `Origin` or a cross-site/same-site `Sec-Fetch-Site`.
- **Deny by default.** Every WebSocket method and HTTP route is looked up in a policy table (`server/src/authz/policy.ts`, `server/src/authz/http-policy.ts`) that names its class, scope and target; anything unlisted is refused.
  Herdr methods the web client does not use, such as `server.stop`, `plugin.enable`, `integration.install` or `agent.prompt`, are rejected for everyone.
- **Presence.** The bridge assigns each page's collaboration participant id and role; a page can claim, release, or leave only as itself.

Thyra's HTML pages send `Referrer-Policy: no-referrer` and `frame-ancestors 'none'`.

### Exposure

**Do not expose the primary listener to the public internet**; use the public listener behind Cloudflare Tunnel for a public address.
For non-loopback listeners, use [native HTTPS](docs/DEPLOYMENT.md#native-https), an HTTPS proxy, or a trusted VPN, and restrict access with a firewall or reverse proxy.
Treat worktree hooks as executable code.

[Voice input](docs/DEPLOYMENT.md#voice-input) sends recorded speech segments to the configured providers; a cloud provider receives that audio, and a fallback provider receives it when the primary fails.
Dictation cleanup sends the transcript text to the configured language model.
Personal dictionary terms accompany recognition and cleanup requests.
Their credentials stay in the service environment; any editor of any workspace can use them.

Updates trust the configured HTTPS release origin (or explicit loopback test mirror) and its manifest/checksums.
Checksums detect corruption and bind the archive, **not independently verify publisher identity**.
Custom mirrors are trusted executable-code infrastructure.
Update requests need an instance admin plus `x-thyra-update: 1`.

The account database (`~/.config/thyra/thyra.db`, mode `0600`) holds accounts, passkey public keys, session digests, grants, share-link and guest-session digests and an audit log; protect it and its backups.

Web Push subscription mutations require a login, JSON, and `x-thyra-push: 1`; cross-site browser requests are rejected.
Each subscription records the account that created it and receives notifications only for workspaces that account may see.
Push endpoints are restricted to supported browser-provider HTTPS hosts and are never followed through redirects.
Treat the private push registry as credentials.
Logging out does not remove device subscriptions: disable Web Push or remove subscriptions separately.
Notification payloads can expose agent names and routing IDs on lock screens.
See [Web Push configuration](docs/DEPLOYMENT.md#web-push-notifications).

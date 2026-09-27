# Security Policy

## Supported Versions

Security fixes cover the latest release.

## Reporting a Vulnerability

**Do not open a public issue.** Use a private repository security advisory with
versions, reproduction steps, and impact. If unavailable, use the maintainer's
GitHub-profile contact address.

## Trust Model

**UI access grants the Thyra user's authority:** terminals, repository hooks,
session data, and workspace uploads/deletions. This is privileged administration,
not a sandbox or multi-user permission system.

The default bind is `127.0.0.1`. Listeners configured as `127.0.0.1`, `localhost`,
or `::1` skip login only for **direct local use**: a loopback peer that sends no
forwarding headers, addresses a loopback host, and carries no foreign `Origin`.
An SSH port forward is direct local use. A request that arrives through a reverse
proxy (`X-Forwarded-*`, `Forwarded`, or `X-Real-IP`) is never local and must log in
with `THYRA_PASSWORD` or the generated token, even on a loopback listener.

**Do not expose Thyra directly to the public internet.** For non-loopback:

- Set a strong `THYRA_PASSWORD`; prefer it to `--password`, which exposes
  secrets in process arguments.
- Use [native HTTPS](docs/DEPLOYMENT.md#native-https), an HTTPS proxy, or a trusted
  VPN; restrict access with a firewall/reverse proxy.
- Treat worktree hooks as executable code.

[Voice input](docs/DEPLOYMENT.md#voice-input) sends recorded speech segments to the configured providers; a cloud provider receives that audio, and a fallback provider receives it when the primary fails.
Dictation cleanup sends the transcript text to the configured language model.
Personal dictionary terms accompany recognition and cleanup requests.
Their credentials stay in the service environment, and any authenticated client can use them.

Browser requests are bound to Thyra's own origin, so another web page open in a
signed-in (or local) browser cannot drive the bridge:

- **Host allowlist.** `Host` (or a trusted proxy's `X-Forwarded-Host`) must be a
  loopback name, an IP literal, the bind host, or a host in `THYRA_PUBLIC_BASE_URL`;
  anything else gets `421`. This defeats DNS rebinding.
- **Origin allowlist.** WebSocket upgrades and every non-GET/HEAD request need an
  `Origin` equal to the request's own origin (as seen through a trusted proxy), a
  `THYRA_PUBLIC_BASE_URL` origin, or `http://localhost:<port>`/`127.0.0.1:<port>`.
  Without `Origin` they are accepted only as direct local use. API reads are also
  refused for a foreign `Origin` or a cross-site/same-site `Sec-Fetch-Site`.
- **RPC policy.** Every WebSocket method is looked up in a deny-by-default table
  (`server/src/authz/policy.ts`) classed read, write, admin, or dangerous. Herdr
  methods the web client does not use, such as `server.stop`, `plugin.enable`,
  `integration.install`, or `agent.prompt`, are rejected.
- **Presence.** The bridge assigns each page's collaboration participant id and
  role; a page can claim, release, or leave only as itself.

`/api/login` and `?token=` logins allow 10 failures a minute per client address
(forwarded by trusted proxies), then block that address for a minute, doubling up
to 15 minutes. `?token=` works only on a page navigation, which sets the cookie
and redirects to the same URL without the token. Thyra's HTML pages send
`Referrer-Policy: no-referrer` and `frame-ancestors 'none'`.

Authenticated access still has full authority. Secure the outer access path:
native TLS encrypts transport but supplies no multi-user authorization or
sandboxing. Without TLS configuration, the listener uses unencrypted HTTP.

**Menu > Log out** removes this browser's authentication cookie, disconnects its
active tabs, and returns to login. It does not stop terminals, change the server
password/token, or log out other browsers. The action is hidden when this browser
did not need to log in. Cookies are stateless signed credentials: logout removes
the browser's copy, but does not revoke a copied cookie before its expiry. Rotate
the server credential if it or a session cookie has been compromised.

Updates trust the configured HTTPS release origin (or explicit loopback test
mirror) and its manifest/checksums. Checksums detect corruption and bind the
archive, **not independently verify publisher identity**. Custom mirrors are
trusted executable-code infrastructure.

Protect the auth token and its backups; see
[token rotation](./docs/DEPLOYMENT.md#run-as-a-user-service).
Update requests require normal listener authentication plus `x-thyra-update: 1`,
which does not replace login.

Web Push subscription mutations require listener authentication, JSON, and
`x-thyra-push: 1`; cross-site browser requests are rejected. Push endpoints
are restricted to supported browser-provider HTTPS hosts and are never followed
through redirects. Treat the private push registry as credentials. Revoking a
login password or logging out does not revoke device subscriptions: disable Web Push or remove
subscriptions separately. Notification payloads can expose agent names and
routing IDs on lock screens. See [Web Push configuration](docs/DEPLOYMENT.md#web-push-notifications).

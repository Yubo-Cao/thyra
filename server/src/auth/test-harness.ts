import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The real server in a child process with a throwaway home, for process
 * tests: a loopback listener behind a simulated reverse proxy, an optional
 * stub `tailscale whois`, and helpers for HTTP, WebSockets and the CLI.
 */

const REPO = join(import.meta.dir, "../../..");

export type TestServer = Awaited<ReturnType<typeof startTestServer>>;

export async function startTestServer(
  options: {
    env?: Record<string, string>;
    /** Tailscale login per tailnet client address (a stub CLI answers). */
    whois?: Record<string, string>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "thyra-process-"));
  let whoisCli = "";
  if (options.whois) {
    whoisCli = join(root, "tailscale");
    const cases = Object.entries(options.whois)
      .map(
        ([address, login]) =>
          `  ${address}) echo '{"Node":{"StableID":"n-${address}","ComputedName":"device"},"UserProfile":{"LoginName":"${login}","DisplayName":"${login.split("@")[0]}"}}' ;;`,
      )
      .join("\n");
    await writeFile(
      whoisCli,
      `#!/bin/sh\ncase "$3" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
    );
    await chmod(whoisCli, 0o755);
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: root,
    APPDATA: root,
    XDG_CONFIG_HOME: root,
    HOST: "127.0.0.1",
    PORT: "0",
    OPEN_BROWSER: "0",
    THYRA_PUBLIC_BASE_URL: "https://dev.example",
    THYRA_TRUSTED_PROXIES: "loopback",
    THYRA_TAILSCALE_IDENTITY: whoisCli ? "" : "off",
    THYRA_TAILSCALE_SOCKET: "",
    THYRA_TAILSCALE_CLI: whoisCli,
    THYRA_TAILNET_AUTH: "",
    THYRA_CONNECTIONS_PATH: join(root, "connections.json"),
    HERDR_SOCKET_PATH: join(root, "missing-control.sock"),
    HERDR_CLIENT_SOCKET_PATH: join(root, "missing-render.sock"),
    HERDR_SSH_HOST: "",
    HERDR_SESSION: "",
    THYRA_TLS_CERT: "",
    THYRA_TLS_KEY: "",
    ...options.env,
  };
  const child = Bun.spawn([process.execPath, "server/src/index.ts"], {
    cwd: REPO,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const ready = Promise.withResolvers<string>();
  let logs = "";
  const output = (async () => {
    for await (const chunk of child.stdout) {
      logs += new TextDecoder().decode(chunk);
      const port = logs.match(/\bINFO bridge listening\b[^\r\n]*:(\d+)\b/)?.[1];
      if (port) ready.resolve(`http://127.0.0.1:${port}`);
    }
    ready.reject(
      new Error(`Server exited before listening: ${logs}\n${await errors}`),
    );
  })();
  const deadline = setTimeout(
    () => ready.reject(new Error("Server startup timed out")),
    15_000,
  );
  let base: string;
  try {
    base = await ready.promise;
  } catch (error) {
    child.kill();
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  const sockets: WebSocket[] = [];

  /** Headers a Caddy on this host adds for a client address. */
  const proxy = (client: string) => ({
    host: "dev.example",
    "x-forwarded-for": client,
    "x-forwarded-host": "dev.example",
    "x-forwarded-proto": "https",
  });

  const request = (path: string, init?: RequestInit) =>
    fetch(`${base}${path}`, {
      redirect: "manual",
      ...init,
      signal: AbortSignal.timeout(5000),
    });

  async function connect(
    headers: Record<string, string>,
    session = "page-session-1",
  ) {
    const Socket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions,
    ) => WebSocket;
    const ws = new Socket(
      `${base.replace("http:", "ws:")}/ws?client_session=${session}`,
      { headers },
    );
    sockets.push(ws);
    const messages: any[] = [];
    const waiters: (() => void)[] = [];
    const closed = Promise.withResolvers<{ code: number; reason: string }>();
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
      for (const waiter of waiters.splice(0)) waiter();
    };
    ws.onclose = (event) =>
      closed.resolve({ code: event.code, reason: event.reason });
    const next = (match: (message: any) => boolean, timeoutMs = 5000) =>
      new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("WebSocket message timed out")),
          timeoutMs,
        );
        const check = () => {
          const found = messages.find(match);
          if (found) {
            clearTimeout(timeout);
            resolve(found);
          } else waiters.push(check);
        };
        check();
      });
    const call = async (
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const id = `${method}-${Math.random().toString(36).slice(2)}`;
      ws.send(JSON.stringify({ id, method, params }));
      return next((message) => message.id === id);
    };
    const hello = await next((message) => message.hello === true);
    return { ws, hello, next, call, closed: closed.promise };
  }

  /** Run `thyra <args>` against this server's home and database. */
  async function cli(...args: string[]) {
    const child = Bun.spawn(
      [process.execPath, "server/src/index.ts", ...args],
      {
        cwd: REPO,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  return {
    base,
    root,
    proxy,
    request,
    connect,
    cli,
    logs: () => logs,
    async stop() {
      for (const ws of sockets) ws.close();
      child.kill();
      await child.exited;
      await output.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

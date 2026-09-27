/**
 * Stand-in for `ssh` used by the demo "workbox" connection profile, so the
 * screenshots can show a connected SSH profile without a second machine.
 * Remote commands run locally; `-L local:remote` socket forwards are proxied
 * until the bridge stops the tunnel. Never put this on a real PATH.
 */
import { rmSync } from "node:fs";
import * as net from "node:net";

const args = process.argv.slice(2);
const forwards: { local: string; remote: string }[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] !== "-L") continue;
  const spec = args[index + 1] ?? "";
  const colon = spec.indexOf(":");
  if (colon > 0) {
    forwards.push({
      local: spec.slice(0, colon),
      remote: spec.slice(colon + 1),
    });
  }
}

if (forwards.length === 0) {
  const separator = args.lastIndexOf("--");
  const command = separator >= 0 ? args.slice(separator + 2).join(" ") : "";
  const child = Bun.spawn(["sh", "-c", command || "true"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await child.exited);
}

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
for (const forward of forwards) {
  rmSync(forward.local, { force: true });
  const server = net.createServer((client) => {
    const upstream = net.createConnection(forward.remote);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(forward.local, resolve);
  });
  servers.push(server);
}

function stop() {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
  for (const forward of forwards) rmSync(forward.local, { force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);

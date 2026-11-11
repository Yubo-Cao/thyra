import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { sshCommandArgv } from "../bridge/ssh-command";
import { readBodyBytes, RequestError } from "../utils/request";

/** Largest pasted image the bridge accepts. */
export const IMAGE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** Where uploads land on the host, local or reached over SSH. */
export const IMAGE_UPLOAD_DIRECTORY = "/tmp";

/**
 * Whether a path is one this handler gives a local upload: the directory and
 * a name it makes. Callers that take such a path back from a page use this,
 * so that a page cannot name any other file on the host.
 */
export function isUploadedImagePath(
  path: unknown,
  directory = IMAGE_UPLOAD_DIRECTORY,
): path is string {
  return (
    typeof path === "string" &&
    path.startsWith(`${directory}/`) &&
    /^herdr-img-\d{1,16}-[0-9a-f]{32}\.[a-z0-9]{1,16}$/.test(
      path.slice(directory.length + 1),
    )
  );
}

/**
 * Pasted images land in the host's temporary directory for the agent to
 * read. The name is unguessable and the file is created exclusively with
 * mode 0600, so another local user can neither read it nor plant it.
 */
export function createImageUploadHandler(args: {
  sshHost: () => string | undefined;
  /** Local destination directory; tests point it elsewhere. */
  directory?: string;
}) {
  const directory = args.directory ?? IMAGE_UPLOAD_DIRECTORY;
  return async function handleImageUpload(req: Request): Promise<Response> {
    try {
      const buf = await readBodyBytes(req, IMAGE_UPLOAD_MAX_BYTES);
      if (buf.length === 0) {
        return Response.json({ error: "empty body" }, { status: 400 });
      }
      const ext =
        (req.headers.get("x-image-ext") || "png")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 16) || "png";
      const name = `herdr-img-${Date.now()}-${randomBytes(16).toString("hex")}.${ext}`;
      const sshHost = args.sshHost();

      if (sshHost) {
        const remotePath = `${IMAGE_UPLOAD_DIRECTORY}/${name}`;
        // noclobber makes the redirect an exclusive create; `sh -c` keeps
        // that true whatever the remote login shell is.
        const proc = Bun.spawn(
          sshCommandArgv(
            sshHost,
            `sh -c 'umask 077; set -C; cat > ${remotePath}'`,
          ),
          {
            stdin: buf,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text();
          return Response.json(
            { error: `ssh upload failed: ${err.trim() || `exit ${code}`}` },
            { status: 502 },
          );
        }
        return Response.json({ path: remotePath, remote: true });
      }

      const localPath = `${directory}/${name}`;
      const file = await open(localPath, "wx", 0o600);
      try {
        await file.writeFile(buf);
      } finally {
        await file.close();
      }
      return Response.json({ path: localPath, remote: false });
    } catch (e) {
      if (e instanceof RequestError && e.status === 413) {
        return Response.json(
          { error: "image too large (>25MB)" },
          { status: 413 },
        );
      }
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  };
}

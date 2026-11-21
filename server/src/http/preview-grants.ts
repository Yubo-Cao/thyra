import type { Principal } from "../auth/principal";
import type { RawFileRoute } from "../connections/http-routing";

const GRANT_IDLE_MS = 120_000;

type Grant = {
  expires: number;
  connectionId: string;
  raw: RawFileRoute;
  directory: string;
  principal: Principal;
  address: string | null;
  origin: string | null;
};

/** The opaque HTML origin can use this credential only for preview GET/HEADs. */
export function createPreviewGrants(
  isSessionLive: (principal: Principal) => boolean,
) {
  const grants = new Map<string, Grant>();
  return {
    issue(grant: Omit<Grant, "expires" | "directory">) {
      const id = crypto.randomUUID().replaceAll("-", "");
      if (grants.size >= 1024) grants.delete(grants.keys().next().value!);
      grants.set(id, {
        ...grant,
        directory: grant.raw.path.slice(0, grant.raw.path.lastIndexOf("/") + 1),
        expires: Date.now() + GRANT_IDLE_MS,
      });
      return id;
    },
    authenticate(
      raw: RawFileRoute,
      connectionId: string | null,
      address: string | null,
      origin: string | null,
    ) {
      const grant = grants.get(raw.grant);
      if (
        !grant ||
        grant.expires <= Date.now() ||
        grant.connectionId !== connectionId ||
        grant.address !== address ||
        grant.origin !== origin ||
        grant.raw.workspaceId !== raw.workspaceId ||
        grant.raw.generation !== raw.generation ||
        grant.raw.scope !== raw.scope ||
        (raw.scope === "filesystem" && !raw.path.startsWith(grant.directory))
      )
        return null;
      if (!isSessionLive(grant.principal)) return null;
      grant.expires = Date.now() + GRANT_IDLE_MS;
      return grant;
    },
  };
}

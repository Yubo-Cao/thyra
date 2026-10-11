import { avatarBlob } from "./avatarImage";
import { saveCollaborationAvatar } from "./collaboration";
import { t } from "./i18n";

async function post(path: string, body: Blob | Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "content-type": body instanceof Blob ? body.type : "application/json",
    },
    body: body instanceof Blob ? body : JSON.stringify(body),
  });
  if (response.ok) return;
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(
    data.error || t("Request failed ({status})", { status: response.status }),
  );
}

/**
 * Set (or with null, remove) this person's picture: the account's when
 * signed in, else the one the bridge keeps for this person (direct local
 * use). Any picture is cropped to a square and scaled down first.
 */
export async function saveProfilePicture(
  account: boolean,
  file: Blob | null,
): Promise<void> {
  const picture = file ? await avatarBlob(file) : null;
  if (!account) return saveCollaborationAvatar(picture);
  await (picture
    ? post("/api/auth/avatar", picture)
    : post("/api/auth/avatar/remove", {}));
}

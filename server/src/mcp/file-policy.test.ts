import { describe, expect, test } from "bun:test";
import { createFilePolicy } from "./file-policy";

describe("MCP file policy", () => {
  const policy = createFilePolicy();

  test("denies secret files anywhere in the tree", () => {
    for (const path of [
      ".env",
      ".envrc",
      ".env.production.local",
      "app/.env",
      "tls/server.PEM",
      "certs/private.key",
      "id_rsa",
      "home/.ssh/config",
      ".ssh",
      ".aws/credentials",
      "gcp/service-account-prod.json",
      "infra/terraform.tfstate",
      "infra/terraform.tfstate.backup",
      ".npmrc",
      ".netrc",
      ".git/config",
      ".docker/config.json",
      ".config/gh/hosts.yml",
      ".config/thyra/auth-token",
    ]) {
      expect(policy.deniedBy(path)).not.toBeNull();
    }
  });

  test("allows ordinary source files", () => {
    for (const path of [
      "README.md",
      "src/env.ts",
      "src/keyboard.ts",
      "docs/credentials-guide.md",
      "docker/config.json",
      ".github/workflows/ci.yml",
      "src/config/settings.json",
    ]) {
      expect(policy.deniedBy(path)).toBeNull();
    }
  });

  test("extra patterns extend the defaults", () => {
    const custom = createFilePolicy(["*.sqlite", "private/", " "]);
    expect(custom.deniedBy("data/app.sqlite")).toBe("*.sqlite");
    expect(custom.deniedBy("private/notes.md")).toBe("private");
    expect(custom.deniedBy(".env")).toBe(".env*");
    expect(custom.deniedBy("public/notes.md")).toBeNull();
  });
});

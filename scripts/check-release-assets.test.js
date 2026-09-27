import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import {
  releaseAssetNames,
  verifyReleaseAssetNames,
} from "./check-release-assets.mjs";

describe("Thyra release boundary", () => {
  const names = releaseAssetNames("0.7.0");

  test("publishes exactly six Thyra targets, installers, and the Herdr pin", () => {
    expect(names).toHaveLength(41);
    expect(names).toContain("thyra-linux-x64.update.json");
    expect(names).toContain("thyra-v0.7.0-windows-arm64.tar.xz.sha256");
    expect(names).toContain("thyra-windows-x64.zip.sha256");
    expect(names).not.toContain("thyra-linux-x64.zip");
    for (const installerAsset of [
      "install.sh",
      "install.ps1",
      "herdr-release.json",
    ]) {
      expect(names).toContain(installerAsset);
    }
    expect(() => verifyReleaseAssetNames(names, "0.7.0")).not.toThrow();
    for (const extra of [
      "thyra-freebsd-x64.tar.xz",
      "thyra-linux-x64.tar.gz",
      "install-thyra.sh",
      "thyra-darwin-arm64.zip",
    ]) {
      expect(() => verifyReleaseAssetNames([...names, extra], "0.7.0")).toThrow(
        "unexpected",
      );
    }
  });

  test("rejects missing or wrong-version assets", () => {
    expect(() => verifyReleaseAssetNames(names.slice(1), "0.7.0")).toThrow(
      "missing",
    );
    expect(() => verifyReleaseAssetNames(names, "0.7.1")).toThrow("missing");
    expect(() => releaseAssetNames("../bad")).toThrow(
      "Invalid release version",
    );
  });

  test("the publish workflow enforces the boundary and installs only Thyra", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const publish = workflow.slice(workflow.indexOf("  publish:"));
    expect(publish).toContain(
      'node scripts/check-release-assets.mjs "${GITHUB_REF_NAME#v}"',
    );
    expect(publish).toContain("scripts/install.sh");
    expect(publish).toContain("scripts/install.ps1");
    expect(publish).toContain("server/src/herdr/herdr-release.json");
    expect(publish).toContain("--latest");
  });
});

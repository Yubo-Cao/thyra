import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { authorizeRpc, DENIED_RPC_METHODS, RPC_POLICY } from "./policy";

const ROOT = join(import.meta.dir, "..", "..", "..");
const METHOD = String.raw`[a-z_]+(?:\.[a-z_]+)+`;

/** Server modules that dispatch RPC methods by name. */
const SERVER_DISPATCHERS = [
  "server/src/index.ts",
  "server/src/bridge/settings-rpc.ts",
  "server/src/bridge/terminal-bridge.ts",
  "server/src/bridge/collaboration.ts",
  "server/src/launcher/service.ts",
];

/**
 * Template-literal calls in the web client (`call(\`integration.${x}\`)`)
 * cannot be read statically; list what each prefix expands to here.
 */
const DYNAMIC_WEB_CALLS: Record<string, string[]> = {
  "connections.": ["set_default", "connect", "disconnect", "test"],
  "integration.": ["install", "uninstall"],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}

function matches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), (match) =>
    match.slice(1).filter(Boolean),
  ).flat();
}

function serverMethods(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of SERVER_DISPATCHERS) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const method of matches(
      text,
      new RegExp(String.raw`method === "(${METHOD})"`, "g"),
    ))
      found.set(method, file);
    // Named method sets such as PANE_INPUT_METHODS.
    for (const block of matches(
      text,
      /_METHODS = new Set\(\[([\s\S]*?)\]\)/g,
    )) {
      for (const method of matches(block, new RegExp(`"(${METHOD})"`, "g")))
        found.set(method, file);
    }
  }
  return found;
}

function webMethods(): {
  methods: Map<string, string>;
  dynamic: Map<string, string>;
} {
  const methods = new Map<string, string>();
  const dynamic = new Map<string, string>();
  const patterns = [
    // call("x"), call<T>("x"), call(flag ? "x" : "y")
    new RegExp(
      String.raw`\bcall\s*(?:<[^>()]*>)?\(\s*(?:[\w.!]+\s*\?\s*)?["'](${METHOD})["'](?:\s*:\s*["'](${METHOD})["'])?`,
      "g",
    ),
    // { method: "x" } request descriptors and method === "x" gates.
    new RegExp(String.raw`\bmethod(?::| ===)\s*["'](${METHOD})["']`, "g"),
  ];
  for (const path of sourceFiles(join(ROOT, "web", "src"))) {
    const text = readFileSync(path, "utf8");
    const file = relative(ROOT, path);
    for (const pattern of patterns)
      for (const method of matches(text, pattern)) methods.set(method, file);
    for (const prefix of matches(
      text,
      /\bcall\s*(?:<[^>()]*>)?\(\s*`([a-z_.]+\.)\$\{/g,
    ))
      dynamic.set(prefix, file);
  }
  return { methods, dynamic };
}

function hasEntry(method: string) {
  return (
    Object.hasOwn(RPC_POLICY, method) ||
    Object.hasOwn(DENIED_RPC_METHODS, method)
  );
}

describe("RPC policy coverage", () => {
  test("every method the server dispatches has a policy entry", () => {
    const server = serverMethods();
    expect(server.size).toBeGreaterThan(40);
    const missing = [...server]
      .filter(([method]) => !hasEntry(method))
      .map(([method, file]) => `${method} (${file})`);
    expect(missing).toEqual([]);
  });

  test("every method the web client calls has a policy entry", () => {
    const { methods, dynamic } = webMethods();
    expect(methods.size).toBeGreaterThan(40);
    const unmapped = [...dynamic]
      .filter(([prefix]) => !DYNAMIC_WEB_CALLS[prefix])
      .map(([prefix, file]) => `${prefix}\${...} (${file})`);
    expect(unmapped).toEqual([]);
    for (const prefix of dynamic.keys())
      for (const suffix of DYNAMIC_WEB_CALLS[prefix] ?? [])
        methods.set(`${prefix}${suffix}`, dynamic.get(prefix) ?? "");
    const missing = [...methods]
      .filter(([method]) => !hasEntry(method))
      .map(([method, file]) => `${method} (${file})`);
    expect(missing).toEqual([]);
  });

  test("no method is both allowed and denied", () => {
    expect(
      Object.keys(DENIED_RPC_METHODS).filter((method) =>
        Object.hasOwn(RPC_POLICY, method),
      ),
    ).toEqual([]);
  });
});

describe("authorizeRpc", () => {
  test.each([
    "server.stop",
    "server.live_handoff",
    "plugin.enable",
    "integration.install",
    "agent.prompt",
  ])("denies the dangerous Herdr method %s with a reason", (method) => {
    const decision = authorizeRpc(method);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.message).toContain(method);
  });

  test.each([
    "workspace.get",
    "server.status",
    "toString",
    "__proto__",
    "constructor",
    "",
  ])("denies unlisted method %p by default", (method) => {
    expect(authorizeRpc(method).allowed).toBe(false);
  });

  test("allows listed methods for the owner", () => {
    for (const method of Object.keys(RPC_POLICY)) {
      expect(authorizeRpc(method).allowed).toBe(true);
    }
  });
});

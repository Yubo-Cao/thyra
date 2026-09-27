import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import postcss, { type Root, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
// TypeScript 7's main package no longer exports the in-process compiler API.
// Microsoft's compatibility package supplies it without replacing the project's tsc.
import ts from "@typescript/typescript6";
import defaultAllowlist from "./css-usage.allowlist.json";

export interface SourceFile {
  file: string;
  content: string;
}

export interface AllowlistEntry {
  prefix: string;
  reason: string;
}

export interface CssUsageOptions {
  /** Defaults to the repository containing this script, independent of cwd. */
  rootDir?: string;
  /** In-memory fixtures override discovery independently for CSS and usage. */
  cssFiles?: SourceFile[];
  usageFiles?: SourceFile[];
  allowlist?: AllowlistEntry[];
}

export interface UnusedCssClass {
  className: string;
  file: string;
  line: number;
  selector: string;
}

interface Candidates {
  tokens: Set<string>;
  prefixes: Set<string>;
  suffixes: Set<string>;
}

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const excludedCss = new Set([
  "web/src/styles/heroui.css",
  "web/src/styles/tokens.css",
]);
const generatedDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "generated",
  "__generated__",
]);

async function discover(rootDir: string) {
  const cssFiles: SourceFile[] = [];
  const usageFiles: SourceFile[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || generatedDirectories.has(entry.name))
        continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        /\.(?:css|tsx?)$/.test(entry.name) &&
        !/\.(?:gen|generated|min)\./.test(entry.name)
      ) {
        const file = relative(rootDir, path).replaceAll("\\", "/");
        if (excludedCss.has(file)) continue;
        const content = await readFile(path, "utf8");
        // Generated sources conventionally carry one of these header markers.
        if (
          /^\s*(?:\/\*|\/\/)[\s\S]{0,300}?(?:@generated|auto-generated|automatically generated)/i.test(
            content,
          )
        )
          continue;
        (file.endsWith(".css") ? cssFiles : usageFiles).push({ file, content });
      }
    }
  }
  await visit(resolve(rootDir, "web/src"));
  for (const file of ["web/index.html", "web/ui-gallery.html"]) {
    usageFiles.push({
      file,
      content: await readFile(resolve(rootDir, file), "utf8"),
    });
  }
  return { cssFiles, usageFiles };
}

function addFragment(
  candidates: Candidates,
  text: string,
  afterExpression = false,
  beforeExpression = false,
) {
  const tokens = text.split(/\s+/).filter(Boolean);
  for (const token of tokens) candidates.tokens.add(token);
  // Only the edge token can touch an expression; intervening whitespace breaks it.
  if (beforeExpression && text && !/\s$/.test(text))
    candidates.prefixes.add(tokens[tokens.length - 1]);
  if (afterExpression && text && !/^\s/.test(text))
    candidates.suffixes.add(tokens[0]);
}

function concatenationEdges(node: ts.Node) {
  let before = false;
  let after = false;
  let current = node;
  // Follow parentheses and complete chains, including a middle literal in a+b+c.
  while (current.parent) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)) {
      current = parent;
      continue;
    }
    if (
      !ts.isBinaryExpression(parent) ||
      parent.operatorToken.kind !== ts.SyntaxKind.PlusToken
    )
      break;
    if (parent.left === current) before = true;
    if (parent.right === current) after = true;
    current = parent;
  }
  return { before, after };
}

function collectCandidates(files: SourceFile[]): Candidates {
  const candidates: Candidates = {
    tokens: new Set(),
    prefixes: new Set(),
    suffixes: new Set(),
  };
  const scripts: SourceFile[] = [];
  for (const source of files) {
    if (!source.file.endsWith(".html")) {
      scripts.push(source);
      continue;
    }
    function visitHtml(node: DefaultTreeAdapterTypes.Node) {
      if ("attrs" in node) {
        const classes = node.attrs.find((attr) => attr.name === "class");
        if (classes) addFragment(candidates, classes.value);
        if (
          node.tagName === "script" &&
          !node.attrs.some((attr) => attr.name === "src")
        ) {
          scripts.push({
            file: `${source.file}.${scripts.length}.js`,
            content: node.childNodes
              .map((child) => ("value" in child ? child.value : ""))
              .join(""),
          });
        }
        if (node.tagName === "template" && "content" in node)
          visitHtml(node.content);
      }
      if ("childNodes" in node) node.childNodes.forEach(visitHtml);
    }
    visitHtml(parseHtml(source.content));
  }
  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const { before, after } = concatenationEdges(node);
      addFragment(candidates, node.text, after, before);
    } else if (ts.isTemplateExpression(node)) {
      const { before, after } = concatenationEdges(node);
      addFragment(candidates, node.head.text, after, true);
      node.templateSpans.forEach((span, index) => {
        addFragment(
          candidates,
          span.literal.text,
          true,
          index < node.templateSpans.length - 1 || before,
        );
      });
    }
    node.forEachChild(visit);
  }
  for (const source of scripts) {
    visit(
      ts.createSourceFile(
        source.file,
        source.content,
        ts.ScriptTarget.Latest,
        true,
      ),
    );
  }
  return candidates;
}

async function analyze(options: CssUsageOptions) {
  const rootDir = resolve(options.rootDir ?? repository);
  const discovered =
    options.cssFiles && options.usageFiles
      ? undefined
      : await discover(rootDir);
  const cssFiles = options.cssFiles ?? discovered!.cssFiles;
  const candidates = collectCandidates(
    options.usageFiles ?? discovered!.usageFiles,
  );
  const allowlist = options.allowlist ?? defaultAllowlist;
  for (const entry of allowlist) {
    if (!entry.prefix.trim() || !entry.reason.trim())
      throw new Error(
        "Every CSS allowlist entry needs a nonempty prefix and reason",
      );
  }
  const prefixes = [
    ...candidates.prefixes,
    ...allowlist.map((entry) => entry.prefix),
  ];
  const suffixes = [...candidates.suffixes];
  const isUsed = (name: string) =>
    candidates.tokens.has(name) ||
    prefixes.some((prefix) => name.startsWith(prefix)) ||
    suffixes.some((suffix) => name.endsWith(suffix));
  const unused: UnusedCssClass[] = [];
  const parsed = cssFiles.map((source) => {
    const root = postcss.parse(source.content, { from: source.file });
    const selectors = new Map<Rule, selectorParser.Root>();
    root.walkRules((rule) => {
      const selector = selectorParser().astSync(rule.selector);
      selectors.set(rule, selector);
      const seen = new Set<string>();
      selector.walkClasses((node) => {
        if (isUsed(node.value) || seen.has(node.value)) return;
        seen.add(node.value);
        unused.push({
          className: node.value,
          file: source.file,
          line:
            (rule.source?.start?.line ?? 1) +
            (node.source?.start?.line ?? 1) -
            1,
          selector: rule.selector,
        });
      });
    });
    return { source, root, selectors };
  });
  unused.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.className.localeCompare(b.className),
  );
  return { unused, parsed };
}

/** One result per unused class per rule, including classes inside pseudo-classes. */
export async function findUnusedCssClasses(
  options: CssUsageOptions = {},
): Promise<UnusedCssClass[]> {
  return (await analyze(options)).unused;
}

function pruneSelector(
  selector: selectorParser.Selector,
  isUsed: (name: string) => boolean,
): boolean {
  for (const node of [...selector.nodes]) {
    if (node.type === "class" && !isUsed(node.value)) return false;
    if (node.type !== "pseudo" || !node.nodes?.length) continue;
    for (const branch of [...node.nodes]) {
      if (!pruneSelector(branch, isUsed)) branch.remove();
    }
    if (!node.nodes.length) {
      // :not(.absent) matches everything; :is/:where/:has(.absent) match nothing.
      if (node.value.toLowerCase() !== ":not") return false;
      const index = selector.nodes.indexOf(node);
      const before = selector.nodes
        .slice(0, index)
        .findLast((item) => item.type !== "comment");
      const after = selector.nodes
        .slice(index + 1)
        .find((item) => item.type !== "comment");
      // Keep the universal's place in a combinator chain: .a > :not(.dead) > .b
      // must become .a > * > .b, never .a > > .b or .a > .b.
      if (
        (!before || before.type === "combinator") &&
        (!after || after.type === "combinator")
      )
        node.replaceWith(
          selectorParser.universal({ value: "*", spaces: node.spaces }),
        );
      else node.remove();
    }
  }
  if (!selector.nodes.length)
    selector.append(selectorParser.universal({ value: "*" }));
  return true;
}

function removeEmptyAtRules(root: Root) {
  let changed = false;
  const blocks: postcss.AtRule[] = [];
  root.walkAtRules((node) => {
    blocks.push(node);
  });
  for (const node of blocks.reverse()) {
    if (node.nodes?.every((child) => child.type === "comment")) {
      node.remove();
      changed = true;
    }
  }
  return changed;
}

/** Pure rewrite used by --fix and fixtures; callers decide whether to write files. */
export async function fixUnusedCssClasses(options: CssUsageOptions = {}) {
  const { unused, parsed } = await analyze(options);
  const dead = new Set(unused.map((entry) => entry.className));
  const changedFiles: SourceFile[] = [];
  for (const { source, root, selectors } of parsed) {
    let changed = false;
    for (const [rule, selector] of selectors) {
      let containsUnused = false;
      selector.walkClasses((node) => {
        if (dead.has(node.value)) containsUnused = true;
      });
      if (!containsUnused) continue;
      changed = true;
      for (const branch of [...selector.nodes]) {
        if (!pruneSelector(branch, (name) => !dead.has(name))) branch.remove();
      }
      if (!selector.nodes.length) rule.remove();
      else rule.selector = selector.toString();
    }
    changed = removeEmptyAtRules(root) || changed;
    // PostCSS may normalize even untouched comments while serializing. Only
    // rewrite sheets whose selectors or empty blocks actually changed.
    if (!changed) continue;
    const content = root.toString();
    if (content !== source.content)
      changedFiles.push({ file: source.file, content });
  }
  return { unused, changedFiles };
}

function report(unused: UnusedCssClass[]) {
  let previous = "";
  for (const entry of unused) {
    if (entry.file !== previous) console.log(`\n${entry.file}`);
    previous = entry.file;
    console.log(
      `  ${entry.line}: .${entry.className}  ${entry.selector.replaceAll(/\s+/g, " ")}`,
    );
  }
  console.log(
    `\n${new Set(unused.map((entry) => entry.className)).size} unused CSS classes.`,
  );
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => arg !== "--fix" && arg !== "--json")) {
    console.error("Usage: bun scripts/css-usage.ts [--fix] [--json]");
    process.exitCode = 2;
  } else if (args.has("--fix")) {
    const result = await fixUnusedCssClasses();
    for (const source of result.changedFiles) {
      await writeFile(resolve(repository, source.file), source.content);
    }
    if (result.changedFiles.length) {
      const formatter = Bun.spawnSync(
        [
          "mise",
          "exec",
          "bun@1.4.2",
          "--",
          "bunx",
          "biome",
          "format",
          "--write",
          ...result.changedFiles.map((source) => source.file),
        ],
        { cwd: repository, stdout: "pipe", stderr: "pipe" },
      );
      process.stderr.write(formatter.stdout);
      process.stderr.write(formatter.stderr);
      if (formatter.exitCode !== 0)
        throw new Error("Formatting CSS fixes failed");
    }
    if (args.has("--json")) console.log(JSON.stringify(result, null, 2));
    else {
      report(result.unused);
      console.log(`Fixed ${result.changedFiles.length} CSS files.`);
    }
  } else {
    const unused = await findUnusedCssClasses();
    if (args.has("--json")) console.log(JSON.stringify(unused, null, 2));
    else report(unused);
    if (unused.length) process.exitCode = 1;
  }
}

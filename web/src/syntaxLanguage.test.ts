import { describe, expect, test } from "bun:test";
import { codeLinesHtml, plainCodeHtml } from "./components/codeHighlight";
import { highlightToHtml } from "./components/codeHighlight.worker";
import { withoutStartAnchors } from "./shiki";
import { bundledLanguages, syntaxLanguageForPath } from "./syntaxLanguage";

const fixtures = [
  ["src/App.tsx", "tsx", "const answer: number = 42;"],
  ["src/index.ts", "typescript", "const answer: number = 42;"],
  ["tool.py", "python", 'print("hello")'],
  [
    "schema.proto",
    "protobuf",
    'syntax = "proto3";\nmessage User { string name = 1; }',
  ],
  ["app.rb", "ruby", 'class User\n  def name\n    "Ada"\n  end\nend'],
  ["app.php", "php", '<?php echo "hello";'],
  ["app.cs", "csharp", 'public class User { string name = "Ada"; }'],
  ["main.kt", "kotlin", 'fun main() { println("hello") }'],
  ["build.gradle", "groovy", 'plugins { id "java" }'],
  ["config.xml", "xml", '<user name="Ada" />'],
  ["config.ini", "ini", '[user]\nname = "Ada"'],
  ["worker.ps1", "powershell", 'Write-Host "hello"'],
  ["script.pl", "perl", 'my $name = "Ada";'],
  ["main.m", "objective-c", "@interface User : NSObject\n@end"],
  ["query.pgsql", "sql", "SELECT * FROM users WHERE id = 1;"],
  ["policy.csp", "csp", "default-src 'self'; script-src 'none';"],
  ["analysis.R", "r", 'print("hello")'],
  ["script.sh", "bash", 'echo "hello"'],
  ["config.yml", "yaml", 'name: "Ada"'],
  ["config/.env.local", "bash", 'NAME="Ada"'],
  ["containers/Containerfile", "dockerfile", 'FROM alpine\nRUN echo "hello"'],
  ["Dockerfile.dev", "dockerfile", "FROM alpine"],
  ["build/GNUmakefile", "makefile", 'all:\n\techo "hello"'],
  ["ios/Podfile", "ruby", 'platform :ios, "16.0"'],
  ["config/settings.toml", "toml", '[user]\nname = "Ada"'],
  ["/etc/nginx/site.conf", "nginx", "server { listen 80; }"],
  ["styles/theme.sass", "sass", "$color: red\nbody\n  color: $color"],
  ["src\\SERVICE.PROTO", "protobuf", "message User { string name = 1; }"],
  ["docs/README.MD", "markdown", "# Title\n\n*text*"],
  ["package.json", "json", '{ "name": "thyra" }'],
] as const;

describe("syntaxLanguageForPath", () => {
  test.each(fixtures)("resolves %s to %s", (path, language) => {
    expect(syntaxLanguageForPath(path)).toBe(language);
  });

  test("falls back to plain text", () => {
    for (const path of [
      "README",
      "LICENSE",
      "file.unknown",
      "file.txt",
      "file.constructor",
      ".gitignore",
    ]) {
      expect(syntaxLanguageForPath(path)).toBe("text");
    }
  });
});

describe("code highlighting", () => {
  test("rewrites only start anchors", () => {
    expect(withoutStartAnchors(String.raw`(^[\t ]+)?(\/\/)`, true)).toBe(
      String.raw`((?<![^])[\t ]+)?(\/\/)`,
    );
    expect(withoutStartAnchors(String.raw`[^a[^b]]\^(?<=^|\n)`, true)).toBe(
      String.raw`[^a[^b]]\^(?<=(?<![^])|\n)`,
    );
    expect(withoutStartAnchors(String.raw`[[^]^`, false)).toBe(
      String.raw`[[^](?<![^])`,
    );
  });

  test("renders escaped plain lines", () => {
    expect(plainCodeHtml("a < b\n\n&")).toBe(
      '<span class="line">a &lt; b</span>\n<span class="line"></span>\n<span class="line">&amp;</span>',
    );
    expect(
      codeLinesHtml([
        [{ content: "x", color: "var(--syntax-keyword)", fontStyle: 1 }],
      ]),
    ).toBe(
      '<span class="line"><span style="color:var(--syntax-keyword);font-style:italic">x</span></span>',
    );
  });

  test("colors tokens with theme variables", async () => {
    const text = 'const markup = "<tag>&"; // note\nconst answer: number = 42;';
    const html = await highlightToHtml(
      text,
      "typescript",
      (await bundledLanguages.typescript()).default,
    );
    expect(html.split("\n")).toHaveLength(2);
    expect(html).toContain("var(--syntax-keyword)");
    expect(html).toContain("var(--syntax-number)");
    expect(html).toContain("var(--syntax-comment)");
    expect(html).toContain("&lt;tag&gt;&amp;");
    expect(
      html
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    ).toBe(text);
  });

  test.each(Object.entries(bundledLanguages))(
    "loads %s with the JavaScript engine",
    async (language, load) => {
      const html = await highlightToHtml(
        "value = 42",
        language,
        (await load()).default,
      );
      expect(html).toStartWith('<span class="line">');
      for (const [path, expected, code] of fixtures) {
        if (expected !== language) continue;
        expect(syntaxLanguageForPath(path) in bundledLanguages).toBe(true);
        // Other grammars must not mask a loader's missing dependencies or aliases.
        expect(await highlightToHtml(code, language)).toContain(
          "var(--syntax-",
        );
      }
    },
  );
});

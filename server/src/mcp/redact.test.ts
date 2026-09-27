import { describe, expect, test } from "bun:test";
import { isSecretName, redactDeep, redactText } from "./redact";

// Fixtures are assembled at runtime so secret scanners do not flag this file.
const fake = (prefix: string, length: number, char = "a") =>
  `${prefix}${char.repeat(length)}`;

describe("redactText", () => {
  const cases: Array<[string, string, string]> = [
    [
      "OpenAI key",
      `run with ${fake("sk-proj-", 40)} now`,
      "run with [REDACTED:openai-key] now",
    ],
    [
      "Anthropic key",
      `key ${fake("sk-ant-api03-", 40)}`,
      "key [REDACTED:anthropic-key]",
    ],
    [
      "GitHub classic token",
      `token ${fake("ghp_", 36)} end`,
      "token [REDACTED:github-token] end",
    ],
    [
      "GitHub fine-grained token",
      fake("github_pat_", 60),
      "[REDACTED:github-token]",
    ],
    [
      "AWS access key id",
      `id ${fake("AKIA", 16, "B")}`,
      "id [REDACTED:aws-access-key]",
    ],
    ["Slack token", fake("xoxb-", 30, "1"), "[REDACTED:slack-token]"],
    [
      "bearer header",
      "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x",
      "curl -H 'Authorization: Bearer [REDACTED]' https://x",
    ],
    [
      "URL credentials",
      "https://deploy:hunter2secret@example.com/repo.git",
      "https://deploy:[REDACTED]@example.com/repo.git",
    ],
    [
      "Thyra MCP token",
      fake("thyra_mcp_0123abcd_", 43),
      "[REDACTED:thyra-token]",
    ],
    [
      "JWT",
      `${fake("eyJ", 20)}.${fake("eyJ", 20)}.${fake("", 20)}`,
      "[REDACTED:jwt]",
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(redactText(input)).toBe(expected);
    });
  }

  test("private key blocks, including a truncated block", () => {
    const block = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    expect(redactText(`before\n${block}\nafter`)).toBe(
      "before\n[REDACTED:private-key]\nafter",
    );
    expect(redactText("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nMIIE")).toBe(
      "x\n[REDACTED:private-key]",
    );
  });

  test("env-like assignments keep the name and hide the value", () => {
    expect(
      redactText(
        [
          "export DATABASE_PASSWORD=correct-horse",
          "AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMIK7MDENGbPxRfiCY",
          "STRIPE_KEY: 'abc123'",
          'OPENAI_API_KEY="plain-value"',
          "SECRET_KEY_BASE=deadbeef",
        ].join("\n"),
      ),
    ).toBe(
      [
        "export DATABASE_PASSWORD=[REDACTED]",
        "AWS_SECRET_ACCESS_KEY = [REDACTED]",
        "STRIPE_KEY: '[REDACTED]'",
        'OPENAI_API_KEY="[REDACTED]"',
        "SECRET_KEY_BASE=[REDACTED]",
      ].join("\n"),
    );
  });

  test("JSON secret fields are hidden", () => {
    expect(redactText('{"apiKey": "abc123", "client_secret":"s3cr3t"}')).toBe(
      '{"apiKey": "[REDACTED]", "client_secret":"[REDACTED]"}',
    );
  });

  test("references and metadata are left alone", () => {
    const text = [
      "PWD=/home/user PATH=/usr/bin",
      "DB_PASSWORD=$DB_PASS",
      "const token = process.env.GITHUB_TOKEN",
      '{"author": "Arthur", "token_count": 5, "total_tokens": 99}',
      "key: value",
      "max_tokens: 4096",
    ].join("\n");
    expect(redactText(text)).toBe(text);
  });

  test("an already redacted value is not re-marked", () => {
    expect(redactText(`OPENAI_API_KEY=${fake("sk-", 40)}`)).toBe(
      "OPENAI_API_KEY=[REDACTED:openai-key]",
    );
  });
});

describe("redactDeep", () => {
  test("walks nested values and withholds secret-named fields", () => {
    expect(
      redactDeep({
        session_id: "abc",
        secret_key: "zzz",
        nested: [`GITHUB_TOKEN=${fake("ghp_", 36)}`],
        count: 3,
      }),
    ).toEqual({
      session_id: "abc",
      secret_key: "[REDACTED]",
      nested: ["GITHUB_TOKEN=[REDACTED:github-token]"],
      count: 3,
    });
  });
});

describe("isSecretName", () => {
  test("classifies common identifiers", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "apiKey",
      "GITHUB_TOKEN",
      "accessToken",
      "db_password",
      "client_secret",
      "SECRET_KEY_BASE",
      "basic_auth",
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
    for (const name of [
      "key",
      "author",
      "token_count",
      "max_tokens",
      "PWD",
      "session_id",
      "password_file",
      "auth",
    ]) {
      expect(isSecretName(name)).toBe(false);
    }
  });
});

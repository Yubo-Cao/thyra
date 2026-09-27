import { describe, expect, test } from "bun:test";
import { BridgeError, type BridgeErrorCode } from "./bridgeError";
import { installCatalog, t } from "./i18n";
import zhCN from "./locales/zh-CN";
import { isReconnectRetryableError } from "./reconnectRetry";

const RETRYABLE: [BridgeErrorCode, string][] = [
  ["not_connected", "not connected to bridge"],
  ["hello_unavailable", "bridge hello is unavailable"],
  [
    "runtime_generation_unavailable",
    "connection runtime generation is unavailable",
  ],
  ["connection_changed", "connection changed during request"],
  ["disconnected", "bridge disconnected"],
  ["connect_timeout", "bridge connection timed out"],
  ["handshake_timeout", "bridge hello timed out"],
  ["heartbeat_timeout", "bridge heartbeat timed out"],
];

const NOT_RETRYABLE: [BridgeErrorCode, string][] = [
  ["timeout", "timeout: workspace.focus"],
  ["paused", "bridge connection paused"],
  ["logged_out", "logged out"],
  ["send_buffer_full", "bridge send buffer is full"],
  ["protocol", "invalid error response"],
  ["rpc", "workspace not found"],
];

describe("isReconnectRetryableError", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    test(`decides by code, not by ${locale} message text`, () => {
      installCatalog(locale, locale === "zh-CN" ? zhCN : {});
      try {
        for (const [code, source] of RETRYABLE) {
          const error = new BridgeError(code, t(source));
          if (locale === "zh-CN") expect(error.message).not.toBe(source);
          expect(isReconnectRetryableError(error)).toBe(true);
        }
        for (const [code, source] of NOT_RETRYABLE) {
          const error = new BridgeError(code, t(source));
          expect(isReconnectRetryableError(error)).toBe(false);
        }
      } finally {
        installCatalog("en", {});
      }
    });
  }

  test("ignores untyped errors even when their text looks retryable", () => {
    for (const message of [
      "",
      "bridge disconnected",
      "not connected to bridge",
    ])
      expect(isReconnectRetryableError(new Error(message))).toBe(false);
    expect(isReconnectRetryableError("bridge disconnected")).toBe(false);
  });
});

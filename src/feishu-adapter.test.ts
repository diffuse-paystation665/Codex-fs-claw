import assert from "node:assert/strict";
import test from "node:test";

import { shouldRetryFeishuSend } from "./feishu-adapter.js";

test("shouldRetryFeishuSend retries transient network errors", () => {
  assert.equal(
    shouldRetryFeishuSend({
      code: "ECONNRESET",
      message: "Client network socket disconnected before secure TLS connection was established",
    }),
    true,
  );
});

test("shouldRetryFeishuSend retries Feishu throttling", () => {
  assert.equal(
    shouldRetryFeishuSend({
      response: {
        status: 429,
      },
      message: "Too many requests",
    }),
    true,
  );
});

test("shouldRetryFeishuSend does not retry permanent request errors", () => {
  assert.equal(
    shouldRetryFeishuSend({
      response: {
        status: 400,
      },
      message: "Bad request",
    }),
    false,
  );
});

test("shouldRetryFeishuSend retries transient token acquisition failures", () => {
  assert.equal(
    shouldRetryFeishuSend({
      message:
        "Cannot destructure property 'tenant_access_token' of '(intermediate value)' as it is undefined.",
    }),
    true,
  );
});

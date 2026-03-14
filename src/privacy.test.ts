import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAuditDetails, sanitizeStoredText } from "./privacy.js";

test("sanitizeStoredText redacts secret-like values and truncates long text", () => {
  const result = sanitizeStoredText(
    "token=abcdefghijklmnopqrstuvwxyz1234567890 and this is a much longer body that should be shortened",
    40,
  );

  assert.equal(result, "token=[redacted] and this is a much long...");
});

test("sanitizeAuditDetails redacts sensitive keys recursively", () => {
  const result = sanitizeAuditDetails({
    request: {
      appSecret: "super-secret-value",
      payload: "authorization=Bearer abcdefghijklmnopqrstuvwxyz123456",
    },
  }) as {
    request: {
      appSecret: string;
      payload: string;
    };
  };

  assert.equal(result.request.appSecret, "[redacted]");
  assert.match(result.request.payload, /\[redacted\]/);
});

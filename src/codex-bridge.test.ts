import assert from "node:assert/strict";
import test from "node:test";

import { isKnownWindowsReadOnlyIssueMessage } from "./codex-bridge.js";

test("isKnownWindowsReadOnlyIssueMessage matches the Windows restricted sandbox failure", () => {
  assert.equal(
    isKnownWindowsReadOnlyIssueMessage(
      "windows sandbox: Restricted read-only access is not yet supported by the Windows sandbox backend",
    ),
    true,
  );
});

test("isKnownWindowsReadOnlyIssueMessage ignores unrelated failures", () => {
  assert.equal(
    isKnownWindowsReadOnlyIssueMessage("Model overloaded, please retry later."),
    false,
  );
});

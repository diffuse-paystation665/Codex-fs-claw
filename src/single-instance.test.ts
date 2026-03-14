import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Logger } from "./logger.js";
import { acquireSingleInstanceLock } from "./single-instance.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-lock-"));
}

test("acquireSingleInstanceLock blocks a second active instance", async () => {
  const tempDir = createTempDir();
  const logger = new Logger("lock-test", "error");
  const first = await acquireSingleInstanceLock(
    tempDir,
    {
      cwd: tempDir,
      serviceName: "test-service",
      sessionMode: "operator",
      controlScope: "computer",
    },
    logger,
  );

  await assert.rejects(
    acquireSingleInstanceLock(
      tempDir,
      {
        cwd: tempDir,
        serviceName: "test-service",
        sessionMode: "operator",
        controlScope: "computer",
      },
      logger,
    ),
    /already running/i,
  );

  await first.release();
});

test("acquireSingleInstanceLock removes a stale lock file", async () => {
  const tempDir = createTempDir();
  const logger = new Logger("lock-test", "error");
  const lockPath = path.join(tempDir, "bridge.lock");

  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      {
        pid: 999999,
        acquiredAt: "2026-03-13T00:00:00.000Z",
        cwd: tempDir,
        serviceName: "stale-service",
        sessionMode: "operator",
        controlScope: "computer",
      },
      null,
      2,
    ),
  );

  const lock = await acquireSingleInstanceLock(
    tempDir,
    {
      cwd: tempDir,
      serviceName: "fresh-service",
      sessionMode: "operator",
      controlScope: "computer",
    },
    logger,
  );

  const contents = fs.readFileSync(lockPath, "utf8");
  assert.match(contents, /fresh-service/);

  await lock.release();
});

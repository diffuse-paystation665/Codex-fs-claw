import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { SessionStore } from "./session-store.js";

test("SessionStore migrates legacy session rows and preserves new delivery fields", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-bridge-"));
  const dbPath = path.join(tempDir, "bridge.db");
  const legacyDb = new DatabaseSync(dbPath);

  legacyDb.exec(`
    CREATE TABLE sessions (
      open_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      last_result TEXT,
      last_turn_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  legacyDb
    .prepare(`
      INSERT INTO sessions (open_id, thread_id, last_result, last_turn_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      "ou_legacy",
      "thread-1",
      "old result",
      "turn-1",
      "2026-03-13T00:00:00.000Z",
    );
  legacyDb.close();

  const store = new SessionStore(tempDir);
  const legacySession = store.getSession("ou_legacy");

  assert.ok(legacySession);
  assert.equal(legacySession?.bridgeVersion, "");
  assert.equal(legacySession?.lastDeliveryStatus, "unknown");
  assert.equal(legacySession?.lastDeliveryAttempts, 0);

  store.upsertSession({
    openId: "ou_legacy",
    threadId: "thread-2",
    bridgeVersion: "bridge-v2",
    lastResult:
      "fresh result with a token=abcdefghijklmnopqrstuvwxyz123456 that should not persist fully",
    lastTurnId: "turn-2",
    lastDeliveryStatus: "failed",
    lastDeliveryError: "socket reset while sending app_secret=super-secret-value",
    lastDeliveryAttempts: 3,
    updatedAt: "2026-03-13T01:00:00.000Z",
  });

  const updatedSession = store.getSession("ou_legacy");
  assert.equal(updatedSession?.threadId, "thread-2");
  assert.equal(updatedSession?.bridgeVersion, "bridge-v2");
  assert.equal(updatedSession?.lastDeliveryStatus, "failed");
  assert.equal(updatedSession?.lastDeliveryAttempts, 3);
  assert.match(updatedSession?.lastResult ?? "", /\[redacted\]/);
  assert.match(updatedSession?.lastDeliveryError ?? "", /\[redacted\]/);
});

test("SessionStore can redact stored approval details after execution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-approval-"));
  const store = new SessionStore(tempDir);

  store.createApproval({
    id: "approve01",
    openId: "ou_approval",
    threadId: "thread-1",
    kind: "risk-gate",
    status: "pending",
    originalMessage: "帮我在当前目录创建 secret.txt",
    summary: "将会创建一个文件。",
    prompt: "帮我在当前目录创建 secret.txt",
    requestMethod: "exec_command",
    requestPayloadJson: "{\"cmd\":\"mkdir secret\"}",
    createdAt: "2026-03-14T00:00:00.000Z",
    updatedAt: "2026-03-14T00:00:00.000Z",
    expiresAt: "2026-03-14T00:30:00.000Z",
  });

  store.updateApprovalStatus("approve01", "approved");
  store.redactApprovalDetails("approve01");

  const approval = store.getApproval("approve01");
  assert.equal(approval?.status, "approved");
  assert.equal(approval?.originalMessage, null);
  assert.equal(approval?.prompt, null);
  assert.equal(approval?.requestMethod, null);
  assert.equal(approval?.requestPayloadJson, null);
  assert.equal(approval?.summary, "将会创建一个文件。");
});

test("SessionStore stores advanced cron jobs and run history", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-codex-cron-"));
  const store = new SessionStore(tempDir);

  store.createCronJob({
    id: "cronjob1",
    openId: "ou_cron",
    chatId: "oc_chat",
    name: "每周巡检",
    prompt: "帮我总结工作区变化",
    scheduleKind: "weekly",
    scheduleConfigJson:
      "{\"kind\":\"weekly\",\"weekdays\":[\"MON\",\"FRI\"],\"time\":\"09:00\"}",
    scheduleLabel: "每周 周一、周五 09:00",
    scheduleTime: "09:00",
    status: "active",
    nextRunAt: "2026-03-16T01:00:00.000Z",
    retryAttempt: 0,
    maxRetries: 2,
    retryBaseMinutes: 5,
    lastRunAt: null,
    lastRunStatus: null,
    lastDeliveryStatus: "unknown",
    updatedAt: "2026-03-14T00:00:00.000Z",
  });

  const jobs = store.listCronJobs("ou_cron");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.scheduleKind, "weekly");
  assert.equal(jobs[0]?.scheduleLabel, "每周 周一、周五 09:00");

  store.createCronRun({
    id: "cronrun1",
    jobId: "cronjob1",
    openId: "ou_cron",
    status: "succeeded",
    attempt: 1,
    scheduledFor: "2026-03-16T01:00:00.000Z",
    startedAt: "2026-03-16T01:00:02.000Z",
    finishedAt: "2026-03-16T01:00:04.000Z",
    deliveryStatus: "delivered",
    summary: "今天没有重要改动",
    error: null,
    approvalId: null,
    updatedAt: "2026-03-16T01:00:04.000Z",
  });

  const runs = store.listCronRuns("ou_cron", "cronjob1", 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "succeeded");
  assert.equal(runs[0]?.summary, "今天没有重要改动");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCronJobName,
  buildDailySchedule,
  buildHourlySchedule,
  buildWeeklySchedule,
  computeNextDailyRunIso,
  computeNextRunIso,
  computeRetryRunIso,
  describeCronSchedule,
  hydrateCronSchedule,
  looksLikeNaturalCronIntent,
  normalizeDailyTime,
  parseNaturalLanguageCron,
  serializeCronSchedule,
} from "./cron.js";

test("normalizeDailyTime normalizes valid times", () => {
  assert.equal(normalizeDailyTime("9:05"), "09:05");
  assert.equal(normalizeDailyTime("23:59"), "23:59");
  assert.equal(normalizeDailyTime("24:00"), null);
});

test("parseNaturalLanguageCron handles every day morning time", () => {
  assert.deepEqual(
    parseNaturalLanguageCron("每天早上9点帮我总结当前工作目录里有什么变化"),
    {
      schedule: { kind: "daily", time: "09:00" },
      prompt: "帮我总结当前工作目录里有什么变化",
    },
  );
});

test("describeCronSchedule formats weekly and hourly schedules", () => {
  assert.equal(
    describeCronSchedule(buildWeeklySchedule(["MON", "FRI"], "09:30")!),
    "每周 周一、周五 09:30",
  );
  assert.equal(
    describeCronSchedule(buildHourlySchedule(2, "2026-03-14T01:15:00.000Z")!),
    "每隔 2 小时",
  );
});

test("computeNextDailyRunIso rolls to the next day when time has passed", () => {
  const now = new Date("2026-03-14T10:30:00+08:00");
  const next = new Date(computeNextDailyRunIso("09:00", now));

  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 2);
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test("computeNextRunIso supports weekly schedules", () => {
  const schedule = buildWeeklySchedule(["MON", "FRI"], "09:30")!;
  const next = new Date(computeNextRunIso(schedule, new Date("2026-03-13T09:31:00+08:00")));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test("computeNextRunIso supports hourly schedules", () => {
  const schedule = buildHourlySchedule(2, "2026-03-14T01:15:00.000Z")!;
  const next = computeNextRunIso(schedule, new Date("2026-03-14T05:20:00.000Z"));
  assert.equal(next, "2026-03-14T07:15:00.000Z");
});

test("computeRetryRunIso applies exponential backoff in minutes", () => {
  const now = new Date("2026-03-14T10:00:00Z");
  const next = new Date(computeRetryRunIso(5, 3, now));
  assert.equal(next.toISOString(), "2026-03-14T10:20:00.000Z");
});

test("serializeCronSchedule round-trips weekly schedules", () => {
  const serialized = serializeCronSchedule(buildWeeklySchedule(["MON", "WED"], "18:00")!);
  const hydrated = hydrateCronSchedule({
    scheduleKind: serialized.scheduleKind,
    scheduleConfigJson: serialized.scheduleConfigJson,
    scheduleTime: serialized.scheduleTime,
  });

  assert.deepEqual(hydrated, {
    kind: "weekly",
    weekdays: ["MON", "WED"],
    time: "18:00",
  });
});

test("looksLikeNaturalCronIntent catches schedule-like language", () => {
  assert.equal(looksLikeNaturalCronIntent("每周五下午六点帮我总结本周改动"), true);
  assert.equal(looksLikeNaturalCronIntent("帮我看看当前目录"), false);
});

test("buildCronJobName truncates long prompts", () => {
  assert.equal(
    buildCronJobName("帮我总结当前工作目录和 Git 变更并输出摘要，同时附带关键风险提示和下一步建议"),
    "帮我总结当前工作目录和 Git 变更并输出摘要，...",
  );
});

test("buildDailySchedule rejects invalid input", () => {
  assert.equal(buildDailySchedule("25:00"), null);
});

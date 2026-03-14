import assert from "node:assert/strict";
import test from "node:test";

import { assessRisk, parseControlCommand } from "./risk.js";

test("parseControlCommand extracts approval ids", () => {
  assert.deepEqual(parseControlCommand("/approve abc123"), {
    type: "approve",
    approvalId: "abc123",
  });
});

test("parseControlCommand handles commands without ids", () => {
  assert.deepEqual(parseControlCommand("/status"), { type: "status" });
});

test("parseControlCommand handles local skill list", () => {
  assert.deepEqual(parseControlCommand("/skill list"), {
    type: "skill-list",
    source: "local",
  });
});

test("parseControlCommand handles natural local skill list", () => {
  assert.deepEqual(parseControlCommand("帮我看看本机有哪些技能"), {
    type: "skill-list",
    source: "local",
  });
});

test("parseControlCommand handles natural curated skill list", () => {
  assert.deepEqual(parseControlCommand("帮我列一下官方 skill"), {
    type: "skill-list",
    source: "curated",
  });
});

test("parseControlCommand handles curated skill install", () => {
  assert.deepEqual(parseControlCommand("/skill install playwright"), {
    type: "skill-install",
    spec: { source: "curated", name: "playwright" },
  });
});

test("parseControlCommand handles natural curated skill install", () => {
  assert.deepEqual(parseControlCommand("给我装一个 playwright skill"), {
    type: "skill-install",
    spec: { source: "curated", name: "playwright" },
  });
});

test("parseControlCommand handles natural experimental skill install", () => {
  assert.deepEqual(parseControlCommand("帮我安装 experimental imagegen skill"), {
    type: "skill-install",
    spec: { source: "experimental", name: "imagegen" },
  });
});

test("parseControlCommand handles github skill install url", () => {
  assert.deepEqual(
    parseControlCommand(
      "/skill install url https://github.com/openai/skills/tree/main/skills/.experimental/playwright",
    ),
    {
      type: "skill-install",
      spec: {
        source: "url",
        url: "https://github.com/openai/skills/tree/main/skills/.experimental/playwright",
      },
    },
  );
});

test("parseControlCommand handles natural github skill install url", () => {
  assert.deepEqual(
    parseControlCommand(
      "帮我安装这个 skill https://github.com/openai/skills/tree/main/skills/.experimental/playwright",
    ),
    {
      type: "skill-install",
      spec: {
        source: "url",
        url: "https://github.com/openai/skills/tree/main/skills/.experimental/playwright",
      },
    },
  );
});

test("parseControlCommand handles Chinese approve commands", () => {
  assert.deepEqual(parseControlCommand("批准 d42cc8ee"), {
    type: "approve",
    approvalId: "d42cc8ee",
  });
});

test("parseControlCommand handles Chinese reject commands", () => {
  assert.deepEqual(parseControlCommand("拒绝 d42cc8ee"), {
    type: "reject",
    approvalId: "d42cc8ee",
  });
});

test("parseControlCommand handles cron add", () => {
  assert.deepEqual(parseControlCommand("/cron add 09:00 帮我总结工作区变化"), {
    type: "cron-add",
    scheduleTime: "09:00",
    schedule: null,
    prompt: "帮我总结工作区变化",
  });
});

test("parseControlCommand handles Chinese cron list", () => {
  assert.deepEqual(parseControlCommand("定时 列表"), {
    type: "cron-list",
  });
});

test("parseControlCommand handles natural language daily cron", () => {
  assert.deepEqual(
    parseControlCommand("每天早上9点帮我总结当前工作目录里有什么变化"),
    {
      type: "cron-add",
      scheduleTime: "09:00",
      schedule: { kind: "daily", time: "09:00" },
      prompt: "帮我总结当前工作目录里有什么变化",
    },
  );
});

test("assessRisk marks mutating requests as approval required", () => {
  const result = assessRisk("Please create a file and run npm install.");
  assert.equal(result.level, "approval-required");
  assert.ok(result.triggers.includes("write-file"));
  assert.ok(result.triggers.includes("package-manager"));
});

test("assessRisk keeps simple questions safe", () => {
  const result = assessRisk("请总结一下当前目录里有哪些文件");
  assert.equal(result.level, "safe");
});

test("assessRisk catches high-risk Chinese command requests", () => {
  const result = assessRisk("帮我执行 powershell 命令并创建一个文件");
  assert.equal(result.level, "approval-required");
  assert.ok(result.triggers.includes("shell-command"));
  assert.ok(result.triggers.includes("write-file"));
});

test("assessRisk catches desktop control requests", () => {
  const result = assessRisk("帮我打开记事本，然后启动浏览器");
  assert.equal(result.level, "approval-required");
  assert.ok(result.triggers.includes("desktop-control"));
});

test("assessRisk catches creating a folder in Chinese", () => {
  const result = assessRisk("帮我新建一个文件夹 codex机器人");
  assert.equal(result.level, "approval-required");
  assert.ok(result.triggers.includes("write-file"));
});

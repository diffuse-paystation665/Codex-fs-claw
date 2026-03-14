import type { ControlCommand, RiskAssessment } from "./types.js";
import { parseNaturalLanguageCron } from "./cron.js";

const CONTROL_PATTERNS: Array<{
  pattern: RegExp;
  build(match: RegExpMatchArray): ControlCommand;
}> = [
  {
    pattern: /^\/status\b/i,
    build: () => ({ type: "status" }),
  },
  {
    pattern: /^\/reset\b/i,
    build: () => ({ type: "reset" }),
  },
  {
    pattern: /^\/skill\s+list(?:\s+(local|curated|experimental))?\b/i,
    build: (match) => ({ type: "skill-list", source: (match[1] as "local" | "curated" | "experimental" | undefined) ?? "local" }),
  },
  {
    pattern: /^技能\s+列表(?:\s+(本地|官方|实验))?/i,
    build: (match) => ({
      type: "skill-list",
      source:
        match[1] === "官方"
          ? "curated"
          : match[1] === "实验"
            ? "experimental"
            : "local",
    }),
  },
  {
    pattern: /^\/skill\s+install\s+experimental\s+([A-Za-z0-9._-]+)\b/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "experimental", name: match[1] },
    }),
  },
  {
    pattern: /^\/skill\s+install\s+url\s+(https:\/\/github\.com\/\S+)\s*$/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "url", url: match[1] },
    }),
  },
  {
    pattern: /^\/skill\s+install\s+repo\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+(\S+)(?:\s+--ref\s+(\S+))?(?:\s+--name\s+(\S+))?\s*$/i,
    build: (match) => ({
      type: "skill-install",
      spec: {
        source: "repo",
        repo: match[1],
        path: match[2],
        ref: match[3] ?? null,
        name: match[4] ?? null,
      },
    }),
  },
  {
    pattern: /^\/skill\s+install\s+([A-Za-z0-9._-]+)\b/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "curated", name: match[1] },
    }),
  },
  {
    pattern: /^技能\s+安装\s+实验\s+([A-Za-z0-9._-]+)\b/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "experimental", name: match[1] },
    }),
  },
  {
    pattern: /^技能\s+安装\s+链接\s+(https:\/\/github\.com\/\S+)\s*$/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "url", url: match[1] },
    }),
  },
  {
    pattern: /^技能\s+安装\s+([A-Za-z0-9._-]+)\b/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "curated", name: match[1] },
    }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:看看|查看|列一下|列出|告诉我).*(?:本地|本机|已安装).*(?:skills?|技能)/i,
    build: () => ({ type: "skill-list", source: "local" }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:看看|查看|列一下|列出|告诉我).*(?:官方|curated).*(?:skills?|技能)/i,
    build: () => ({ type: "skill-list", source: "curated" }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:看看|查看|列一下|列出|告诉我).*(?:实验|experimental).*(?:skills?|技能)/i,
    build: () => ({ type: "skill-list", source: "experimental" }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:看看|查看|列一下|列出|告诉我).*(?:skills?|技能).*(?:有哪些|有什么|列表)/i,
    build: () => ({ type: "skill-list", source: "local" }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:装|安装|加装|装上)(?:一个|一下)?\s*experimental\s+([A-Za-z0-9._-]+)\s*(?:skills?|技能)?[。！!？?]?$/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "experimental", name: match[1] },
    }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:装|安装|加装|装上).*(https:\/\/github\.com\/\S+)\s*$/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "url", url: match[1] },
    }),
  },
  {
    pattern: /^(?:帮我|给我|麻烦)?(?:装|安装|加装|装上)(?:一个|一下)?\s*([A-Za-z0-9._-]+)\s*(?:skills?|技能)?[。！!？?]?$/i,
    build: (match) => ({
      type: "skill-install",
      spec: { source: "curated", name: match[1] },
    }),
  },
  {
    pattern: /^\/approve(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "approve", approvalId: match[1] ?? null }),
  },
  {
    pattern: /^\/reject(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "reject", approvalId: match[1] ?? null }),
  },
  {
    pattern: /^(?:批准|同意|通过)\s+([A-Za-z0-9_-]+)\b/i,
    build: (match) => ({ type: "approve", approvalId: match[1] ?? null }),
  },
  {
    pattern: /^(?:拒绝|取消|驳回)\s+([A-Za-z0-9_-]+)\b/i,
    build: (match) => ({ type: "reject", approvalId: match[1] ?? null }),
  },
  {
    pattern: /^\/cron\s+add\s+(\d{1,2}:\d{2})\s+(.+)$/i,
    build: (match) => ({
      type: "cron-add",
      scheduleTime: match[1],
      schedule: null,
      prompt: match[2].trim(),
    }),
  },
  {
    pattern: /^定时\s+(?:新增|创建)\s+(\d{1,2}:\d{2})\s+(.+)$/i,
    build: (match) => ({
      type: "cron-add",
      scheduleTime: match[1],
      schedule: null,
      prompt: match[2].trim(),
    }),
  },
  {
    pattern: /^\/cron\s+list\b/i,
    build: () => ({ type: "cron-list" }),
  },
  {
    pattern: /^定时\s+列表/i,
    build: () => ({ type: "cron-list" }),
  },
  {
    pattern: /^\/cron\s+pause(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "cron-pause", jobId: match[1] ?? null }),
  },
  {
    pattern: /^定时\s+暂停(?:\s+([A-Za-z0-9_-]+))?/i,
    build: (match) => ({ type: "cron-pause", jobId: match[1] ?? null }),
  },
  {
    pattern: /^\/cron\s+resume(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "cron-resume", jobId: match[1] ?? null }),
  },
  {
    pattern: /^定时\s+恢复(?:\s+([A-Za-z0-9_-]+))?/i,
    build: (match) => ({ type: "cron-resume", jobId: match[1] ?? null }),
  },
  {
    pattern: /^\/cron\s+(?:delete|remove)(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "cron-delete", jobId: match[1] ?? null }),
  },
  {
    pattern: /^定时\s+删除(?:\s+([A-Za-z0-9_-]+))?/i,
    build: (match) => ({ type: "cron-delete", jobId: match[1] ?? null }),
  },
  {
    pattern: /^\/cron\s+history(?:\s+([A-Za-z0-9_-]+))?\b/i,
    build: (match) => ({ type: "cron-history", jobId: match[1] ?? null }),
  },
  {
    pattern: /^定时\s+历史(?:\s+([A-Za-z0-9_-]+))?/i,
    build: (match) => ({ type: "cron-history", jobId: match[1] ?? null }),
  },
];

const RISK_RULES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "shell-command",
    pattern:
      /\b(run|execute|powershell|cmd|bash|shell|terminal|command)\b|运行|执行|命令|终端|控制台|脚本/i,
  },
  {
    label: "write-file",
    pattern:
      /\b(create|write|edit|modify|update|append|replace|patch|rename|mkdir|md)\b|创建|新建|写入|编辑|修改|更新|追加|替换|补丁|重命名|建一个|建个/i,
  },
  {
    label: "delete-file",
    pattern: /\b(delete|remove|rm|del|erase)\b|删除|移除|清空/i,
  },
  {
    label: "package-manager",
    pattern: /\b(npm|pnpm|yarn|pip|uv|cargo|go get|brew)\b|安装依赖|装包/i,
  },
  {
    label: "version-control",
    pattern:
      /\b(git commit|git push|git checkout|git reset|git clean)\b|提交代码|推送代码|切换分支|重置仓库/i,
  },
  {
    label: "system-change",
    pattern:
      /\b(install|uninstall|registry|scheduled task|service)\b|安装软件|卸载软件|注册表|计划任务|服务/i,
  },
  {
    label: "desktop-control",
    pattern:
      /\b(open|launch|start)\s+(app|application|program|process|browser|terminal|powershell|cmd|notepad)\b|\b(taskkill|shutdown|restart)\b|打开(?:应用|程序|浏览器|终端|命令行|powershell|cmd|记事本)|启动(?:应用|程序|浏览器|终端|命令行|powershell|cmd|记事本)|(?:结束|关闭)进程|关机|重启/i,
  },
];

export function parseControlCommand(input: string): ControlCommand | null {
  const text = input.trim();

  for (const item of CONTROL_PATTERNS) {
    const match = text.match(item.pattern);
    if (match) {
      return item.build(match);
    }
  }

  const naturalCron = parseNaturalLanguageCron(text);
  if (naturalCron) {
    return {
      type: "cron-add",
      scheduleTime: naturalCron.schedule.kind === "daily" ? naturalCron.schedule.time : null,
      schedule: naturalCron.schedule,
      prompt: naturalCron.prompt,
    };
  }

  return null;
}

export function assessRisk(input: string): RiskAssessment {
  const triggers = RISK_RULES.filter((rule) => rule.pattern.test(input)).map(
    (rule) => rule.label,
  );

  return triggers.length === 0
    ? { level: "safe", triggers: [] }
    : { level: "approval-required", triggers };
}

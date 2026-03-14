import crypto from "node:crypto";

import { ApprovalGate } from "./approval-gate.js";
import { CodexBridge } from "./codex-bridge.js";
import { type AppConfig } from "./config.js";
import { CronScheduler } from "./cron-scheduler.js";
import {
  buildCronJobName,
  buildDailySchedule,
  computeNextRunIso,
  computeRetryRunIso,
  formatLocalDateTime,
  hydrateCronSchedule,
  looksLikeNaturalCronIntent,
  serializeCronSchedule,
} from "./cron.js";
import { FeishuAdapter, FeishuSendError } from "./feishu-adapter.js";
import { Logger } from "./logger.js";
import { sanitizeStoredText, truncateText } from "./privacy.js";
import { assessRisk, parseControlCommand } from "./risk.js";
import { SessionStore } from "./session-store.js";
import { SkillManager, SkillManagerError } from "./skill-manager.js";
import type {
  ApprovalRecord,
  ControlCommand,
  CronJobRecord,
  CronRunRecord,
  CronSchedule,
  DeliveryStatus,
  InboundChatMessage,
  LiveApprovalRequest,
  SessionRecord,
  SkillCatalogEntry,
  SkillInstallSpec,
} from "./types.js";

function summarizeApproval(record: ApprovalRecord, header?: string): string {
  const lines = header ? [header, `审批编号: ${record.id}`] : [`审批编号: ${record.id}`];
  if (record.summary) {
    lines.push(record.summary.trim());
  }
  lines.push(`回复 /approve ${record.id} 继续，或 /reject ${record.id} 取消。`);
  return lines.join("\n\n");
}

function formatDeliveryStatus(status: DeliveryStatus): string {
  switch (status) {
    case "delivered":
      return "已送达";
    case "failed":
      return "回发失败";
    default:
      return "未知";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatCronJobLine(job: CronJobRecord): string {
  const lastStatus = job.lastRunStatus ? `，最近: ${job.lastRunStatus}` : "";
  return `${job.id} | ${job.scheduleLabel} | ${job.status} | 下次: ${formatLocalDateTime(job.nextRunAt)}${lastStatus}\n${job.name}`;
}

function formatCronRunLine(run: CronRunRecord, jobName: string | undefined): string {
  const parts = [
    jobName ? `[${jobName}]` : `[${run.jobId}]`,
    formatLocalDateTime(run.startedAt),
    `状态: ${run.status}`,
    `尝试: ${run.attempt}`,
  ];
  if (run.summary) {
    parts.push(`摘要: ${truncateText(run.summary, 120)}`);
  }
  if (run.error) {
    parts.push(`错误: ${truncateText(run.error, 120)}`);
  }
  if (run.approvalId) {
    parts.push(`审批: ${run.approvalId}`);
  }
  return parts.join(" | ");
}

function formatLocalSkillInventory(userSkills: string[], systemSkills: string[]): string {
  const lines: string[] = [];
  lines.push("本机已安装 skills：");
  if (userSkills.length === 0) {
    lines.push("- 暂无用户安装 skills");
  } else {
    for (const name of userSkills) {
      lines.push(`- ${name}`);
    }
  }

  if (systemSkills.length > 0) {
    lines.push("");
    lines.push("系统 skills：");
    for (const name of systemSkills) {
      lines.push(`- ${name}`);
    }
  }

  return lines.join("\n");
}

function formatRemoteSkillCatalog(
  sourceLabel: string,
  items: SkillCatalogEntry[],
): string {
  const lines = [`${sourceLabel} skills：`];
  for (const item of items) {
    lines.push(`- ${item.name}${item.installed ? " (已安装)" : ""}`);
  }
  return lines.join("\n");
}

function formatSkillInstallApproval(spec: SkillInstallSpec, summary: string): string {
  return [summary, "这一步会写入你的本机 Codex skills 目录，并可能访问 GitHub。"].join("\n");
}

interface DeliveryAttemptResult {
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
}

export class FeishuCodexService {
  private readonly logger: Logger;
  private readonly activeByOpenId = new Map<string, Promise<void>>();
  private readonly cronScheduler: CronScheduler;
  private readonly skills: SkillManager;
  private expirationTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly config: AppConfig,
    parentLogger: Logger,
    private readonly store: SessionStore,
    private readonly approvalGate: ApprovalGate,
    private readonly feishu: FeishuAdapter,
    private readonly codex: CodexBridge,
  ) {
    this.logger = parentLogger.child("service");
    this.skills = new SkillManager(parentLogger);
    this.cronScheduler = new CronScheduler(
      this.store,
      this.config.cron.pollIntervalMs,
      parentLogger,
      async (job) => {
        await this.handleDueCronJob(job);
      },
    );
  }

  public async start(): Promise<void> {
    try {
      const accountSummary = await this.codex.getAccountSummary();
      this.logger.info("Connected to Codex account", accountSummary);
    } catch (error) {
      this.logger.warn(
        "Could not verify Codex login during startup. The bridge will still start.",
        error,
      );
    }

    this.approvalGate.sweepExpired();
    this.expirationTimer = setInterval(() => {
      this.approvalGate.sweepExpired();
    }, 60_000);
    this.expirationTimer.unref();

    await this.feishu.start(async (message) => {
      await this.handleMessage(message);
    });

    this.cronScheduler.start();
  }

  public async stop(): Promise<void> {
    if (this.expirationTimer) {
      clearInterval(this.expirationTimer);
      this.expirationTimer = null;
    }

    this.cronScheduler.stop();
    await this.feishu.stop();
    await this.codex.close();
  }

  private async handleMessage(message: InboundChatMessage): Promise<void> {
    if (!this.store.registerInboundMessage(message.messageId, message.openId)) {
      this.logger.info("Ignoring duplicate Feishu message", { messageId: message.messageId });
      return;
    }

    if (message.chatType !== "p2p") {
      this.store.appendAuditLog(message.openId, "ignored_non_private_chat", {
        messageId: message.messageId,
        chatType: message.chatType,
      });
      return;
    }

    if (
      !this.config.security.allowAllOpenIds &&
      !this.config.security.allowedOpenIds.has(message.openId)
    ) {
      this.store.appendAuditLog(message.openId, "rejected_not_whitelisted", {
        messageId: message.messageId,
      });
      await this.sendReply(
        message,
        `当前账号不在允许名单中。\n你的 open_id 是：${message.openId}`,
      );
      return;
    }

    const control = parseControlCommand(message.text);
    if (control) {
      await this.handleControlCommand(message, control);
      return;
    }

    if (await this.handleApprovalReference(message)) {
      return;
    }

    if (this.activeByOpenId.has(message.openId)) {
      await this.sendReply(
        message,
        "这个会话里已经有任务在处理中。可先发送 /status 查看状态。",
      );
      return;
    }

    this.trackActiveMessageJob(message, this.routeAndProcessUserMessage(message));
  }

  private async routeAndProcessUserMessage(message: InboundChatMessage): Promise<void> {
    const inferred = await this.tryInferNaturalControlCommand(message);
    if (inferred) {
      await this.handleControlCommand(message, inferred);
      return;
    }

    await this.processUserMessage(message);
  }

  private async tryInferNaturalControlCommand(
    message: InboundChatMessage,
  ): Promise<ControlCommand | null> {
    if (!looksLikeNaturalCronIntent(message.text)) {
      return null;
    }

    try {
      const intent = await this.codex.extractCronIntent(message.text);
      switch (intent.action) {
        case "add":
          this.store.appendAuditLog(message.openId, "cron_intent_inferred", {
            action: "add",
            scheduleKind: intent.schedule.kind,
          });
          return {
            type: "cron-add",
            scheduleTime:
              intent.schedule.kind === "daily" ? intent.schedule.time : null,
            schedule: intent.schedule,
            prompt: intent.prompt,
          };
        case "list":
          this.store.appendAuditLog(message.openId, "cron_intent_inferred", {
            action: "list",
          });
          return { type: "cron-list" };
        case "history":
          this.store.appendAuditLog(message.openId, "cron_intent_inferred", {
            action: "history",
          });
          return { type: "cron-history", jobId: null };
        default:
          if (intent.reason) {
            this.store.appendAuditLog(message.openId, "cron_intent_not_matched", {
              reason: intent.reason,
            });
          }
          return null;
      }
    } catch (error) {
      this.logger.warn("Failed to infer cron intent with Codex", {
        openId: message.openId,
        messageId: message.messageId,
        error,
      });
      this.store.appendAuditLog(message.openId, "cron_intent_inference_failed", {
        messageId: message.messageId,
        error: this.toErrorMessage(error),
      });
      return null;
    }
  }

  private async handleControlCommand(
    message: InboundChatMessage,
    command: ControlCommand,
  ): Promise<void> {
    switch (command.type) {
      case "status":
        await this.handleStatus(message);
        return;
      case "reset":
        await this.handleReset(message);
        return;
      case "skill-list":
        await this.handleSkillList(message, command.source);
        return;
      case "skill-install":
        await this.handleSkillInstall(message, command.spec);
        return;
      case "approve":
        await this.handleApprove(message, command.approvalId);
        return;
      case "reject":
        await this.handleReject(message, command.approvalId);
        return;
      case "cron-add":
        await this.handleCronAdd(message, command.scheduleTime, command.schedule, command.prompt);
        return;
      case "cron-list":
        await this.handleCronList(message);
        return;
      case "cron-pause":
        await this.handleCronPause(message, command.jobId);
        return;
      case "cron-resume":
        await this.handleCronResume(message, command.jobId);
        return;
      case "cron-delete":
        await this.handleCronDelete(message, command.jobId);
        return;
      case "cron-history":
        await this.handleCronHistory(message, command.jobId);
        return;
    }
  }

  private async handleStatus(message: InboundChatMessage): Promise<void> {
    const session = this.store.getSession(message.openId);
    const pending = this.approvalGate.listPendingApprovals(message.openId);
    const busy = this.activeByOpenId.has(message.openId);
    const cronJobs = this.store.listCronJobs(message.openId);
    const nextCron = cronJobs
      .filter((job) => job.status === "active")
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0];

    const mode =
      this.config.codex.sessionMode === "operator" &&
      this.config.codex.controlScope === "computer"
        ? "Codex operator / 电脑控制模式"
        : this.config.codex.sessionMode === "operator"
          ? "Codex operator / 工作区模式"
          : "工作区助手模式";

    const lines = [
      `模式: ${mode}`,
      `线程: ${session?.threadId ?? "未创建"}`,
      `运行中: ${busy ? "是" : "否"}`,
      `待审批: ${pending.length}`,
      `定时任务: ${cronJobs.length}`,
      "执行策略: 高风险操作需审批",
    ];

    if (nextCron) {
      lines.push(
        `下一个定时任务: ${nextCron.name} @ ${formatLocalDateTime(nextCron.nextRunAt)}`,
      );
    }
    if (session) {
      lines.push(
        `最近回发: ${formatDeliveryStatus(session.lastDeliveryStatus)}（尝试 ${session.lastDeliveryAttempts} 次）`,
      );
    }
    if (session?.lastDeliveryError) {
      lines.push(`最近回发错误: ${truncateText(session.lastDeliveryError, 180)}`);
    }
    if (session?.lastResult) {
      lines.push(`最近结果摘要: ${truncateText(session.lastResult, 180)}`);
    }
    if (pending.length > 0) {
      lines.push(`最近审批: ${pending.map((item) => item.id).join(", ")}`);
    }

    await this.sendReply(message, lines.join("\n"));
  }

  private async handleReset(message: InboundChatMessage): Promise<void> {
    if (this.activeByOpenId.has(message.openId)) {
      await this.sendReply(
        message,
        "当前还有任务在处理中，暂时不能 /reset。可先等待任务完成或查看 /status。",
      );
      return;
    }

    const session = this.store.getSession(message.openId);
    if (session?.threadId) {
      await this.archiveThreadQuietly(message.openId, session.threadId, "manual_reset");
    }

    const threadId = await this.codex.ensureThread();
    this.store.upsertSession(
      this.mergeSession(message.openId, threadId, session, {
        lastResult: null,
        lastTurnId: null,
        lastDeliveryStatus: "unknown",
        lastDeliveryError: null,
        lastDeliveryAttempts: 0,
      }),
    );

    await this.sendReply(message, `已重置会话，新线程：${threadId}`);
  }

  private async handleSkillList(
    message: InboundChatMessage,
    source: "local" | "curated" | "experimental",
  ): Promise<void> {
    if (source === "local") {
      const inventory = this.skills.listInstalledSkills();
      await this.sendReply(
        message,
        formatLocalSkillInventory(inventory.userSkills, inventory.systemSkills),
      );
      return;
    }

    try {
      const skills = await this.skills.listRemoteSkills(source);
      const label = source === "experimental" ? "官方 experimental" : "官方 curated";
      await this.sendReply(message, formatRemoteSkillCatalog(label, skills));
    } catch (error) {
      await this.sendReply(
        message,
        `读取 ${source === "experimental" ? "experimental" : "curated"} skill 列表失败：${this.toErrorMessage(error)}`,
      );
    }
  }

  private async handleSkillInstall(
    message: InboundChatMessage,
    spec: SkillInstallSpec,
  ): Promise<void> {
    const inventory = this.skills.listInstalledSkills();
    const existingNames = new Set([...inventory.userSkills, ...inventory.systemSkills]);
    if (
      (spec.source === "curated" || spec.source === "experimental") &&
      existingNames.has(spec.name)
    ) {
      await this.sendReply(message, `skill ${spec.name} 已经安装过了。`);
      return;
    }

    const summary = formatSkillInstallApproval(
      spec,
      `准备安装 skill：${this.skills.describeInstallSpec(spec)}`,
    );

    const approval = this.approvalGate.createStoredApproval({
      openId: message.openId,
      threadId: this.store.getSession(message.openId)?.threadId ?? "skill-install",
      kind: "skill-install",
      originalMessage: message.text,
      summary,
      prompt: message.text,
      requestMethod: "skill_install",
      requestPayload: spec,
    });

    this.store.appendAuditLog(message.openId, "skill_install_requested", {
      approvalId: approval.id,
      spec,
    });

    await this.sendReply(message, summarizeApproval(approval));
  }

  private async handleCronAdd(
    message: InboundChatMessage,
    scheduleTime: string | null,
    schedule: CronSchedule | null,
    prompt: string,
  ): Promise<void> {
    const resolvedSchedule =
      schedule ??
      (scheduleTime ? buildDailySchedule(scheduleTime) : null);

    if (!resolvedSchedule) {
      await this.sendReply(
        message,
        "时间格式不对。可以用 `/cron add 09:00 任务内容`，也可以直接说“每天早上9点帮我……”",
      );
      return;
    }

    const promptText = prompt.trim();
    if (!promptText) {
      await this.sendReply(message, "定时任务内容不能为空。");
      return;
    }

    const serialized = serializeCronSchedule(resolvedSchedule);
    const job: CronJobRecord = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
      openId: message.openId,
      chatId: message.chatId,
      name: buildCronJobName(promptText),
      prompt: promptText,
      scheduleKind: serialized.scheduleKind,
      scheduleConfigJson: serialized.scheduleConfigJson,
      scheduleLabel: serialized.scheduleLabel,
      scheduleTime: serialized.scheduleTime,
      status: "active",
      nextRunAt: computeNextRunIso(resolvedSchedule),
      retryAttempt: 0,
      maxRetries: this.config.cron.defaultMaxRetries,
      retryBaseMinutes: this.config.cron.retryBaseMinutes,
      lastRunAt: null,
      lastRunStatus: null,
      lastDeliveryStatus: "unknown",
      updatedAt: nowIso(),
    };

    this.store.createCronJob(job);
    this.store.appendAuditLog(message.openId, "cron_job_created", {
      jobId: job.id,
      scheduleKind: job.scheduleKind,
      scheduleLabel: job.scheduleLabel,
      nextRunAt: job.nextRunAt,
      name: job.name,
    });

    await this.sendReply(
      message,
      [
        `已创建定时任务：${job.id}`,
        `名称: ${job.name}`,
        `频率: ${job.scheduleLabel}`,
        `下次执行: ${formatLocalDateTime(job.nextRunAt)}`,
        `失败重试: 最多 ${job.maxRetries} 次，基础间隔 ${job.retryBaseMinutes} 分钟`,
      ].join("\n"),
    );
  }

  private async handleCronList(message: InboundChatMessage): Promise<void> {
    const jobs = this.store.listCronJobs(message.openId);
    if (jobs.length === 0) {
      await this.sendReply(
        message,
        "还没有定时任务。\n可用 `/cron add 09:00 帮我总结今天工作区变化` 创建，也可以直接说“每天早上9点帮我……”",
      );
      return;
    }

    await this.sendReply(
      message,
      ["当前定时任务：", ...jobs.map((job) => formatCronJobLine(job))].join("\n\n"),
    );
  }

  private async handleCronPause(
    message: InboundChatMessage,
    jobId: string | null,
  ): Promise<void> {
    const job = this.resolveCronJob(message.openId, jobId);
    if (!job) {
      await this.sendReply(message, "没有找到要暂停的定时任务。");
      return;
    }

    this.store.updateCronJobStatus(job.id, "paused");
    this.store.appendAuditLog(message.openId, "cron_job_paused", { jobId: job.id });
    await this.sendReply(message, `已暂停定时任务 ${job.id}。`);
  }

  private async handleCronResume(
    message: InboundChatMessage,
    jobId: string | null,
  ): Promise<void> {
    const job = this.resolveCronJob(message.openId, jobId);
    if (!job) {
      await this.sendReply(message, "没有找到要恢复的定时任务。");
      return;
    }

    const nextRunAt = computeNextRunIso(hydrateCronSchedule(job));
    this.store.updateCronJobStatus(job.id, "active", nextRunAt);
    this.store.appendAuditLog(message.openId, "cron_job_resumed", {
      jobId: job.id,
      nextRunAt,
    });
    await this.sendReply(
      message,
      `已恢复定时任务 ${job.id}。\n下次执行: ${formatLocalDateTime(nextRunAt)}`,
    );
  }

  private async handleCronDelete(
    message: InboundChatMessage,
    jobId: string | null,
  ): Promise<void> {
    const job = this.resolveCronJob(message.openId, jobId);
    if (!job) {
      await this.sendReply(message, "没有找到要删除的定时任务。");
      return;
    }

    this.store.deleteCronJob(job.id, message.openId);
    this.store.appendAuditLog(message.openId, "cron_job_deleted", { jobId: job.id });
    await this.sendReply(message, `已删除定时任务 ${job.id}。`);
  }

  private async handleCronHistory(
    message: InboundChatMessage,
    jobId: string | null,
  ): Promise<void> {
    const runs = this.store.listCronRuns(message.openId, jobId, 10);
    if (runs.length === 0) {
      await this.sendReply(message, "还没有可查看的定时任务运行历史。");
      return;
    }

    const jobs = this.store.listCronJobs(message.openId);
    const jobNameById = new Map(jobs.map((job) => [job.id, job.name]));
    await this.sendReply(
      message,
      ["最近定时任务运行历史：", ...runs.map((run) => formatCronRunLine(run, jobNameById.get(run.jobId)))].join(
        "\n\n",
      ),
    );
  }

  private async handleApprovalReference(message: InboundChatMessage): Promise<boolean> {
    const text = message.text.trim();
    if (!text) {
      return false;
    }

    const pending = this.approvalGate.listPendingApprovals(message.openId);
    const matched = pending.find((item) =>
      new RegExp(`\\b${escapeRegExp(item.id)}\\b`, "i").test(text),
    );
    if (!matched) {
      return false;
    }

    const lines = [`审批编号: ${matched.id}`, "状态: 待批准"];
    if (matched.summary) {
      lines.push(matched.summary.trim());
    } else if (matched.originalMessage) {
      lines.push(`原始请求: ${matched.originalMessage}`);
    }
    lines.push(`回复 /approve ${matched.id} 继续，或 /reject ${matched.id} 取消。`);
    await this.sendReply(message, lines.join("\n\n"));
    return true;
  }

  private async handleApprove(
    message: InboundChatMessage,
    approvalId: string | null,
  ): Promise<void> {
    const approval = await this.resolveApproval(message.openId, approvalId);
    if (!approval) {
      await this.sendReply(message, "没有找到可批准的待处理审批。");
      return;
    }

    const approved = await this.approvalGate.approve(approval.id);
    if (!approved) {
      await this.sendReply(message, "该审批已失效或已处理。");
      return;
    }

    if (approval.kind === "skill-install") {
      this.approvalGate.markConsumed(approval.id);
      this.trackActiveMessageJob(message, this.executeApprovedSkillInstall(message, approval));
      return;
    }

    if (approval.kind !== "risk-gate") {
      await this.sendReply(message, `已批准 ${approval.id}，Codex 继续执行中。`);
      return;
    }

    this.approvalGate.markConsumed(approval.id);
    const session = await this.ensureSession(message.openId);
    this.trackActiveMessageJob(
      message,
      this.executeApprovedTask(message, session.threadId, approval),
    );
  }

  private async handleReject(
    message: InboundChatMessage,
    approvalId: string | null,
  ): Promise<void> {
    const approval = await this.resolveApproval(message.openId, approvalId);
    if (!approval) {
      await this.sendReply(message, "没有找到可拒绝的待处理审批。");
      return;
    }

    const rejected = await this.approvalGate.reject(approval.id);
    if (!rejected) {
      await this.sendReply(message, "该审批已失效或已处理。");
      return;
    }

    await this.sendReply(message, `已拒绝审批 ${approval.id}。`);
  }

  private async processUserMessage(message: InboundChatMessage): Promise<void> {
    const session = await this.ensureSession(message.openId);
    const risk = assessRisk(message.text);

    await this.sendReply(message, "收到，正在交给 Codex 处理...");

    if (risk.level === "approval-required") {
      const preview = await this.codex.runPreflightTurn(session.threadId, message.text);
      this.recordSessionSnapshot(message.openId, session.threadId, preview.turnId, preview.text);

      const approval = this.approvalGate.createRiskApproval({
        openId: message.openId,
        threadId: session.threadId,
        originalMessage: message.text,
        summary: preview.text,
        prompt: message.text,
      });

      await this.sendReply(message, summarizeApproval(approval));
      return;
    }

    const result = await this.codex.runSafeTurn(session.threadId, message.text);
    await this.persistAndDeliverTurnResult(message, session.threadId, result.turnId, result.text);
  }

  private async executeApprovedTask(
    message: InboundChatMessage,
    threadId: string,
    approval: ApprovalRecord,
  ): Promise<void> {
    await this.sendReply(message, `审批 ${approval.id} 已通过，Codex 开始执行。`);

    const result = await this.codex.runApprovedTurn(
      threadId,
      approval.id,
      approval.originalMessage ?? approval.prompt ?? "",
      undefined,
      async (request: LiveApprovalRequest) => {
        const liveApproval = this.approvalGate.registerLiveApproval(
          {
            openId: message.openId,
            threadId,
            kind: request.approvalKind,
            originalMessage: approval.originalMessage,
            summary: request.summary,
            prompt: approval.prompt,
            requestMethod: request.requestMethod,
            requestPayload: request.requestPayload,
          },
          {
            approve: request.approve,
            reject: request.reject,
          },
        );

        await this.sendReply(message, summarizeApproval(liveApproval));
      },
    );

    await this.persistAndDeliverTurnResult(message, threadId, result.turnId, result.text);
  }

  private async executeApprovedSkillInstall(
    message: InboundChatMessage,
    approval: ApprovalRecord,
  ): Promise<void> {
    const spec = this.parseApprovedSkillInstallSpec(approval);
    if (!spec) {
      await this.sendReply(message, "这个 skill 安装审批缺少安装参数，无法继续执行。");
      return;
    }

    await this.sendReply(
      message,
      `审批 ${approval.id} 已通过，开始安装 skill。\n${this.skills.describeInstallSpec(spec)}`,
    );

    try {
      const output = await this.skills.installSkill(spec);
      this.store.appendAuditLog(message.openId, "skill_install_succeeded", {
        approvalId: approval.id,
        spec,
      });
      await this.sendReply(
        message,
        [
          "skill 安装成功。",
          output,
          "请重启 Codex / 桥接服务后再使用新 skill。",
        ].join("\n"),
      );
    } catch (error) {
      this.store.appendAuditLog(message.openId, "skill_install_failed", {
        approvalId: approval.id,
        spec,
        error: this.toErrorMessage(error),
      });
      await this.sendReply(
        message,
        `skill 安装失败：${this.toErrorMessage(error)}`,
      );
    }
  }

  private async handleDueCronJob(job: CronJobRecord): Promise<void> {
    if (this.activeByOpenId.has(job.openId)) {
      return;
    }

    this.trackActiveOpenId(job.openId, this.executeCronJob(job), async (error) => {
      const detail = this.toErrorMessage(error);
      const schedule = hydrateCronSchedule(job);
      const willRetry = job.retryAttempt < job.maxRetries;
      const nextRunAt = willRetry
        ? computeRetryRunIso(job.retryBaseMinutes, job.retryAttempt + 1)
        : computeNextRunIso(schedule);

      this.store.updateCronJobSchedule(job.id, {
        nextRunAt,
        retryAttempt: willRetry ? job.retryAttempt + 1 : 0,
        lastRunAt: nowIso(),
        lastRunStatus: "failed",
        lastDeliveryStatus: "failed",
      });
      this.store.appendAuditLog(job.openId, "cron_job_internal_failure", {
        jobId: job.id,
        error: detail,
      });
    });
  }

  private async executeCronJob(job: CronJobRecord): Promise<void> {
    const schedule = hydrateCronSchedule(job);
    const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const startedAt = nowIso();
    const run: CronRunRecord = {
      id: runId,
      jobId: job.id,
      openId: job.openId,
      status: "running",
      attempt: job.retryAttempt + 1,
      scheduledFor: job.nextRunAt,
      startedAt,
      finishedAt: null,
      deliveryStatus: "unknown",
      summary: null,
      error: null,
      approvalId: null,
      updatedAt: startedAt,
    };
    this.store.createCronRun(run);
    this.store.appendAuditLog(job.openId, "cron_job_started", {
      jobId: job.id,
      runId,
      attempt: run.attempt,
      scheduledFor: job.nextRunAt,
    });

    const session = await this.ensureSession(job.openId);
    const risk = assessRisk(job.prompt);

    if (risk.level === "approval-required") {
      const preview = await this.codex.runPreflightTurn(session.threadId, job.prompt);
      this.recordSessionSnapshot(job.openId, session.threadId, preview.turnId, preview.text);

      const approval = this.approvalGate.createRiskApproval({
        openId: job.openId,
        threadId: session.threadId,
        originalMessage: job.prompt,
        summary: preview.text,
        prompt: job.prompt,
      });

      const delivery = await this.sendCronText(
        job,
        summarizeApproval(
          approval,
          `定时任务 ${job.name} 到点了，但这次请求需要人工审批。`,
        ),
      );

      this.store.updateCronRun(run.id, {
        status: "approval_pending",
        finishedAt: nowIso(),
        deliveryStatus: delivery.status,
        summary: preview.text,
        approvalId: approval.id,
      });
      this.store.updateCronJobSchedule(job.id, {
        nextRunAt: computeNextRunIso(schedule),
        retryAttempt: 0,
        lastRunAt: nowIso(),
        lastRunStatus: "approval_pending",
        lastDeliveryStatus: delivery.status,
      });
      this.store.appendAuditLog(job.openId, "cron_job_approval_requested", {
        jobId: job.id,
        runId: run.id,
        approvalId: approval.id,
        deliveryStatus: delivery.status,
      });
      return;
    }

    try {
      const result = await this.codex.runSafeTurn(session.threadId, job.prompt);
      this.recordSessionSnapshot(job.openId, session.threadId, result.turnId, result.text);

      const delivery = await this.sendCronText(
        job,
        [
          `定时任务 ${job.name} 执行成功`,
          `时间: ${formatLocalDateTime(startedAt)}`,
          "",
          truncateText(result.text, 1600),
        ].join("\n"),
      );

      this.store.updateCronRun(run.id, {
        status: "succeeded",
        finishedAt: nowIso(),
        deliveryStatus: delivery.status,
        summary: result.text,
      });
      this.store.updateCronJobSchedule(job.id, {
        nextRunAt: computeNextRunIso(schedule),
        retryAttempt: 0,
        lastRunAt: nowIso(),
        lastRunStatus: "succeeded",
        lastDeliveryStatus: delivery.status,
      });
      this.store.appendAuditLog(job.openId, "cron_job_succeeded", {
        jobId: job.id,
        runId: run.id,
        deliveryStatus: delivery.status,
      });
    } catch (error) {
      const detail = this.toErrorMessage(error);
      const willRetry = job.retryAttempt < job.maxRetries;
      const nextRunAt = willRetry
        ? computeRetryRunIso(job.retryBaseMinutes, job.retryAttempt + 1)
        : computeNextRunIso(schedule);
      const nextRetryAttempt = willRetry ? job.retryAttempt + 1 : 0;
      const delivery = await this.sendCronText(
        job,
        [
          `定时任务 ${job.name} 执行失败`,
          `时间: ${formatLocalDateTime(startedAt)}`,
          `原因: ${detail}`,
          willRetry
            ? `将于 ${formatLocalDateTime(nextRunAt)} 自动重试（第 ${nextRetryAttempt}/${job.maxRetries} 次重试）`
            : `今日重试已用完，下次将于 ${formatLocalDateTime(nextRunAt)} 再次执行`,
        ].join("\n"),
      );

      this.store.updateCronRun(run.id, {
        status: "failed",
        finishedAt: nowIso(),
        deliveryStatus: delivery.status,
        error: detail,
      });
      this.store.updateCronJobSchedule(job.id, {
        nextRunAt,
        retryAttempt: nextRetryAttempt,
        lastRunAt: nowIso(),
        lastRunStatus: "failed",
        lastDeliveryStatus: delivery.status,
      });
      this.store.appendAuditLog(job.openId, "cron_job_failed", {
        jobId: job.id,
        runId: run.id,
        error: detail,
        nextRunAt,
        retryAttempt: nextRetryAttempt,
        deliveryStatus: delivery.status,
      });
    }
  }

  private async ensureSession(openId: string): Promise<{ threadId: string }> {
    const existing = this.store.getSession(openId);
    const rotationReason = this.getRotationReason(existing);

    if (!existing || rotationReason) {
      if (existing?.threadId && rotationReason) {
        await this.archiveThreadQuietly(openId, existing.threadId, rotationReason);
      }

      const threadId = await this.codex.ensureThread();
      this.store.upsertSession(
        this.mergeSession(openId, threadId, existing, {
          bridgeVersion: this.config.bridgeVersion,
        }),
      );

      if (rotationReason) {
        this.store.appendAuditLog(openId, "session_thread_rotated", {
          previousThreadId: existing?.threadId ?? null,
          nextThreadId: threadId,
          reason: rotationReason,
        });
      }

      return { threadId };
    }

    const resumedThreadId = await this.codex.ensureThread(existing.threadId);
    if (resumedThreadId !== existing.threadId) {
      await this.archiveThreadQuietly(openId, existing.threadId, "resume_replaced");
      this.store.appendAuditLog(openId, "session_thread_rotated", {
        previousThreadId: existing.threadId,
        nextThreadId: resumedThreadId,
        reason: "resume_replaced",
      });
    }

    if (
      resumedThreadId !== existing.threadId ||
      existing.bridgeVersion !== this.config.bridgeVersion
    ) {
      this.store.upsertSession(
        this.mergeSession(openId, resumedThreadId, existing, {
          bridgeVersion: this.config.bridgeVersion,
        }),
      );
    }

    return { threadId: resumedThreadId };
  }

  private async resolveApproval(
    openId: string,
    approvalId: string | null,
  ): Promise<ApprovalRecord | null> {
    const pending = this.approvalGate.listPendingApprovals(openId);
    if (approvalId) {
      return pending.find((item) => item.id === approvalId) ?? null;
    }

    return pending.length === 1 ? pending[0] : null;
  }

  private parseApprovedSkillInstallSpec(approval: ApprovalRecord): SkillInstallSpec | null {
    if (!approval.requestPayloadJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(approval.requestPayloadJson) as Partial<SkillInstallSpec> & Record<string, unknown>;
      if (parsed.source === "curated" && typeof parsed.name === "string") {
        return { source: "curated", name: parsed.name };
      }
      if (parsed.source === "experimental" && typeof parsed.name === "string") {
        return { source: "experimental", name: parsed.name };
      }
      if (parsed.source === "url" && typeof parsed.url === "string") {
        return { source: "url", url: parsed.url };
      }
      if (
        parsed.source === "repo" &&
        typeof parsed.repo === "string" &&
        typeof parsed.path === "string"
      ) {
        return {
          source: "repo",
          repo: parsed.repo,
          path: parsed.path,
          ref: typeof parsed.ref === "string" ? parsed.ref : null,
          name: typeof parsed.name === "string" ? parsed.name : null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveCronJob(openId: string, jobId: string | null): CronJobRecord | null {
    const jobs = this.store.listCronJobs(openId);
    if (jobId) {
      return jobs.find((item) => item.id === jobId) ?? null;
    }

    return jobs.length === 1 ? jobs[0] : null;
  }

  private trackActiveMessageJob(message: InboundChatMessage, job: Promise<void>): void {
    this.trackActiveOpenId(message.openId, job, async (error) => {
      await this.reportJobFailure(message, error);
    });
  }

  private trackActiveOpenId(
    openId: string,
    job: Promise<void>,
    onError: (error: unknown) => Promise<void>,
  ): void {
    const wrapped = job.catch(async (error: unknown) => {
      await onError(error);
    });

    this.activeByOpenId.set(openId, wrapped);
    void wrapped.finally(() => {
      this.activeByOpenId.delete(openId);
    });
  }

  private async persistAndDeliverTurnResult(
    message: InboundChatMessage,
    threadId: string,
    turnId: string,
    text: string,
  ): Promise<void> {
    this.recordSessionSnapshot(message.openId, threadId, turnId, text);

    const delivery = await this.sendTextToChat(message.chatId, text, message.openId, "final_result", {
      messageId: message.messageId,
      threadId,
      turnId,
    });

    const session = this.store.getSession(message.openId);
    if (session) {
      this.store.upsertSession(
        this.mergeSession(message.openId, threadId, session, {
          lastDeliveryStatus: delivery.status,
          lastDeliveryError: delivery.error,
          lastDeliveryAttempts: delivery.attempts,
        }),
      );
    }
  }

  private async reportJobFailure(
    message: InboundChatMessage,
    error: unknown,
  ): Promise<void> {
    const detail = this.toErrorMessage(error);

    this.logger.error("Failed to process Feishu message", {
      openId: message.openId,
      chatId: message.chatId,
      messageId: message.messageId,
      error,
    });
    this.store.appendAuditLog(message.openId, "message_processing_failed", {
      messageId: message.messageId,
      error: detail,
    });

    const existing = this.store.getSession(message.openId);
    if (existing) {
      this.store.upsertSession(
        this.mergeSession(message.openId, existing.threadId, existing, {
          lastDeliveryStatus: "failed",
          lastDeliveryError: detail,
          lastDeliveryAttempts: 0,
        }),
      );
    }

    await this.sendTextToChat(
      message.chatId,
      this.formatUserFacingError(error),
      message.openId,
      "error_reply",
      { messageId: message.messageId },
    );
  }

  private async sendCronText(job: CronJobRecord, text: string): Promise<DeliveryAttemptResult> {
    return this.sendTextToChat(job.chatId, text, job.openId, "cron_delivery", {
      jobId: job.id,
      jobName: job.name,
    });
  }

  private async sendTextToChat(
    chatId: string,
    text: string,
    openId: string,
    eventPrefix: string,
    details: Record<string, unknown>,
  ): Promise<DeliveryAttemptResult> {
    try {
      const receipt = await this.feishu.sendText(chatId, text);
      this.store.appendAuditLog(openId, `${eventPrefix}_delivered`, {
        ...details,
        attempts: receipt.attempts,
        chunks: receipt.chunkCount,
      });
      return { status: "delivered", attempts: receipt.attempts, error: null };
    } catch (error) {
      const detail = this.toErrorMessage(error);
      const attempts = this.extractSendAttempts(error);
      this.store.appendAuditLog(openId, `${eventPrefix}_delivery_failed`, {
        ...details,
        attempts,
        error: detail,
      });
      this.logger.error("Failed to send Feishu message", {
        openId,
        chatId,
        eventPrefix,
        error,
      });
      return { status: "failed", attempts, error: detail };
    }
  }

  private recordSessionSnapshot(
    openId: string,
    threadId: string,
    turnId: string,
    text: string,
  ): void {
    const base = this.store.getSession(openId);
    this.store.upsertSession(
      this.mergeSession(openId, threadId, base, {
        lastResult: sanitizeStoredText(text, 180),
        lastTurnId: turnId,
      }),
    );
  }

  private mergeSession(
    openId: string,
    threadId: string,
    base: SessionRecord | null,
    patch: Partial<Omit<SessionRecord, "openId" | "threadId">> = {},
  ): SessionRecord {
    return {
      openId,
      threadId,
      bridgeVersion: patch.bridgeVersion ?? base?.bridgeVersion ?? this.config.bridgeVersion,
      lastResult: patch.lastResult !== undefined ? patch.lastResult : base?.lastResult ?? null,
      lastTurnId: patch.lastTurnId !== undefined ? patch.lastTurnId : base?.lastTurnId ?? null,
      lastDeliveryStatus: patch.lastDeliveryStatus ?? base?.lastDeliveryStatus ?? "unknown",
      lastDeliveryError:
        patch.lastDeliveryError !== undefined
          ? patch.lastDeliveryError
          : base?.lastDeliveryError ?? null,
      lastDeliveryAttempts:
        patch.lastDeliveryAttempts ?? base?.lastDeliveryAttempts ?? 0,
      updatedAt: patch.updatedAt ?? nowIso(),
    };
  }

  private getRotationReason(session: SessionRecord | null): string | null {
    if (!session) {
      return null;
    }

    if (session.bridgeVersion !== this.config.bridgeVersion) {
      return "bridge_version_changed";
    }

    if (this.codex.isThreadInvalid(session.threadId)) {
      return "resume_override_warning";
    }

    return null;
  }

  private async archiveThreadQuietly(
    openId: string,
    threadId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.codex.archiveThread(threadId);
    } catch (error) {
      this.logger.warn("Failed to archive old thread", {
        openId,
        threadId,
        reason,
        error,
      });
    }
  }

  private extractSendAttempts(error: unknown): number {
    return error instanceof FeishuSendError ? error.attempts : 0;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return sanitizeStoredText(error.message, 240) ?? "Unknown error";
    }

    return sanitizeStoredText(String(error), 240) ?? "Unknown error";
  }

  private formatUserFacingError(error: unknown): string {
    const detail = this.toErrorMessage(error);

    return [
      "Codex 这次处理失败了。",
      detail ? `原因：${detail}` : null,
      "你可以稍后重试，或者先发送 /reset 新开一个会话。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async sendReply(message: InboundChatMessage, text: string): Promise<void> {
    await this.sendTextToChat(message.chatId, text, message.openId, "reply", {
      messageId: message.messageId,
    });
  }
}

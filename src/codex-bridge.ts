import { CodexRpcClient } from "./codex-rpc.js";
import {
  buildDailySchedule,
  buildHourlySchedule,
  buildWeeklySchedule,
  normalizeDailyTime,
} from "./cron.js";
import { Logger } from "./logger.js";
import type { CronIntent, CronWeekday, LiveApprovalRequest } from "./types.js";

interface BridgeOptions {
  appRoot: string;
  workspaceRoots: string[];
  sessionMode: "assistant" | "operator";
  controlScope: "workspace" | "computer";
  model?: string;
  serviceName: string;
}

type TurnMode = "safe" | "preflight" | "approved";
type ReadOnlyAccessMode = "restricted" | "full";

interface ActiveTurnTracker {
  threadId: string;
  turnId: string;
  mode: TurnMode;
  readOnlyAccessMode: ReadOnlyAccessMode;
  finalText: string;
  notes: string[];
  commentarySent: boolean;
  sawWindowsReadOnlyIssue: boolean;
  timeout: NodeJS.Timeout;
  onProgress?: (message: string) => Promise<void>;
  onFormalApproval?: (request: LiveApprovalRequest) => Promise<void>;
  resolve(result: { threadId: string; turnId: string; text: string; notes: string[] }): void;
  reject(error: Error): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

function getStringByKeys(
  value: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const candidate = getString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractTurnErrorMessage(params: unknown): string | null {
  const root = getObject(params);
  if (!root) {
    return null;
  }

  const directError = getObject(root.error);
  if (directError) {
    const directMessage = getString(directError.message);
    const directDetails = getString(directError.additionalDetails);
    return [directMessage, directDetails].filter(Boolean).join("\n").trim() || null;
  }

  const turn = getObject(root.turn);
  const turnError = turn ? getObject(turn.error) : null;
  if (!turnError) {
    return null;
  }

  const message = getString(turnError.message);
  const details = getString(turnError.additionalDetails);
  return [message, details].filter(Boolean).join("\n").trim() || null;
}

export function isKnownWindowsReadOnlyIssueMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("restricted read-only access is not yet supported") ||
    (normalized.includes("windows sandbox") && normalized.includes("read-only")) ||
    (normalized.includes("sandbox") && normalized.includes("read-only access"))
  );
}

function buildSafeDeveloperInstructions(
  sessionMode: "assistant" | "operator",
  controlScope: "workspace" | "computer",
): string {
  return [
    sessionMode === "operator"
      ? "You are the user's long-running Codex operator session controlled from Feishu."
      : "You are replying through a Feishu private-chat bridge.",
    "Respond in Chinese unless the user clearly prefers another language.",
    "Keep replies concise and plain-text friendly.",
    "For ordinary read-only requests, you should inspect the local machine yourself with read-only tools.",
    "When the user asks about directories, files, current state, or command output, prefer checking directly instead of asking the user to run commands.",
    "Do not write files, run mutating commands, launch apps, or install packages unless the bridge explicitly says the task is approved.",
    controlScope === "computer"
      ? "When the bridge approves a task, the approved turn may use the same full local-computer access level as the desktop Codex session."
      : "When the bridge approves a task, the approved turn may operate only inside the allowed workspace roots.",
    "If a request needs approval, explain the planned action briefly and stop.",
  ].join(" ");
}

function buildSafePrompt(userMessage: string): string {
  return [
    "Handle the user's request directly.",
    "If the user asks about files, folders, the current working directory, system state, or command output, inspect the machine yourself with the available read-only tools before answering.",
    "If the user asks what files are in the current directory, actually enumerate the current working directory and report the observed results.",
    "Do not output policy explanations or ask the user to run local commands unless a real tool call fails.",
    "",
    "User request:",
    userMessage,
  ].join("\n");
}

function buildPreflightPrompt(
  userMessage: string,
  sessionMode: "assistant" | "operator",
  controlScope: "workspace" | "computer",
): string {
  return [
    "The following user request requires manual approval before any execution.",
    "Do not run commands, edit files, or change the workspace.",
    sessionMode === "operator"
      ? "This session acts as an operator for local files, commands, and process/script tasks."
      : "This session acts as a workspace assistant.",
    controlScope === "computer"
      ? "After approval, you may use the same full local-computer access level as the desktop Codex session."
      : "After approval, you may operate only inside the allowed workspace roots.",
    "Respond in Chinese.",
    "Briefly summarize what you would do after approval, mention likely commands, touched files, process/app actions, and call out important risks.",
    "",
    "User request:",
    userMessage,
  ].join("\n");
}

function buildApprovedPrompt(
  approvalId: string,
  userMessage: string,
  sessionMode: "assistant" | "operator",
  controlScope: "workspace" | "computer",
): string {
  return [
    `The bridge has approved task ${approvalId}.`,
    sessionMode === "operator"
      ? "This is the user's operator session controlled from Feishu."
      : "This is the user's workspace assistant session.",
    controlScope === "computer"
      ? "You may now execute the request with full local-computer access."
      : "You may now execute the request inside the allowed workspace roots.",
    "Do not ask for the same approval again.",
    controlScope === "computer"
      ? "You already have the same local-computer access level as the desktop Codex session."
      : "If you need extra permissions outside the allowed workspace or network access, stop and explain exactly what extra permission is needed.",
    "After execution, summarize the outcome and mention changed files.",
    "",
    "Original user request:",
    userMessage,
  ].join("\n");
}

function buildReadOnlyPolicy(
  workspaceRoots: string[],
  accessMode: ReadOnlyAccessMode,
): unknown {
  return {
    type: "readOnly",
    access:
      accessMode === "full"
        ? {
            type: "fullAccess",
          }
        : {
            type: "restricted",
            includePlatformDefaults: true,
            readableRoots: workspaceRoots,
          },
    networkAccess: false,
  };
}

function buildCronIntentDeveloperInstructions(): string {
  return [
    "You extract recurring schedule intent for a Feishu to Codex bridge.",
    "Do not answer the user conversationally.",
    "Return JSON only with no markdown fences.",
    "Recognize recurring schedule requests such as daily, weekly, workday, weekend, and every-N-hours jobs.",
    "If the user is asking to view existing scheduled jobs, return action=list.",
    "If the user is asking to view scheduled job run history, return action=history.",
    "If the message is not clearly a recurring scheduled task request, return action=none.",
    "For add actions, keep the task prompt concise and remove schedule wording from the prompt field.",
  ].join(" ");
}

function buildCronIntentPrompt(userMessage: string): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  return [
    `Local timezone: ${timezone}`,
    `Local time now: ${new Date().toISOString()}`,
    "Return JSON only using exactly this schema:",
    '{"action":"add|list|history|none","prompt":string|null,"schedule":{"kind":"daily","time":"HH:MM"}|{"kind":"weekly","time":"HH:MM","weekdays":["MON","WED"]}|{"kind":"hourly","intervalHours":2}|null,"reason":string|null}',
    "Rules:",
    "- action=add only for recurring future tasks.",
    "- For 工作日 use MON,TUE,WED,THU,FRI.",
    "- For 周末 use SAT,SUN.",
    "- For every-N-hours requests use kind=hourly.",
    "- Use 24-hour HH:MM time.",
    "- If schedule or task is too ambiguous, return action=none.",
    "",
    "User message:",
    userMessage,
  ].join("\n");
}

function extractJsonObject(text: string): string | null {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return text.slice(firstBrace, lastBrace + 1).trim();
}

function normalizeWeekdayValues(values: unknown[]): CronWeekday[] {
  const normalized = new Set<CronWeekday>();
  const mapping: Record<string, CronWeekday[]> = {
    MON: ["MON"],
    TUE: ["TUE"],
    WED: ["WED"],
    THU: ["THU"],
    FRI: ["FRI"],
    SAT: ["SAT"],
    SUN: ["SUN"],
    MONDAY: ["MON"],
    TUESDAY: ["TUE"],
    WEDNESDAY: ["WED"],
    THURSDAY: ["THU"],
    FRIDAY: ["FRI"],
    SATURDAY: ["SAT"],
    SUNDAY: ["SUN"],
    WORKDAY: ["MON", "TUE", "WED", "THU", "FRI"],
    WORKDAYS: ["MON", "TUE", "WED", "THU", "FRI"],
    WEEKDAY: ["MON", "TUE", "WED", "THU", "FRI"],
    WEEKDAYS: ["MON", "TUE", "WED", "THU", "FRI"],
    WEEKEND: ["SAT", "SUN"],
    WEEKENDS: ["SAT", "SUN"],
    周一: ["MON"],
    周二: ["TUE"],
    周三: ["WED"],
    周四: ["THU"],
    周五: ["FRI"],
    周六: ["SAT"],
    周日: ["SUN"],
    周天: ["SUN"],
    星期一: ["MON"],
    星期二: ["TUE"],
    星期三: ["WED"],
    星期四: ["THU"],
    星期五: ["FRI"],
    星期六: ["SAT"],
    星期日: ["SUN"],
    星期天: ["SUN"],
    工作日: ["MON", "TUE", "WED", "THU", "FRI"],
    周末: ["SAT", "SUN"],
  };

  for (const value of values) {
    const key = String(value).trim().toUpperCase();
    const matches = mapping[key] ?? mapping[String(value).trim()] ?? [];
    for (const match of matches) {
      normalized.add(match);
    }
  }

  return [...normalized];
}

function parseCronIntentResult(text: string, now: Date): CronIntent {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { action: "none", reason: "missing_json" };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return { action: "none", reason: "invalid_json" };
  }

  const action = typeof parsed.action === "string" ? parsed.action.trim().toLowerCase() : "none";
  if (action === "list") {
    return { action: "list" };
  }
  if (action === "history") {
    return { action: "history" };
  }
  if (action !== "add") {
    return {
      action: "none",
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : null,
    };
  }

  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  const schedule = parsed.schedule;
  if (!prompt || typeof schedule !== "object" || schedule === null) {
    return { action: "none", reason: "missing_schedule_or_prompt" };
  }

  const scheduleObject = schedule as Record<string, unknown>;
  const kind = typeof scheduleObject.kind === "string" ? scheduleObject.kind.trim().toLowerCase() : "";

  if (kind === "daily") {
    const time = typeof scheduleObject.time === "string" ? normalizeDailyTime(scheduleObject.time) : null;
    const normalized = time ? buildDailySchedule(time) : null;
    return normalized
      ? { action: "add", prompt, schedule: normalized }
      : { action: "none", reason: "invalid_daily_time" };
  }

  if (kind === "weekly") {
    const time = typeof scheduleObject.time === "string" ? normalizeDailyTime(scheduleObject.time) : null;
    const weekdays = Array.isArray(scheduleObject.weekdays)
      ? normalizeWeekdayValues(scheduleObject.weekdays)
      : [];
    const normalized = time ? buildWeeklySchedule(weekdays, time) : null;
    return normalized
      ? { action: "add", prompt, schedule: normalized }
      : { action: "none", reason: "invalid_weekly_schedule" };
  }

  if (kind === "hourly") {
    const intervalHours =
      typeof scheduleObject.intervalHours === "number"
        ? scheduleObject.intervalHours
        : Number.parseInt(String(scheduleObject.intervalHours ?? ""), 10);
    const anchorIso =
      typeof scheduleObject.anchorIso === "string" && scheduleObject.anchorIso.trim()
        ? scheduleObject.anchorIso
        : now.toISOString();
    const normalized = buildHourlySchedule(intervalHours, anchorIso);
    return normalized
      ? { action: "add", prompt, schedule: normalized }
      : { action: "none", reason: "invalid_hourly_schedule" };
  }

  return { action: "none", reason: "unsupported_schedule_kind" };
}

function buildWorkspaceWritePolicy(workspaceRoots: string[]): unknown {
  return {
    type: "workspaceWrite",
    writableRoots: workspaceRoots,
    readOnlyAccess: {
      type: "restricted",
      includePlatformDefaults: true,
      readableRoots: workspaceRoots,
    },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function buildApprovedPolicy(
  workspaceRoots: string[],
  controlScope: "workspace" | "computer",
): unknown {
  return controlScope === "computer"
    ? {
        type: "dangerFullAccess",
      }
    : buildWorkspaceWritePolicy(workspaceRoots);
}

export class CodexBridge {
  private readonly logger: Logger;
  private readonly activeTurns = new Map<string, ActiveTurnTracker>();
  private readonly invalidThreadIds = new Set<string>();
  private readonly notificationUnsubscribe: () => void;
  private readonly requestUnsubscribe: () => void;
  private readonly stderrUnsubscribe: () => void;
  private readonly turnTimeoutMs = 180_000;

  public constructor(
    private readonly rpc: CodexRpcClient,
    private readonly options: BridgeOptions,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child("codex");
    this.notificationUnsubscribe = this.rpc.onNotification((message) =>
      this.handleNotification(message),
    );
    this.requestUnsubscribe = this.rpc.onServerRequest((message) =>
      this.handleServerRequest(message),
    );
    this.stderrUnsubscribe = this.rpc.onStderr((line) =>
      this.handleStderrLine(line),
    );
  }

  public async close(): Promise<void> {
    this.notificationUnsubscribe();
    this.requestUnsubscribe();
    this.stderrUnsubscribe();
    await this.rpc.close();
  }

  public isThreadInvalid(threadId: string): boolean {
    return this.invalidThreadIds.has(threadId);
  }

  public async getAccountSummary(): Promise<string> {
    const result = (await this.rpc.request("account/read", {
      refreshToken: false,
    })) as { account?: { email?: string; planType?: string; type?: string } };

    const account = result.account;
    if (!account) {
      return "Codex account is not available.";
    }

    return `${account.email ?? "unknown"} (${account.planType ?? account.type ?? "unknown"})`;
  }

  public async ensureThread(threadId?: string): Promise<string> {
    if (threadId && !this.invalidThreadIds.has(threadId)) {
      try {
        const resumed = (await this.rpc.request("thread/resume", {
          threadId,
          persistExtendedHistory: false,
          cwd: this.options.appRoot,
          model: this.options.model,
          developerInstructions: buildSafeDeveloperInstructions(
            this.options.sessionMode,
            this.options.controlScope,
          ),
          sandbox: "read-only",
          approvalPolicy: "never",
        })) as { thread: { id: string } };

        if (!this.invalidThreadIds.has(threadId)) {
          return resumed.thread.id;
        }

        this.logger.warn("Codex thread was marked stale during resume; creating a new one", {
          threadId,
        });
      } catch (error) {
        this.logger.warn("Failed to resume Codex thread, creating a new one", {
          threadId,
          error,
        });
      }
    } else if (threadId) {
      this.logger.info("Skipping invalidated Codex thread and creating a new one", {
        threadId,
      });
    }

    const created = (await this.rpc.request("thread/start", {
      cwd: this.options.appRoot,
      model: this.options.model,
      serviceName: this.options.serviceName,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: buildSafeDeveloperInstructions(
        this.options.sessionMode,
        this.options.controlScope,
      ),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })) as { thread: { id: string } };

    return created.thread.id;
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.rpc.request("thread/archive", { threadId });
  }

  public async extractCronIntent(userMessage: string): Promise<CronIntent> {
    const thread = (await this.rpc.request("thread/start", {
      cwd: this.options.appRoot,
      model: this.options.model,
      serviceName: `${this.options.serviceName}-cron-intent`,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: buildCronIntentDeveloperInstructions(),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })) as { thread: { id: string } };

    try {
      const result = await this.startTurnAndWait(
        {
          threadId: thread.thread.id,
          mode: "safe",
          prompt: buildCronIntentPrompt(userMessage),
        },
        "restricted",
        [],
      );

      return parseCronIntentResult(result.text, new Date());
    } finally {
      await this.archiveThread(thread.thread.id).catch((error) => {
        this.logger.warn("Failed to archive cron intent thread", {
          threadId: thread.thread.id,
          error,
        });
      });
    }
  }

  public async runSafeTurn(
    threadId: string,
    prompt: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<{ threadId: string; turnId: string; text: string; notes: string[] }> {
    return this.runTurn({
      threadId,
      mode: "safe",
      prompt: buildSafePrompt(prompt),
      onProgress,
    });
  }

  public async runPreflightTurn(
    threadId: string,
    userMessage: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<{ threadId: string; turnId: string; text: string; notes: string[] }> {
    return this.runTurn({
      threadId,
      mode: "preflight",
      prompt: buildPreflightPrompt(
        userMessage,
        this.options.sessionMode,
        this.options.controlScope,
      ),
      onProgress,
    });
  }

  public async runApprovedTurn(
    threadId: string,
    approvalId: string,
    userMessage: string,
    onProgress?: (message: string) => Promise<void>,
    onFormalApproval?: (request: LiveApprovalRequest) => Promise<void>,
  ): Promise<{ threadId: string; turnId: string; text: string; notes: string[] }> {
    return this.runTurn({
      threadId,
      mode: "approved",
      prompt: buildApprovedPrompt(
        approvalId,
        userMessage,
        this.options.sessionMode,
        this.options.controlScope,
      ),
      onProgress,
      onFormalApproval,
    });
  }

  private async runTurn(input: {
    threadId: string;
    mode: TurnMode;
    prompt: string;
    onProgress?: (message: string) => Promise<void>;
    onFormalApproval?: (request: LiveApprovalRequest) => Promise<void>;
  }): Promise<{ threadId: string; turnId: string; text: string; notes: string[] }> {
    const initialReadOnlyAccessMode: ReadOnlyAccessMode =
      this.options.controlScope === "computer" ? "full" : "restricted";

    try {
      return await this.startTurnAndWait(input, initialReadOnlyAccessMode, []);
    } catch (error) {
      if (
        input.mode !== "approved" &&
        process.platform === "win32" &&
        initialReadOnlyAccessMode === "restricted" &&
        error instanceof Error &&
        isKnownWindowsReadOnlyIssueMessage(error.message)
      ) {
        this.logger.warn("Retrying Codex turn with full read-only access on Windows", {
          threadId: input.threadId,
          mode: input.mode,
          error: error.message,
        });

        return this.startTurnAndWait(
          input,
          "full",
          ["windows-full-read-fallback"],
        );
      }

      throw error;
    }
  }

  private async startTurnAndWait(
    input: {
      threadId: string;
      mode: TurnMode;
      prompt: string;
      onProgress?: (message: string) => Promise<void>;
      onFormalApproval?: (request: LiveApprovalRequest) => Promise<void>;
    },
    readOnlyAccessMode: ReadOnlyAccessMode,
    notes: string[],
  ): Promise<{ threadId: string; turnId: string; text: string; notes: string[] }> {
    const turnStartResponse = (await this.rpc.request("turn/start", {
      threadId: input.threadId,
      input: [
        {
          type: "text",
          text: input.prompt,
          text_elements: [],
        },
      ],
      model: this.options.model,
      approvalPolicy: input.mode === "approved" ? "on-request" : "never",
      sandboxPolicy:
        input.mode === "approved"
          ? buildApprovedPolicy(this.options.workspaceRoots, this.options.controlScope)
          : buildReadOnlyPolicy(this.options.workspaceRoots, readOnlyAccessMode),
    })) as {
      turn: { id: string };
    };

    const turnId = turnStartResponse.turn.id;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeTurns.delete(turnId);
        reject(new Error("Timed out while waiting for Codex to finish this turn."));
      }, this.turnTimeoutMs);
      timeout.unref();

      this.activeTurns.set(turnId, {
        threadId: input.threadId,
        turnId,
        mode: input.mode,
        readOnlyAccessMode,
        finalText: "",
        notes: [...notes],
        commentarySent: false,
        sawWindowsReadOnlyIssue: false,
        timeout,
        onProgress: input.onProgress,
        onFormalApproval: input.onFormalApproval,
        resolve: (result) => {
          clearTimeout(timeout);
          this.activeTurns.delete(turnId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.activeTurns.delete(turnId);
          reject(error);
        },
      });
    });
  }

  private handleNotification(message: { method: string; params?: unknown }): void {
    const tracker = this.findTrackerForNotification(message);
    if (!tracker) {
      return;
    }

    if (message.method === "item/completed") {
      const params = isObject(message.params) ? message.params : null;
      const item = params && isObject(params.item) ? params.item : null;
      const itemType = item ? getString(item.type) : null;
      const phase = item ? getString(item.phase) : null;
      const text = item ? getString(item.text) : null;

      if (itemType === "agentMessage" && text) {
        if (phase === "final_answer") {
          tracker.finalText = text;
        } else if (!tracker.commentarySent && tracker.onProgress) {
          tracker.commentarySent = true;
          void tracker.onProgress(text);
        }
      }
      return;
    }

    if (message.method === "codex/event/task_complete") {
      const params = isObject(message.params) ? message.params : null;
      const msg = params && isObject(params.msg) ? params.msg : null;
      const finalMessage = msg ? getString(msg.last_agent_message) : null;
      if (finalMessage && !tracker.finalText) {
        tracker.finalText = finalMessage;
      }
      return;
    }

    if (message.method === "turn/completed") {
      if (tracker.sawWindowsReadOnlyIssue && tracker.readOnlyAccessMode === "restricted") {
        tracker.reject(
          new Error(
            "windows sandbox: Restricted read-only access is not yet supported by the Windows sandbox backend",
          ),
        );
        return;
      }

      const turnErrorMessage = extractTurnErrorMessage(message.params);
      if (turnErrorMessage) {
        tracker.reject(new Error(turnErrorMessage));
        return;
      }

      tracker.resolve({
        threadId: tracker.threadId,
        turnId: tracker.turnId,
        text: tracker.finalText || "Codex completed the task but did not return a final message.",
        notes: tracker.notes,
      });
      return;
    }

    if (message.method === "error" || message.method === "codex/event/error") {
      const turnErrorMessage =
        extractTurnErrorMessage(message.params) ??
        "Codex reported an error while handling the turn.";
      this.logger.error("Codex turn failed", {
        turnId: tracker.turnId,
        method: message.method,
        params: message.params,
      });
      tracker.reject(new Error(turnErrorMessage));
    }
  }

  private handleServerRequest(message: {
    id: string | number;
    method: string;
    params?: unknown;
  }): void {
    const tracker = this.findTrackerForServerRequest(message);
    if (!tracker || !tracker.onFormalApproval) {
      return;
    }

    const params = isObject(message.params) ? message.params : {};
    const request = this.buildLiveApprovalRequest(message, params, tracker);
    if (!request) {
      return;
    }

    void tracker.onFormalApproval(request);
  }

  private buildLiveApprovalRequest(
    message: { id: string | number; method: string },
    params: Record<string, unknown>,
    tracker: ActiveTurnTracker,
  ): LiveApprovalRequest | null {
    const shared = {
      threadId: tracker.threadId,
      turnId: tracker.turnId,
      requestMethod: message.method,
      requestPayload: params,
      approve: async () => {
        await this.rpc.respond(
          message.id,
          this.defaultApprovalResponse(message.method, true, params),
        );
      },
      reject: async () => {
        await this.rpc.respond(
          message.id,
          this.defaultApprovalResponse(message.method, false, params),
        );
      },
    };

    if (message.method === "item/commandExecution/requestApproval") {
      const command = getString(params.command) ?? "(unknown command)";
      return {
        approvalKind: "codex-command",
        summary: `Codex requests permission to run:\n${command}`,
        ...shared,
      };
    }

    if (message.method === "item/fileChange/requestApproval") {
      const reason = getString(params.reason) ?? "Codex wants to change files.";
      return {
        approvalKind: "codex-file",
        summary: reason,
        ...shared,
      };
    }

    if (message.method === "item/permissions/requestApproval") {
      return {
        approvalKind: "codex-permission",
        summary: "Codex requests extra permissions outside the current sandbox.",
        ...shared,
      };
    }

    return null;
  }

  private defaultApprovalResponse(
    method: string,
    approved: boolean,
    params: Record<string, unknown>,
  ): unknown {
    if (method === "item/commandExecution/requestApproval") {
      return { decision: approved ? "accept" : "decline" };
    }

    if (method === "item/fileChange/requestApproval") {
      return { decision: approved ? "accept" : "decline" };
    }

    if (method === "item/permissions/requestApproval") {
      return {
        permissions: approved ? (params.permissions ?? {}) : {},
        scope: "turn",
      };
    }

    return {};
  }

  private findTrackerForNotification(message: { method: string; params?: unknown }): ActiveTurnTracker | null {
    const params = getObject(message.params);
    if (!params) {
      return null;
    }

    const directTurnId = getStringByKeys(params, "turnId", "turn_id");
    if (directTurnId && this.activeTurns.has(directTurnId)) {
      return this.activeTurns.get(directTurnId) ?? null;
    }

    const turn = getObject(params.turn);
    const turnIdFromTurn = turn ? getString(turn.id) : null;
    if (turnIdFromTurn && this.activeTurns.has(turnIdFromTurn)) {
      return this.activeTurns.get(turnIdFromTurn) ?? null;
    }

    const msg = getObject(params.msg);
    const codexEventTurnId = msg ? getStringByKeys(msg, "turnId", "turn_id") : null;

    if (codexEventTurnId && this.activeTurns.has(codexEventTurnId)) {
      return this.activeTurns.get(codexEventTurnId) ?? null;
    }

    return null;
  }

  private findTrackerForServerRequest(message: {
    params?: unknown;
  }): ActiveTurnTracker | null {
    const params = getObject(message.params);
    if (!params) {
      return null;
    }

    const turnId = getStringByKeys(params, "turnId", "turn_id");
    if (!turnId) {
      return null;
    }

    return this.activeTurns.get(turnId) ?? null;
  }

  private handleStderrLine(line: string): void {
    if (isKnownWindowsReadOnlyIssueMessage(line)) {
      for (const tracker of this.activeTurns.values()) {
        if (
          tracker.mode !== "approved" &&
          tracker.readOnlyAccessMode === "restricted"
        ) {
          tracker.sawWindowsReadOnlyIssue = true;
          if (!tracker.notes.includes("windows-restricted-read-only-issue")) {
            tracker.notes.push("windows-restricted-read-only-issue");
          }
        }
      }
      return;
    }

    const match = line.match(
      /thread\/resume overrides ignored for running thread ([0-9a-f-]+)/i,
    );
    if (!match) {
      return;
    }

    const threadId = match[1];
    this.invalidThreadIds.add(threadId);
    this.logger.warn("Marked Codex thread as stale after resume override warning", {
      threadId,
    });
  }
}

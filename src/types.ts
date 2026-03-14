export type ApprovalKind =
  | "risk-gate"
  | "skill-install"
  | "codex-command"
  | "codex-file"
  | "codex-permission";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed";

export type DeliveryStatus =
  | "unknown"
  | "delivered"
  | "failed";

export type CronJobStatus = "active" | "paused";

export type CronScheduleKind = "daily" | "weekly" | "hourly";

export type CronWeekday =
  | "MON"
  | "TUE"
  | "WED"
  | "THU"
  | "FRI"
  | "SAT"
  | "SUN";

export type CronSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; weekdays: CronWeekday[]; time: string }
  | { kind: "hourly"; intervalHours: number; anchorIso: string };

export type CronRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "approval_pending";

export interface InboundChatMessage {
  messageId: string;
  chatId: string;
  openId: string;
  chatType: string;
  text: string;
  raw: unknown;
}

export interface SessionRecord {
  openId: string;
  threadId: string;
  bridgeVersion: string;
  lastResult: string | null;
  lastTurnId: string | null;
  lastDeliveryStatus: DeliveryStatus;
  lastDeliveryError: string | null;
  lastDeliveryAttempts: number;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  openId: string;
  threadId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  originalMessage: string | null;
  summary: string | null;
  prompt: string | null;
  requestMethod: string | null;
  requestPayloadJson: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CronJobRecord {
  id: string;
  openId: string;
  chatId: string;
  name: string;
  prompt: string;
  scheduleKind: CronScheduleKind;
  scheduleConfigJson: string;
  scheduleLabel: string;
  scheduleTime: string;
  status: CronJobStatus;
  nextRunAt: string;
  retryAttempt: number;
  maxRetries: number;
  retryBaseMinutes: number;
  lastRunAt: string | null;
  lastRunStatus: CronRunStatus | null;
  lastDeliveryStatus: DeliveryStatus;
  updatedAt: string;
}

export interface CronRunRecord {
  id: string;
  jobId: string;
  openId: string;
  status: CronRunStatus;
  attempt: number;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  deliveryStatus: DeliveryStatus;
  summary: string | null;
  error: string | null;
  approvalId: string | null;
  updatedAt: string;
}

export interface RiskAssessment {
  level: "safe" | "approval-required";
  triggers: string[];
}

export type ControlCommand =
  | { type: "status" }
  | { type: "reset" }
  | { type: "approve"; approvalId: string | null }
  | { type: "reject"; approvalId: string | null }
  | {
      type: "cron-add";
      scheduleTime: string | null;
      schedule: CronSchedule | null;
      prompt: string;
    }
  | { type: "cron-list" }
  | { type: "cron-pause"; jobId: string | null }
  | { type: "cron-resume"; jobId: string | null }
  | { type: "cron-delete"; jobId: string | null }
  | { type: "cron-history"; jobId: string | null }
  | { type: "skill-list"; source: SkillListSource }
  | { type: "skill-install"; spec: SkillInstallSpec };

export type CronIntent =
  | { action: "none"; reason?: string | null }
  | { action: "list" }
  | { action: "history" }
  | { action: "add"; schedule: CronSchedule; prompt: string };

export type SkillListSource = "local" | "curated" | "experimental";

export type SkillInstallSpec =
  | { source: "curated"; name: string }
  | { source: "experimental"; name: string }
  | { source: "url"; url: string }
  | {
      source: "repo";
      repo: string;
      path: string;
      ref?: string | null;
      name?: string | null;
    };

export interface SkillCatalogEntry {
  name: string;
  installed: boolean;
  source: SkillListSource;
}

export interface LocalSkillInventory {
  userSkills: string[];
  systemSkills: string[];
}

export interface LiveApprovalRequest {
  approvalKind: ApprovalKind;
  threadId: string;
  turnId: string;
  summary: string;
  requestMethod: string;
  requestPayload: unknown;
  approve(): Promise<void>;
  reject(): Promise<void>;
}

export interface DeliveryReceipt {
  attempts: number;
  chunkCount: number;
}

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describeCronSchedule, hydrateCronSchedule, serializeCronSchedule } from "./cron.js";
import { sanitizeAuditDetails, sanitizeStoredText } from "./privacy.js";
import type {
  ApprovalRecord,
  ApprovalStatus,
  CronJobRecord,
  CronJobStatus,
  CronRunRecord,
  CronRunStatus,
  DeliveryStatus,
  SessionRecord,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

type DbApprovalRow = ApprovalRecord;
type DbCronJobRow = CronJobRecord;
type DbCronRunRow = CronRunRecord;

interface ColumnInfoRow {
  name: string;
}

export class SessionStore {
  private readonly db: DatabaseSync;

  public constructor(dataDir: string) {
    const dbPath = path.join(dataDir, "bridge.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        open_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        bridge_version TEXT NOT NULL DEFAULT '',
        last_result TEXT,
        last_turn_id TEXT,
        last_delivery_status TEXT NOT NULL DEFAULT 'unknown',
        last_delivery_error TEXT,
        last_delivery_attempts INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_id TEXT PRIMARY KEY,
        open_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        open_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        original_message TEXT,
        summary TEXT,
        prompt TEXT,
        request_method TEXT,
        request_payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        open_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_kind TEXT NOT NULL DEFAULT 'daily',
        schedule_config_json TEXT NOT NULL DEFAULT '',
        schedule_label TEXT NOT NULL DEFAULT '',
        schedule_time TEXT NOT NULL,
        status TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        retry_base_minutes INTEGER NOT NULL DEFAULT 5,
        last_run_at TEXT,
        last_run_status TEXT,
        last_delivery_status TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        open_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        delivery_status TEXT NOT NULL DEFAULT 'unknown',
        summary TEXT,
        error TEXT,
        approval_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        open_id TEXT,
        event TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureSessionSchema();
    this.ensureCronSchema();
  }

  public registerInboundMessage(messageId: string, openId: string): boolean {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO inbound_messages (message_id, open_id, created_at)
        VALUES (?, ?, ?)
      `)
      .run(messageId, openId, nowIso());

    return Number(result.changes ?? 0) > 0;
  }

  public getSession(openId: string): SessionRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          open_id AS openId,
          thread_id AS threadId,
          COALESCE(bridge_version, '') AS bridgeVersion,
          last_result AS lastResult,
          last_turn_id AS lastTurnId,
          COALESCE(last_delivery_status, 'unknown') AS lastDeliveryStatus,
          last_delivery_error AS lastDeliveryError,
          COALESCE(last_delivery_attempts, 0) AS lastDeliveryAttempts,
          updated_at AS updatedAt
        FROM sessions
        WHERE open_id = ?
      `)
      .get(openId) as SessionRecord | undefined;

    return row ?? null;
  }

  public upsertSession(record: SessionRecord): void {
    this.db
      .prepare(`
        INSERT INTO sessions (
          open_id,
          thread_id,
          bridge_version,
          last_result,
          last_turn_id,
          last_delivery_status,
          last_delivery_error,
          last_delivery_attempts,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(open_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          bridge_version = excluded.bridge_version,
          last_result = excluded.last_result,
          last_turn_id = excluded.last_turn_id,
          last_delivery_status = excluded.last_delivery_status,
          last_delivery_error = excluded.last_delivery_error,
          last_delivery_attempts = excluded.last_delivery_attempts,
          updated_at = excluded.updated_at
      `)
      .run(
        record.openId,
        record.threadId,
        record.bridgeVersion,
        sanitizeStoredText(record.lastResult, 180),
        record.lastTurnId,
        record.lastDeliveryStatus,
        sanitizeStoredText(record.lastDeliveryError, 240),
        record.lastDeliveryAttempts,
        record.updatedAt,
      );
  }

  public clearSession(openId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE open_id = ?`).run(openId);
  }

  public createApproval(record: ApprovalRecord): void {
    this.db
      .prepare(`
        INSERT INTO approvals (
          id, open_id, thread_id, kind, status, original_message, summary,
          prompt, request_method, request_payload_json, created_at, updated_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.openId,
        record.threadId,
        record.kind,
        record.status,
        record.originalMessage,
        record.summary,
        record.prompt,
        record.requestMethod,
        record.requestPayloadJson,
        record.createdAt,
        record.updatedAt,
        record.expiresAt,
      );
  }

  public getApproval(id: string): ApprovalRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          thread_id AS threadId,
          kind,
          status,
          original_message AS originalMessage,
          summary,
          prompt,
          request_method AS requestMethod,
          request_payload_json AS requestPayloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          expires_at AS expiresAt
        FROM approvals
        WHERE id = ?
      `)
      .get(id) as DbApprovalRow | undefined;

    return row ?? null;
  }

  public listPendingApprovals(openId: string): ApprovalRecord[] {
    return this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          thread_id AS threadId,
          kind,
          status,
          original_message AS originalMessage,
          summary,
          prompt,
          request_method AS requestMethod,
          request_payload_json AS requestPayloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          expires_at AS expiresAt
        FROM approvals
        WHERE open_id = ? AND status = 'pending'
        ORDER BY created_at ASC
      `)
      .all(openId) as unknown as ApprovalRecord[];
  }

  public updateApprovalStatus(id: string, status: ApprovalStatus): void {
    this.db
      .prepare(`
        UPDATE approvals
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, nowIso(), id);
  }

  public redactApprovalDetails(id: string): void {
    this.db
      .prepare(`
        UPDATE approvals
        SET
          original_message = NULL,
          prompt = NULL,
          request_method = NULL,
          request_payload_json = NULL,
          updated_at = ?
        WHERE id = ?
      `)
      .run(nowIso(), id);
  }

  public expireApprovals(expiredBeforeIso: string): ApprovalRecord[] {
    const expired = this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          thread_id AS threadId,
          kind,
          status,
          original_message AS originalMessage,
          summary,
          prompt,
          request_method AS requestMethod,
          request_payload_json AS requestPayloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt,
          expires_at AS expiresAt
        FROM approvals
        WHERE status = 'pending' AND expires_at <= ?
      `)
      .all(expiredBeforeIso) as unknown as ApprovalRecord[];

    this.db
      .prepare(`
        UPDATE approvals
        SET status = 'expired', updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?
      `)
      .run(nowIso(), expiredBeforeIso);

    return expired;
  }

  public createCronJob(record: CronJobRecord): void {
    this.db
      .prepare(`
        INSERT INTO cron_jobs (
          id, open_id, chat_id, name, prompt, schedule_kind, schedule_config_json,
          schedule_label, schedule_time, status, next_run_at,
          retry_attempt, max_retries, retry_base_minutes, last_run_at, last_run_status,
          last_delivery_status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.openId,
        record.chatId,
        record.name,
        record.prompt,
        record.scheduleKind,
        record.scheduleConfigJson,
        record.scheduleLabel,
        record.scheduleTime,
        record.status,
        record.nextRunAt,
        record.retryAttempt,
        record.maxRetries,
        record.retryBaseMinutes,
        record.lastRunAt,
        record.lastRunStatus,
        record.lastDeliveryStatus,
        record.updatedAt,
      );
  }

  public getCronJob(id: string, openId?: string): CronJobRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          chat_id AS chatId,
          name,
          prompt,
          COALESCE(schedule_kind, 'daily') AS scheduleKind,
          COALESCE(schedule_config_json, '') AS scheduleConfigJson,
          COALESCE(
            NULLIF(schedule_label, ''),
            CASE
              WHEN COALESCE(schedule_time, '') = '' THEN '每天 09:00'
              ELSE '每天 ' || schedule_time
            END
          ) AS scheduleLabel,
          schedule_time AS scheduleTime,
          status,
          next_run_at AS nextRunAt,
          retry_attempt AS retryAttempt,
          max_retries AS maxRetries,
          retry_base_minutes AS retryBaseMinutes,
          last_run_at AS lastRunAt,
          last_run_status AS lastRunStatus,
          last_delivery_status AS lastDeliveryStatus,
          updated_at AS updatedAt
        FROM cron_jobs
        WHERE id = ?
          AND (? IS NULL OR open_id = ?)
      `)
      .get(id, openId ?? null, openId ?? null) as DbCronJobRow | undefined;

    return row ? this.hydrateCronJobRow(row) : null;
  }

  public listCronJobs(openId: string): CronJobRecord[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          chat_id AS chatId,
          name,
          prompt,
          COALESCE(schedule_kind, 'daily') AS scheduleKind,
          COALESCE(schedule_config_json, '') AS scheduleConfigJson,
          COALESCE(
            NULLIF(schedule_label, ''),
            CASE
              WHEN COALESCE(schedule_time, '') = '' THEN '每天 09:00'
              ELSE '每天 ' || schedule_time
            END
          ) AS scheduleLabel,
          schedule_time AS scheduleTime,
          status,
          next_run_at AS nextRunAt,
          retry_attempt AS retryAttempt,
          max_retries AS maxRetries,
          retry_base_minutes AS retryBaseMinutes,
          last_run_at AS lastRunAt,
          last_run_status AS lastRunStatus,
          last_delivery_status AS lastDeliveryStatus,
          updated_at AS updatedAt
        FROM cron_jobs
        WHERE open_id = ?
        ORDER BY next_run_at ASC, rowid ASC
      `)
      .all(openId) as unknown as DbCronJobRow[];

    return rows.map((row) => this.hydrateCronJobRow(row));
  }

  public listDueCronJobs(beforeIso: string): CronJobRecord[] {
    const rows = this.db
      .prepare(`
        SELECT
          id,
          open_id AS openId,
          chat_id AS chatId,
          name,
          prompt,
          COALESCE(schedule_kind, 'daily') AS scheduleKind,
          COALESCE(schedule_config_json, '') AS scheduleConfigJson,
          COALESCE(
            NULLIF(schedule_label, ''),
            CASE
              WHEN COALESCE(schedule_time, '') = '' THEN '每天 09:00'
              ELSE '每天 ' || schedule_time
            END
          ) AS scheduleLabel,
          schedule_time AS scheduleTime,
          status,
          next_run_at AS nextRunAt,
          retry_attempt AS retryAttempt,
          max_retries AS maxRetries,
          retry_base_minutes AS retryBaseMinutes,
          last_run_at AS lastRunAt,
          last_run_status AS lastRunStatus,
          last_delivery_status AS lastDeliveryStatus,
          updated_at AS updatedAt
        FROM cron_jobs
        WHERE status = 'active' AND next_run_at <= ?
        ORDER BY next_run_at ASC
      `)
      .all(beforeIso) as unknown as DbCronJobRow[];

    return rows.map((row) => this.hydrateCronJobRow(row));
  }

  public updateCronJobSchedule(
    id: string,
    patch: {
      nextRunAt: string;
      retryAttempt: number;
      lastRunAt?: string | null;
      lastRunStatus?: CronRunStatus | null;
      lastDeliveryStatus?: DeliveryStatus;
    },
  ): void {
    this.db
      .prepare(`
        UPDATE cron_jobs
        SET
          next_run_at = ?,
          retry_attempt = ?,
          last_run_at = ?,
          last_run_status = ?,
          last_delivery_status = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        patch.nextRunAt,
        patch.retryAttempt,
        patch.lastRunAt ?? null,
        patch.lastRunStatus ?? null,
        patch.lastDeliveryStatus ?? "unknown",
        nowIso(),
        id,
      );
  }

  public updateCronJobStatus(id: string, status: CronJobStatus, nextRunAt?: string): void {
    if (nextRunAt) {
      this.db
        .prepare(`
          UPDATE cron_jobs
          SET status = ?, next_run_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(status, nextRunAt, nowIso(), id);
      return;
    }

    this.db
      .prepare(`
        UPDATE cron_jobs
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, nowIso(), id);
  }

  public deleteCronJob(id: string, openId: string): boolean {
    const result = this.db
      .prepare(`
        DELETE FROM cron_jobs
        WHERE id = ? AND open_id = ?
      `)
      .run(id, openId);

    return Number(result.changes ?? 0) > 0;
  }

  public createCronRun(record: CronRunRecord): void {
    this.db
      .prepare(`
        INSERT INTO cron_runs (
          id, job_id, open_id, status, attempt, scheduled_for, started_at,
          finished_at, delivery_status, summary, error, approval_id, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.jobId,
        record.openId,
        record.status,
        record.attempt,
        record.scheduledFor,
        record.startedAt,
        record.finishedAt,
        record.deliveryStatus,
        sanitizeStoredText(record.summary, 300),
        sanitizeStoredText(record.error, 240),
        record.approvalId,
        record.updatedAt,
      );
  }

  public getCronRun(id: string): CronRunRecord | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          job_id AS jobId,
          open_id AS openId,
          status,
          attempt,
          scheduled_for AS scheduledFor,
          started_at AS startedAt,
          finished_at AS finishedAt,
          delivery_status AS deliveryStatus,
          summary,
          error,
          approval_id AS approvalId,
          updated_at AS updatedAt
        FROM cron_runs
        WHERE id = ?
      `)
      .get(id) as DbCronRunRow | undefined;

    return row ?? null;
  }

  public updateCronRun(
    id: string,
    patch: {
      status?: CronRunStatus;
      finishedAt?: string | null;
      deliveryStatus?: DeliveryStatus;
      summary?: string | null;
      error?: string | null;
      approvalId?: string | null;
    },
  ): void {
    const current = this.getCronRun(id);
    if (!current) {
      return;
    }

    this.db
      .prepare(`
        UPDATE cron_runs
        SET
          status = ?,
          finished_at = ?,
          delivery_status = ?,
          summary = ?,
          error = ?,
          approval_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        patch.status ?? current.status,
        patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
        patch.deliveryStatus ?? current.deliveryStatus,
        sanitizeStoredText(
          patch.summary !== undefined ? patch.summary : current.summary,
          300,
        ),
        sanitizeStoredText(
          patch.error !== undefined ? patch.error : current.error,
          240,
        ),
        patch.approvalId !== undefined ? patch.approvalId : current.approvalId,
        nowIso(),
        id,
      );
  }

  public listCronRuns(openId: string, jobId: string | null, limit: number): CronRunRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 20));

    return this.db
      .prepare(`
        SELECT
          id,
          job_id AS jobId,
          open_id AS openId,
          status,
          attempt,
          scheduled_for AS scheduledFor,
          started_at AS startedAt,
          finished_at AS finishedAt,
          delivery_status AS deliveryStatus,
          summary,
          error,
          approval_id AS approvalId,
          updated_at AS updatedAt
        FROM cron_runs
        WHERE open_id = ?
          AND (? IS NULL OR job_id = ?)
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(openId, jobId, jobId, safeLimit) as unknown as CronRunRecord[];
  }

  public appendAuditLog(openId: string | null, event: string, details?: unknown): void {
    const detailsJson =
      details === undefined ? null : JSON.stringify(sanitizeAuditDetails(details));

    this.db
      .prepare(`
        INSERT INTO audit_logs (open_id, event, details_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(openId, event, detailsJson, nowIso());
  }

  private ensureSessionSchema(): void {
    this.ensureColumn("sessions", "bridge_version", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn(
      "sessions",
      "last_delivery_status",
      "TEXT NOT NULL DEFAULT 'unknown'",
    );
    this.ensureColumn("sessions", "last_delivery_error", "TEXT");
    this.ensureColumn(
      "sessions",
      "last_delivery_attempts",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }

  private ensureCronSchema(): void {
    this.ensureColumn(
      "cron_jobs",
      "schedule_kind",
      "TEXT NOT NULL DEFAULT 'daily'",
    );
    this.ensureColumn(
      "cron_jobs",
      "schedule_config_json",
      "TEXT NOT NULL DEFAULT ''",
    );
    this.ensureColumn(
      "cron_jobs",
      "schedule_label",
      "TEXT NOT NULL DEFAULT ''",
    );
  }

  private hydrateCronJobRow(row: DbCronJobRow): CronJobRecord {
    const schedule = hydrateCronSchedule(row);
    const serialized = serializeCronSchedule(schedule);

    return {
      ...row,
      scheduleKind: row.scheduleKind || serialized.scheduleKind,
      scheduleConfigJson: row.scheduleConfigJson || serialized.scheduleConfigJson,
      scheduleLabel: row.scheduleLabel || describeCronSchedule(schedule),
      scheduleTime: row.scheduleTime || serialized.scheduleTime,
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as unknown as ColumnInfoRow[];

    if (columns.some((item) => item.name === column)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

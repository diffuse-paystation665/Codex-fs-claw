import crypto from "node:crypto";

import { Logger } from "./logger.js";
import { sanitizeAuditDetails, sanitizeStoredText } from "./privacy.js";
import { SessionStore } from "./session-store.js";
import type { ApprovalKind, ApprovalRecord } from "./types.js";

interface LiveResolver {
  approve(): Promise<void>;
  reject(): Promise<void>;
}

interface CreateApprovalInput {
  openId: string;
  threadId: string;
  kind: ApprovalKind;
  originalMessage: string | null;
  summary: string | null;
  prompt: string | null;
  requestMethod?: string | null;
  requestPayload?: unknown;
}

export class ApprovalGate {
  private readonly logger: Logger;
  private readonly liveResolvers = new Map<string, LiveResolver>();

  public constructor(
    private readonly store: SessionStore,
    private readonly ttlMinutes: number,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child("approval");
  }

  public createRiskApproval(input: Omit<CreateApprovalInput, "kind">): ApprovalRecord {
    return this.createApproval({
      ...input,
      kind: "risk-gate",
    });
  }

  public createStoredApproval(input: CreateApprovalInput): ApprovalRecord {
    return this.createApproval(input);
  }

  public registerLiveApproval(
    input: CreateApprovalInput,
    resolver: LiveResolver,
  ): ApprovalRecord {
    const record = this.createApproval(input);
    this.liveResolvers.set(record.id, resolver);
    return record;
  }

  public getApproval(id: string): ApprovalRecord | null {
    return this.store.getApproval(id);
  }

  public listPendingApprovals(openId: string): ApprovalRecord[] {
    return this.store.listPendingApprovals(openId);
  }

  public async approve(id: string): Promise<ApprovalRecord | null> {
    const approval = this.store.getApproval(id);
    if (!approval || approval.status !== "pending") {
      return null;
    }

    if (new Date(approval.expiresAt).getTime() <= Date.now()) {
      this.store.updateApprovalStatus(id, "expired");
      this.store.redactApprovalDetails(id);
      return this.store.getApproval(id);
    }

    const resolver = this.liveResolvers.get(id);
    if (resolver) {
      await resolver.approve();
      this.liveResolvers.delete(id);
    }

    this.store.updateApprovalStatus(id, "approved");
    this.store.redactApprovalDetails(id);
    return this.store.getApproval(id);
  }

  public async reject(id: string): Promise<ApprovalRecord | null> {
    const approval = this.store.getApproval(id);
    if (!approval || approval.status !== "pending") {
      return null;
    }

    const resolver = this.liveResolvers.get(id);
    if (resolver) {
      await resolver.reject();
      this.liveResolvers.delete(id);
    }

    this.store.updateApprovalStatus(id, "rejected");
    this.store.redactApprovalDetails(id);
    return this.store.getApproval(id);
  }

  public markConsumed(id: string): void {
    this.store.updateApprovalStatus(id, "consumed");
    this.store.redactApprovalDetails(id);
  }

  public sweepExpired(): ApprovalRecord[] {
    const expired = this.store.expireApprovals(new Date().toISOString());

    for (const approval of expired) {
      this.store.redactApprovalDetails(approval.id);
      const resolver = this.liveResolvers.get(approval.id);
      if (resolver) {
        void resolver.reject().catch((error: unknown) => {
          this.logger.warn("Failed to reject expired live approval", {
            approvalId: approval.id,
            error,
          });
        });
        this.liveResolvers.delete(approval.id);
      }
    }

    return expired;
  }

  private createApproval(input: CreateApprovalInput): ApprovalRecord {
    const now = new Date();
    const record: ApprovalRecord = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
      openId: input.openId,
      threadId: input.threadId,
      kind: input.kind,
      status: "pending",
      originalMessage: input.originalMessage,
      summary: sanitizeStoredText(input.summary, 600),
      prompt: input.prompt,
      requestMethod: sanitizeStoredText(input.requestMethod ?? null, 120),
      requestPayloadJson:
        input.requestPayload === undefined
          ? null
          : JSON.stringify(sanitizeAuditDetails(input.requestPayload)),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.ttlMinutes * 60_000,
      ).toISOString(),
    };

    this.store.createApproval(record);
    return record;
  }
}

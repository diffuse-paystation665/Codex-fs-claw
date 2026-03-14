import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

import type { LogLevel } from "./logger.js";

dotenv.config();

export const CURRENT_BRIDGE_VERSION = "2026-03-14-skill-control-v8";

const ENV_SCHEMA = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_ENCRYPT_KEY: z.string().optional(),
  FEISHU_SEND_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  FEISHU_SEND_RETRY_BASE_MS: z.coerce.number().int().positive().default(400),
  ALLOWED_OPEN_IDS: z.string().min(1),
  WORKSPACE_ROOTS: z.string().optional(),
  CODEX_AUTH_MODE: z.enum(["chatgpt", "api_key"]).default("chatgpt"),
  CODEX_SESSION_MODE: z.enum(["assistant", "operator"]).default("operator"),
  CODEX_CONTROL_SCOPE: z.enum(["workspace", "computer"]).default("workspace"),
  CODEX_BIN: z.string().optional(),
  CODEX_MODEL: z.string().optional(),
  DATA_DIR: z.string().optional(),
  LOG_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  APPROVAL_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  CRON_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  CRON_DEFAULT_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  CRON_RETRY_BASE_MINUTES: z.coerce.number().int().positive().default(5),
});

function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toAbsolute(root: string, cwd: string): string {
  return path.isAbsolute(root) ? path.normalize(root) : path.resolve(cwd, root);
}

export interface AppConfig {
  appRoot: string;
  bridgeVersion: string;
  dataDir: string;
  logDir: string;
  logLevel: LogLevel;
  approvalTtlMinutes: number;
  cron: {
    pollIntervalMs: number;
    defaultMaxRetries: number;
    retryBaseMinutes: number;
  };
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    sendMaxRetries: number;
    sendRetryBaseMs: number;
  };
  codex: {
    authMode: "chatgpt" | "api_key";
    sessionMode: "assistant" | "operator";
    controlScope: "workspace" | "computer";
    bin?: string;
    model?: string;
    serviceName: string;
  };
  security: {
    allowAllOpenIds: boolean;
    allowedOpenIds: Set<string>;
    workspaceRoots: string[];
  };
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  const parsed = ENV_SCHEMA.parse(process.env);
  const encryptKey = normalizeOptional(parsed.FEISHU_ENCRYPT_KEY);
  const codexBin = normalizeOptional(parsed.CODEX_BIN);
  const codexModel = normalizeOptional(parsed.CODEX_MODEL);
  const allowedOpenIds = parseList(parsed.ALLOWED_OPEN_IDS);
  const workspaceRoots = parseList(parsed.WORKSPACE_ROOTS ?? cwd).map((root) =>
    toAbsolute(root, cwd),
  );
  const dataDir = toAbsolute(parsed.DATA_DIR ?? "data", cwd);
  const logDir = toAbsolute(parsed.LOG_DIR ?? "logs", cwd);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  return {
    appRoot: cwd,
    bridgeVersion: CURRENT_BRIDGE_VERSION,
    dataDir,
    logDir,
    logLevel: parsed.LOG_LEVEL,
    approvalTtlMinutes: parsed.APPROVAL_TTL_MINUTES,
    cron: {
      pollIntervalMs: parsed.CRON_POLL_INTERVAL_MS,
      defaultMaxRetries: parsed.CRON_DEFAULT_MAX_RETRIES,
      retryBaseMinutes: parsed.CRON_RETRY_BASE_MINUTES,
    },
    feishu: {
      appId: parsed.FEISHU_APP_ID,
      appSecret: parsed.FEISHU_APP_SECRET,
      encryptKey,
      sendMaxRetries: parsed.FEISHU_SEND_MAX_RETRIES,
      sendRetryBaseMs: parsed.FEISHU_SEND_RETRY_BASE_MS,
    },
    codex: {
      authMode: parsed.CODEX_AUTH_MODE,
      sessionMode: parsed.CODEX_SESSION_MODE,
      controlScope: parsed.CODEX_CONTROL_SCOPE,
      bin: codexBin ? toAbsolute(codexBin, cwd) : undefined,
      model: codexModel,
      serviceName:
        parsed.CODEX_SESSION_MODE === "operator"
          ? "feishu-codex-operator"
          : "feishu-codex-bridge",
    },
    security: {
      allowAllOpenIds: allowedOpenIds.includes("*"),
      allowedOpenIds: new Set(allowedOpenIds.filter((item) => item !== "*")),
      workspaceRoots,
    },
  };
}

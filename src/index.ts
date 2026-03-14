import path from "node:path";

import { ApprovalGate } from "./approval-gate.js";
import { loadConfig } from "./config.js";
import { CodexBridge } from "./codex-bridge.js";
import { CodexRpcClient } from "./codex-rpc.js";
import { FeishuAdapter } from "./feishu-adapter.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import { FeishuCodexService } from "./service.js";
import {
  acquireSingleInstanceLock,
  type SingleInstanceLock,
} from "./single-instance.js";

const config = loadConfig();
const logger = new Logger(
  "bridge",
  config.logLevel,
  path.join(config.logDir, "bridge.log"),
);
let instanceLock: SingleInstanceLock;

try {
  instanceLock = await acquireSingleInstanceLock(
    config.dataDir,
    {
      cwd: config.appRoot,
      serviceName: config.codex.serviceName,
      sessionMode: config.codex.sessionMode,
      controlScope: config.codex.controlScope,
    },
    logger,
  );
} catch (error) {
  logger.error("Another Feishu Codex operator instance is already running", error);
  process.exit(1);
}

const store = new SessionStore(config.dataDir);
const approvalGate = new ApprovalGate(store, config.approvalTtlMinutes, logger);
const rpc = new CodexRpcClient(config.appRoot, config.codex.bin, logger);
const codex = new CodexBridge(
  rpc,
  {
    appRoot: config.appRoot,
    workspaceRoots: config.security.workspaceRoots,
    sessionMode: config.codex.sessionMode,
    controlScope: config.codex.controlScope,
    model: config.codex.model,
    serviceName: config.codex.serviceName,
  },
  logger,
);
const feishu = new FeishuAdapter(
  config.feishu.appId,
  config.feishu.appSecret,
  config.feishu.encryptKey,
  config.feishu.sendMaxRetries,
  config.feishu.sendRetryBaseMs,
  logger,
);
const service = new FeishuCodexService(
  config,
  logger,
  store,
  approvalGate,
  feishu,
  codex,
);

let isShuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`Shutting down on ${signal}`);

  try {
    await service.stop();
  } catch (error) {
    logger.error("Failed while stopping Feishu Codex operator", error);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }

  await instanceLock.release();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled rejection", error);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  void shutdown("uncaughtException", 1);
});

try {
  await service.start();
  logger.info("Feishu Codex operator started", {
    sessionMode: config.codex.sessionMode,
    controlScope: config.codex.controlScope,
  });
} catch (error) {
  logger.error("Failed to start Feishu Codex operator", error);
  await instanceLock.release();
  process.exit(1);
}

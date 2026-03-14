import fs from "node:fs/promises";
import path from "node:path";

import { Logger } from "./logger.js";

interface LockPayload {
  pid: number;
  acquiredAt: string;
  cwd: string;
  serviceName: string;
  sessionMode: string;
  controlScope: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProcessActive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return null;
    }

    const pid = parsed.pid;
    const acquiredAt = parsed.acquiredAt;
    const cwd = parsed.cwd;
    const serviceName = parsed.serviceName;
    const sessionMode = parsed.sessionMode;
    const controlScope = parsed.controlScope;

    if (
      typeof pid !== "number" ||
      typeof acquiredAt !== "string" ||
      typeof cwd !== "string" ||
      typeof serviceName !== "string" ||
      typeof sessionMode !== "string" ||
      typeof controlScope !== "string"
    ) {
      return null;
    }

    return {
      pid,
      acquiredAt,
      cwd,
      serviceName,
      sessionMode,
      controlScope,
    };
  } catch {
    return null;
  }
}

export class SingleInstanceLock {
  private released = false;

  public constructor(
    private readonly lockPath: string,
    private readonly logger: Logger,
  ) {}

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }

    this.released = true;

    try {
      await fs.rm(this.lockPath, { force: true });
      this.logger.info("Released bridge single-instance lock", {
        lockPath: this.lockPath,
      });
    } catch (error) {
      this.logger.warn("Failed to remove bridge single-instance lock", {
        lockPath: this.lockPath,
        error,
      });
    }
  }
}

export async function acquireSingleInstanceLock(
  dataDir: string,
  metadata: Omit<LockPayload, "pid" | "acquiredAt">,
  parentLogger: Logger,
): Promise<SingleInstanceLock> {
  const logger = parentLogger.child("instance-lock");
  const lockPath = path.join(dataDir, "bridge.lock");
  const payload: LockPayload = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ...metadata,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.close();
      logger.info("Acquired bridge single-instance lock", payload);
      return new SingleInstanceLock(lockPath, logger);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }

      const existing = await readLockPayload(lockPath);
      if (existing && isProcessActive(existing.pid)) {
        throw new Error(
          `Another bridge instance is already running (pid ${existing.pid}, mode ${existing.sessionMode}/${existing.controlScope}).`,
        );
      }

      logger.warn("Removing stale bridge single-instance lock", {
        lockPath,
        existing,
      });
      await fs.rm(lockPath, { force: true });
    }
  }

  throw new Error("Could not acquire bridge single-instance lock.");
}

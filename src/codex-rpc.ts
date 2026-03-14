import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Logger } from "./logger.js";

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

type PendingResolver = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

function normalizeError(message: string, response?: JsonRpcResponse["error"]): Error {
  if (!response) {
    return new Error(message);
  }

  const error = new Error(`${message}: ${response.message}`);
  (error as Error & { code?: number; data?: unknown }).code = response.code;
  (error as Error & { code?: number; data?: unknown }).data = response.data;
  return error;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    "id" in value &&
    (typeof (value as { id: unknown }).id === "string" ||
      typeof (value as { id: unknown }).id === "number")
  );
}

export class CodexRpcClient {
  private readonly logger: Logger;
  private readonly notificationListeners = new Set<(message: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<(message: JsonRpcRequest) => void>();
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly pending = new Map<string, PendingResolver>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private stderrBuffer = "";

  public constructor(
    private readonly appRoot: string,
    private readonly codexBin: string | undefined,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child("codex-rpc");
  }

  public onNotification(listener: (message: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  public onServerRequest(listener: (message: JsonRpcRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  public onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  public async ensureStarted(): Promise<void> {
    if (this.child) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();

    const id = String(this.nextId++);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const child = this.child;
    if (!child) {
      throw new Error("Codex app-server is not running.");
    }

    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return responsePromise;
  }

  public async respond(id: string | number, result: unknown): Promise<void> {
    await this.ensureStarted();
    const child = this.child;

    if (!child) {
      throw new Error("Codex app-server is not running.");
    }

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  public async close(): Promise<void> {
    if (this.lineReader) {
      this.lineReader.close();
      this.lineReader = null;
    }

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(() => resolve(), 2_000);
    });
  }

  private async startInternal(): Promise<void> {
    const launch = this.resolveLaunchCommand();

    this.logger.info("Starting Codex app-server", launch);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.appRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stderr.on("data", (chunk) => {
      this.handleStderrChunk(chunk.toString());
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `Codex app-server exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      );
      for (const [id, pending] of this.pending) {
        pending.reject(error);
        this.pending.delete(id);
      }

      this.child = null;
      this.lineReader = null;
      this.stderrBuffer = "";
    });

    this.lineReader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.lineReader.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "feishu-codex-bridge",
        version: "0.1.0",
      },
      capabilities: {},
    });
  }

  private resolveLaunchCommand(): { command: string; args: string[] } {
    if (this.codexBin) {
      if (this.codexBin.endsWith(".js")) {
        return {
          command: process.execPath,
          args: [this.codexBin, "app-server"],
        };
      }

      return {
        command: this.codexBin,
        args: ["app-server"],
      };
    }

    const localEntry = path.join(
      this.appRoot,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );

    if (fs.existsSync(localEntry)) {
      return {
        command: process.execPath,
        args: [localEntry, "app-server"],
      };
    }

    const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
    return {
      command: npxCmd,
      args: ["codex", "app-server"],
    };
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
    } catch (error) {
      this.logger.warn("Failed to parse Codex JSON line", { line, error });
      return;
    }

    if ("id" in parsed && ("result" in parsed || "error" in parsed) && !("method" in parsed)) {
      const pending = this.pending.get(String(parsed.id));
      if (!pending) {
        return;
      }

      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        pending.reject(normalizeError("Codex RPC request failed", parsed.error));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (isJsonRpcRequest(parsed)) {
      for (const listener of this.requestListeners) {
        listener(parsed);
      }
      return;
    }

    if ("method" in parsed) {
      for (const listener of this.notificationListeners) {
        listener(parsed);
      }
    }
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      this.logger.warn("Codex stderr", line);
      for (const listener of this.stderrListeners) {
        listener(line);
      }
    }
  }
}

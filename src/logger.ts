import fs from "node:fs";
import path from "node:path";
import util from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function safeSerialize(meta: unknown): string {
  if (meta === undefined) {
    return "";
  }

  if (typeof meta === "string") {
    return meta;
  }

  return util.inspect(meta, {
    depth: 5,
    breakLength: 120,
    compact: true,
  });
}

export class Logger {
  public constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel,
    private readonly logFilePath?: string,
  ) {}

  public child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel, this.logFilePath);
  }

  public debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  public info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const suffix = meta === undefined ? "" : ` ${safeSerialize(meta)}`;
    const line = `${timestamp} ${level.toUpperCase()} [${this.scope}] ${message}${suffix}`;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (this.logFilePath) {
      fs.mkdirSync(path.dirname(this.logFilePath), { recursive: true });
      fs.appendFileSync(this.logFilePath, `${line}\n`, "utf8");
    }
  }
}

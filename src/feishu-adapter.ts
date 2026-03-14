import * as Lark from "@larksuiteoapi/node-sdk";

import { Logger } from "./logger.js";
import type { DeliveryReceipt, InboundChatMessage } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryGet(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;

  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function extractText(content: unknown): string | null {
  if (typeof content !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text.trim() : null;
  } catch {
    return null;
  }
}

function splitText(message: string, maxLength = 3000): string[] {
  const chunks: string[] = [];
  let remaining = message.trim();

  while (remaining.length > maxLength) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length === 0 ? [""] : chunks;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function extractStatusCode(error: unknown): number | null {
  if (!isObject(error)) {
    return null;
  }

  const directStatus = error.status;
  if (typeof directStatus === "number") {
    return directStatus;
  }

  const directStatusCode = error.statusCode;
  if (typeof directStatusCode === "number") {
    return directStatusCode;
  }

  const response = error.response;
  if (isObject(response)) {
    const responseStatus = response.status;
    if (typeof responseStatus === "number") {
      return responseStatus;
    }

    const responseStatusCode = response.statusCode;
    if (typeof responseStatusCode === "number") {
      return responseStatusCode;
    }
  }

  const cause = error.cause;
  return cause === undefined ? null : extractStatusCode(cause);
}

function extractErrorCode(error: unknown): string | null {
  if (!isObject(error)) {
    return null;
  }

  const directCode = error.code;
  if (typeof directCode === "string" && directCode.length > 0) {
    return directCode;
  }

  const errno = error.errno;
  if (typeof errno === "string" && errno.length > 0) {
    return errno;
  }

  const cause = error.cause;
  return cause === undefined ? null : extractErrorCode(cause);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (isObject(error)) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }

    const cause = error.cause;
    if (cause !== undefined) {
      return extractErrorMessage(cause);
    }
  }

  return "Unknown Feishu send failure";
}

export function shouldRetryFeishuSend(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode === 429 || (statusCode !== null && statusCode >= 500)) {
    return true;
  }

  const code = extractErrorCode(error)?.toUpperCase();
  if (
    code &&
    new Set([
      "ECONNRESET",
      "ECONNABORTED",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
      "ENOTFOUND",
    ]).has(code)
  ) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("socket disconnected") ||
    message.includes("connection reset") ||
    message.includes("temporarily unavailable") ||
    message.includes("tenant_access_token") ||
    (message.includes("access token") && message.includes("undefined"))
  );
}

export class FeishuSendError extends Error {
  public readonly attempts: number;
  public readonly statusCode: number | null;
  public readonly code: string | null;

  public constructor(message: string, attempts: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FeishuSendError";
    this.attempts = attempts;
    this.statusCode = extractStatusCode(cause);
    this.code = extractErrorCode(cause);
  }
}

export class FeishuAdapter {
  private readonly logger: Logger;
  private readonly client: Lark.Client;
  private readonly wsClient: Lark.WSClient;

  public constructor(
    appId: string,
    appSecret: string,
    private readonly encryptKey: string | undefined,
    private readonly sendMaxRetries: number,
    private readonly sendRetryBaseMs: number,
    parentLogger: Logger,
  ) {
    this.logger = parentLogger.child("feishu");
    this.client = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  public async start(handler: (message: InboundChatMessage) => Promise<void>): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({
      encryptKey: this.encryptKey,
    }).register({
      "im.message.receive_v1": async (data: unknown) => {
        const message = this.parseMessage(data);
        if (!message) {
          return;
        }

        void handler(message).catch((error: unknown) => {
          this.logger.error("Failed to handle inbound Feishu message", error);
        });
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.logger.info("Feishu long-connection client started");
  }

  public async stop(): Promise<void> {
    await this.wsClient.close({ force: true });
  }

  public async sendText(chatId: string, text: string): Promise<DeliveryReceipt> {
    let totalAttempts = 0;
    const chunks = splitText(text);

    for (const chunk of chunks) {
      try {
        totalAttempts += await this.sendChunkWithRetry(chatId, chunk);
      } catch (error) {
        if (error instanceof FeishuSendError) {
          throw new FeishuSendError(error.message, totalAttempts + error.attempts, error.cause);
        }

        throw new FeishuSendError(
          `Failed to send Feishu message: ${extractErrorMessage(error)}`,
          totalAttempts,
          error,
        );
      }
    }

    return {
      attempts: totalAttempts,
      chunkCount: chunks.length,
    };
  }

  private async sendChunkWithRetry(chatId: string, chunk: string): Promise<number> {
    let attempt = 0;

    while (true) {
      attempt += 1;

      try {
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: chunk }),
          },
        });

        return attempt;
      } catch (error) {
        const retryable = shouldRetryFeishuSend(error);
        if (!retryable || attempt > this.sendMaxRetries) {
          throw new FeishuSendError(
            `Failed to send Feishu message: ${extractErrorMessage(error)}`,
            attempt,
            error,
          );
        }

        const backoffMs = this.sendRetryBaseMs * 2 ** (attempt - 1);
        this.logger.warn("Retrying Feishu message send", {
          chatId,
          attempt,
          backoffMs,
          code: extractErrorCode(error),
          statusCode: extractStatusCode(error),
          message: extractErrorMessage(error),
        });
        await wait(backoffMs);
      }
    }
  }

  private parseMessage(input: unknown): InboundChatMessage | null {
    if (!isObject(input)) {
      return null;
    }

    const event = isObject(input.event) ? input.event : input;
    const message = tryGet(event, ["message"]);
    const sender = tryGet(event, ["sender"]);

    if (!isObject(message)) {
      return null;
    }

    const messageType =
      tryGet(message, ["message_type"]) ??
      tryGet(message, ["msg_type"]);

    if (messageType !== "text") {
      return null;
    }

    const text = extractText(tryGet(message, ["content"]));
    const chatId = tryGet(message, ["chat_id"]);
    const messageId = tryGet(message, ["message_id"]);
    const chatType =
      (tryGet(message, ["chat_type"]) as string | undefined) ?? "unknown";
    const openId =
      (tryGet(sender as Record<string, unknown>, ["sender_id", "open_id"]) as string | undefined) ??
      (tryGet(sender as Record<string, unknown>, ["id", "open_id"]) as string | undefined);

    if (!text || typeof chatId !== "string" || typeof messageId !== "string" || !openId) {
      this.logger.warn("Skipping message because required fields are missing", input);
      return null;
    }

    return {
      messageId,
      chatId,
      openId,
      chatType,
      text,
      raw: input,
    };
  }
}

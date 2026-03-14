const SECRET_KEY_PATTERN =
  /(secret|token|api[_-]?key|password|authorization|cookie|session)/i;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

export function redactSensitiveText(text: string): string {
  let redacted = text;

  redacted = redacted.replace(
    /\b((?:app[_ -]?secret|secret|token|api[_ -]?key|password|authorization|cookie|session)[\w -]{0,24}[:=]\s*)([^\s,;]+)/gi,
    "$1[redacted]",
  );

  redacted = redacted.replace(/\b(cli_[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{24,})\b/g, (value) => {
    if (/^(?:[A-Za-z]:\\|\\\\)/.test(value)) {
      return value;
    }

    return "[redacted]";
  });

  return redacted;
}

export function sanitizeStoredText(
  value: string | null | undefined,
  maxLength = 180,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = redactSensitiveText(collapseWhitespace(value));
  if (!normalized) {
    return null;
  }

  return truncateText(normalized, maxLength);
}

export function sanitizeAuditDetails(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    return sanitizeStoredText(value, 240) ?? "";
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditDetails(item, depth + 1));
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = SECRET_KEY_PATTERN.test(key)
        ? "[redacted]"
        : sanitizeAuditDetails(entry, depth + 1);
    }

    return sanitized;
  }

  return String(value);
}

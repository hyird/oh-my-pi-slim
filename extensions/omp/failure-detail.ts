import { safeText } from "./conversation-content.ts";

const MAX_DETAIL = 600;

/** Format untrusted failures for task results/logs without exposing common credentials. */
export function failureDetail(value: unknown, limit = MAX_DETAIL): string | undefined {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    const errorCode = current && typeof current === "object" && "code" in current
      ? String((current as { code: unknown }).code)
      : undefined;
    const message = current instanceof Error
      ? `${errorCode ? `${errorCode}: ` : ""}${current.message}`
      : typeof current === "string"
        ? current
        : current && typeof current === "object" && "message" in current
          ? String((current as { message: unknown }).message)
          : depth === 0
            ? String(current)
            : "";
    const clean = safeText(message)
      .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
      .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[redacted]")
      .replace(/:\/\/[^/@\s:]+:[^/@\s]+@/g, "://[redacted]@")
      .trim();
    if (clean && !messages.includes(clean)) messages.push(clean);
    current = current instanceof Error ? current.cause : undefined;
  }
  const result = messages.join(" <- ").slice(0, limit);
  return result || undefined;
}

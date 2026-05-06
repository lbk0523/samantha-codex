import { createHash } from "node:crypto";

export function shortHash(value: string, length = 8): string {
  return createHash("sha1").update(value).digest("hex").slice(0, length);
}

export function compactTimestampToken(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.replace(/[:.]/g, "-").toLowerCase();
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

export function readableSlug(value: string, maxLength = 32): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = normalized;
  if (normalized.length > maxLength) {
    slug = normalized.slice(0, maxLength).replace(/-+$/g, "");
    if (normalized[maxLength] !== "-" && slug.includes("-")) {
      slug = slug.replace(/-[^-]*$/g, "");
    }
  }
  return slug || "item";
}

export function compactEntityId(input: {
  prefix: string;
  createdAt: string;
  label?: string;
  source?: string;
  maxLabelLength?: number;
}): string {
  const source = input.source ?? input.label ?? input.createdAt;
  const label = input.label ? `-${readableSlug(input.label, input.maxLabelLength ?? 32)}` : "";
  return `${input.prefix}-${compactTimestampToken(input.createdAt)}${label}-${shortHash(source)}`;
}

export function compactOutboxFileName(input: {
  createdAt: string;
  kind: string;
  label?: string;
  source: string;
}): string {
  return `remote-${compactTimestampToken(input.createdAt)}-${readableSlug(input.kind, 16)}-${readableSlug(input.label ?? "report", 28)}-${shortHash(input.source)}.md`;
}

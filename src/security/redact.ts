const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
];

export function redact(text: string, explicitSecrets: readonly string[] = []): string {
  let value = text;
  const secrets = [...new Set(explicitSecrets.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  for (const secret of secrets) value = value.split(secret).join("<redacted>");
  for (const pattern of secretPatterns) value = value.replace(pattern, "<redacted>");
  return value;
}

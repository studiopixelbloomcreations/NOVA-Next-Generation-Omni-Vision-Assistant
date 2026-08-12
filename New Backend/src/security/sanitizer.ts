// New Backend — security/sanitizer.ts
// PII/secret scrubbing for logs, memory and prompts. Secrets must never be
// persisted into memory or emitted into prompts.
const SECRET_PATTERNS = [
  /(api[_-]?key|token|password|secret|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-\.]{6,}/gi,
  /sk-[A-Za-z0-9_\-]{16,}/g,
  /AIza[0-9A-Za-z_\-]{20,}/g,
  /\b(?:ghp_|gho_|glp_|sk_|xox[baprs]-|eyJ)[A-Za-z0-9_\-]{10,}/g,
];

export function sanitizeSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => m.replace(/[^\s:=]/g, '*'));
  return out;
}

export class PiiSanitizer {
  static sanitize(text: string): string {
    return sanitizeSecrets(String(text ?? ''));
  }
}

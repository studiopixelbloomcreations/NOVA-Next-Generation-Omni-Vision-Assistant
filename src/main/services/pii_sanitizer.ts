export class PiiSanitizer {
  private static readonly PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
    { regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[REDACTED]' },
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED]' },
    { regex: /\b(?:AIzaSy|AQ\.|AI|ya29\.)[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED]' },
    { regex: /"password"\s*:\s*"[^"]+"/g, replacement: '"password":"[REDACTED]"' },
    { regex: /(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*[=:]\s*[^\s"']+/g, replacement: '[REDACTED]' },
  ];

  static sanitize(text: string): string {
    let result = text;
    for (const pattern of this.PATTERNS) {
      result = result.replace(pattern.regex, pattern.replacement);
    }
    return result;
  }

  static sanitizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return this.sanitize(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item));
    }
    if (obj !== null && typeof obj === 'object') {
      const sanitized: Record<string, any> = {};
      for (const key of Object.keys(obj)) {
        sanitized[key] = this.sanitizeObject((obj as Record<string, any>)[key]);
      }
      return sanitized;
    }
    return obj;
  }
}

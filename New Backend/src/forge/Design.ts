// New Backend — forge/Design.ts
// ForgeDesign model + robust JSON extraction from model output.
import type { ToolPermission } from '../contracts/domain.js';

export interface ForgeDesign {
  displayName: string;
  technicalId: string;
  description: string;
  category: string;
  capabilities: string[];
  permissions: ToolPermission[];
  dependencies: string[];
  pythonSource: string;
  testSource: string;
}

/** Extracts a ForgeDesign JSON object from possibly-markdown-fenced model text. */
export function extractDesign(raw: string): Partial<ForgeDesign> | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as Partial<ForgeDesign>;
  } catch {
    // Repair illegal literal control chars inside JSON string values.
    let repaired = '';
    let inString = false;
    let escaped = false;
    for (const ch of candidate) {
      if (escaped) { repaired += ch; escaped = false; continue; }
      if (ch === '\\') { repaired += ch; escaped = true; continue; }
      if (ch === '"') { repaired += ch; inString = !inString; continue; }
      if (inString && ch === '\n') repaired += '\\n';
      else if (inString && ch === '\r') repaired += '\\r';
      else if (inString && ch === '\t') repaired += '\\t';
      else repaired += ch;
    }
    try {
      return JSON.parse(repaired) as Partial<ForgeDesign>;
    } catch {
      return null;
    }
  }
}

/** Deterministic human-friendly default design (only as a base for fields). */
export function defaultDesign(intent: string): ForgeDesign {
  const slug = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'nova_tool';
  return {
    displayName: intent.slice(0, 48),
    technicalId: slug,
    description: `Generated capability: ${intent.slice(0, 120)}`,
    category: 'utility',
    capabilities: [],
    permissions: [],
    dependencies: [],
    pythonSource: '',
    testSource: '',
  };
}

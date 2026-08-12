// New Backend — forge/NamingEngine.ts
// Tool Naming Engine. Maintains both a human-friendly displayName and a stable
// technicalId. The AI proposes the name; the system validates uniqueness and
// slug-safety, so we never get `generated_tool_17`.
export class NamingEngine {
  constructor(private readonly existingTechnicalIds: () => string[], private readonly existingDisplayNames: () => string[]) {}

  /** Normalize a technical id: lowercase, alphanumeric + underscore, unique. */
  normalizeTechnicalId(proposed: string, fallback = 'nova_tool'): string {
    const base = (proposed || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
    const candidate = base || fallback;
    return this.ensureUniqueTechnical(candidate);
  }

  private ensureUniqueTechnical(id: string): string {
    const existing = new Set(this.existingTechnicalIds());
    if (!existing.has(id)) return id;
    let n = 2;
    while (existing.has(`${id}_${n}`)) n += 1;
    return `${id}_${n}`;
  }

  /** Validate a display name is non-empty, sane length and unique. */
  resolveDisplayName(proposed: string, technicalId: string): string {
    const trimmed = (proposed || '').trim().slice(0, 64);
    const name = trimmed || this.humanize(technicalId);
    return this.ensureUniqueDisplay(name);
  }

  private ensureUniqueDisplay(name: string): string {
    const existing = new Set(this.existingDisplayNames());
    if (!existing.has(name)) return name;
    let n = 2;
    while (existing.has(`${name} ${n}`)) n += 1;
    return `${name} ${n}`;
  }

  private humanize(id: string): string {
    return id
      .replace(/[_]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
}

// New Backend — security/path_guard.ts
// Filesystem sandboxing. Tool-generated paths may only resolve inside the
// NOVA tools root or the user's Desktop/Documents/Downloads. Any escape is a
// hard PathEscapeError (BLOCK).
import { resolve, sep, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { PathEscapeError } from '../core/errors.js';
import { Nova2Config } from '../core/config.js';

export class PathGuard {
  private readonly roots: string[];

  constructor(customRoots?: string[]) {
    const home = Nova2Config.home || homedir();
    this.roots = customRoots?.length
      ? customRoots.map(p => resolve(p))
      : [
          resolve(Nova2Config.paths.toolsRoot),
          resolve(join(home, 'Desktop')),
          resolve(join(home, 'Documents')),
          resolve(join(home, 'Downloads')),
        ];
  }

  /** Resolves a possibly-relative path inside the allowed roots. */
  resolveInside(root: string, requested: string): string {
    if (typeof requested !== 'string' || !requested.trim()) {
      throw new PathEscapeError('A non-empty relative path is required.');
    }
    const resolved = resolve(root, requested);
    const base = resolve(root).endsWith(sep) ? resolve(root) : resolve(root) + sep;
    if (resolved !== resolve(root) && !resolved.startsWith(base)) {
      throw new PathEscapeError(`Path "${requested}" escapes the sandbox.`);
    }
    return resolved;
  }

  /** Resolves a host path that must live in Desktop/Documents/Downloads. */
  resolveHostPath(requested: string): string {
    const raw = String(requested ?? '').trim();
    if (!raw) throw new PathEscapeError('A non-empty host path is required.');
    const home = Nova2Config.home || homedir();
    const roots = [join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')].map(p => resolve(p));
    const named = raw.match(/^(desktop|downloads?|documents?)[\\/]*(.*)$/i);
    let target: string;
    if (named) {
      const base =
        /^desktop$/i.test(named[1]) ? roots[0] :
        /^downloads?$/i.test(named[1]) ? roots[2] : roots[1];
      target = join(base, named[2] ?? '');
    } else {
      target = isAbsolute(raw) ? raw : join(roots[0], raw);
    }
    const resolved = resolve(target);
    const allowed = roots.some(root => resolved === root || resolved.startsWith(root + sep));
    if (!allowed) throw new PathEscapeError('Host path must be inside Desktop, Documents, or Downloads.');
    return resolved;
  }

  isInsideAllowedRoot(target: string): boolean {
    const resolved = resolve(target);
    return this.roots.some(root => resolved === root || resolved.startsWith(root + sep));
  }

  get allowedRoots(): string[] {
    return [...this.roots];
  }
}

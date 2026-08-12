// New Backend — workspace/WorkspaceEngine.ts
// Workspace Engine. Workspace-first: content is presented INSIDE NOVA via
// typed surfaces (web, video, image, pdf, file, note, news, tool-result, code).
// External browser/app execution only happens when explicitly requested. This
// engine only orchestrates backend state — the UI rendering is untouched.
import { randomUUID } from 'node:crypto';
import { JsonFileStorage } from '../persistence/storage.js';
import { logger } from '../core/logger.js';

export type SurfaceType = 'web' | 'video' | 'image' | 'pdf' | 'file' | 'note' | 'news' | 'tool-result' | 'code';

export interface WorkspaceSurface {
  id: string;
  type: SurfaceType;
  title: string;
  source: string;
  content?: string;
  state: 'open' | 'closed';
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

export class WorkspaceEngine {
  private surfaces: WorkspaceSurface[] = [];
  private storage: JsonFileStorage;
  onUpdate?: (surfaces: WorkspaceSurface[]) => void;

  constructor(userData: string) {
    this.storage = new JsonFileStorage(userData, 'workspace');
    const loaded = this.storage.get<WorkspaceSurface[]>('surfaces');
    this.surfaces = Array.isArray(loaded) ? loaded : [];
  }

  list(): WorkspaceSurface[] {
    return this.surfaces.filter(s => s.state === 'open');
  }

  open(input: { type: SurfaceType; title: string; source: string; content?: string; taskId?: string }): WorkspaceSurface {
    const now = Date.now();
    const surface: WorkspaceSurface = {
      id: randomUUID(),
      type: input.type,
      title: input.title.slice(0, 160),
      source: input.source,
      content: input.content,
      state: 'open',
      taskId: input.taskId,
      createdAt: now,
      updatedAt: now,
    };
    this.surfaces.push(surface);
    this.persist();
    this.push();
    return surface;
  }

  close(id: string): boolean {
    const surface = this.surfaces.find(s => s.id === id);
    if (!surface) return false;
    surface.state = 'closed';
    surface.updatedAt = Date.now();
    this.persist();
    this.push();
    return true;
  }

  /** Validate that a workspace URL is an http(s) or local file target. */
  static validateSource(url: string): boolean {
    return /^https?:\/\//i.test(url) || url.startsWith('file://');
  }

  private persist(): void {
    this.storage.set('surfaces', this.surfaces);
    this.storage.flush();
  }

  private push(): void {
    try {
      this.onUpdate?.(this.list());
    } catch (err) {
      logger.error('[workspace] update push failed', { error: String(err) });
    }
  }

  closeAll(): void {
    for (const s of this.surfaces) s.state = 'closed';
    this.persist();
    this.push();
  }

  flush(): void {
    this.storage.flush();
  }

  closeStore(): void {
    this.storage.close();
  }
}

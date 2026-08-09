// src/main/services/workspace_manager.ts
// NOVA Workspace Manager — internal surfaces for everything NOVA presents.
//
// Workspace-first rule: unless the user EXPLICITLY asks to open something
// outside NOVA ("in Chrome", "outside", "external browser", ...), content —
// web pages, videos, news, images, PDFs, files, tool results — is shown
// inside the NOVA workspace as a typed surface instead of being delegated to
// external applications. The renderer renders each surface; the agent opens
// and closes surfaces through the workspace builtin tools.
//
// Surfaces are persisted to a JSON file inside the NOVA workspace directory
// (survives restarts) and broadcast to the renderer on every change.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  IWorkspaceSurface,
  IWorkspaceUpdatePayload,
  WorkspaceSurfaceType,
} from '../../shared/ipc_protocols';

export const WORKSPACE_SURFACES_FILE = 'surfaces.json';

/** Cap on simultaneously open surfaces (bounded memory). */
const MAX_SURFACES = 12;

export interface WorkspaceSurfaceInput {
  id?: string;
  type: WorkspaceSurfaceType;
  title: string;
  source: string;
  content?: string;
  taskId?: string;
}

export class WorkspaceManager {
  private surfaces: IWorkspaceSurface[] = [];
  private rootDir: string;
  private filePath: string;
  private loaded = false;
  /** Broadcast hook wired by the main process (pushes to the renderer). */
  public onUpdate: ((payload: IWorkspaceUpdatePayload) => void) | null = null;

  constructor(rootDir: string, onUpdate?: (payload: IWorkspaceUpdatePayload) => void) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, WORKSPACE_SURFACES_FILE);
    if (onUpdate) this.onUpdate = onUpdate;
  }

  /** Ensures the workspace dir exists and hydrates persisted surfaces. */
  public load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as { surfaces?: IWorkspaceSurface[] };
        if (Array.isArray(parsed.surfaces)) {
          const seen = new Set<string>();
          this.surfaces = parsed.surfaces
            .filter(s => s && s.state === 'open')
            .filter(s => {
              const key = `${s.type}|${s.source}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .slice(0, MAX_SURFACES);
        }
      }
    } catch {
      // Corrupt/missing state is never fatal — start with an empty workspace.
      this.surfaces = [];
    }
  }

  /** Opens (or updates) a surface and broadcasts the new state. */
  public open(input: WorkspaceSurfaceInput): IWorkspaceSurface {
    this.load();
    const now = Date.now();
    const existingId = input.id
      ? this.surfaces.find(s => s.id === input.id)
      : this.surfaces.find(s => s.type === input.type && s.source === input.source);
    let surface: IWorkspaceSurface;
    if (existingId) {
      surface = {
        ...existingId,
        type: input.type,
        title: input.title,
        source: input.source,
        content: input.content,
        taskId: input.taskId ?? existingId.taskId,
        state: 'open',
        updatedAt: now,
      };
      this.surfaces = this.surfaces.map(s => (s.id === existingId.id ? surface : s));
    } else {
      surface = {
        id: input.id ?? crypto.randomUUID(),
        type: input.type,
        title: input.title,
        source: input.source,
        content: input.content,
        state: 'open',
        taskId: input.taskId,
        createdAt: now,
        updatedAt: now,
      };
      this.surfaces = [surface, ...this.surfaces].slice(0, MAX_SURFACES);
    }
    this.persistAndBroadcast();
    return surface;
  }

  /** Patches an existing surface. Returns the updated surface or null. */
  public update(id: string, patch: Partial<IWorkspaceSurface>): IWorkspaceSurface | null {
    this.load();
    const target = this.surfaces.find(s => s.id === id);
    if (!target) return null;
    const updated: IWorkspaceSurface = { ...target, ...patch, id: target.id, updatedAt: Date.now() };
    this.surfaces = this.surfaces.map(s => (s.id === id ? updated : s));
    this.persistAndBroadcast();
    return updated;
  }

  /** Closes a surface. Returns false when the id is unknown. */
  public close(id: string): boolean {
    this.load();
    const target = this.surfaces.find(s => s.id === id);
    if (!target) return false;
    this.surfaces = this.surfaces.filter(s => s.id !== id);
    this.persistAndBroadcast();
    return true;
  }

  /** Lists open surfaces (newest first). */
  public list(): IWorkspaceSurface[] {
    this.load();
    return [...this.surfaces];
  }

  public get(id: string): IWorkspaceSurface | null {
    this.load();
    return this.surfaces.find(s => s.id === id) ?? null;
  }

  public count(): number {
    return this.surfaces.length;
  }

  private persistAndBroadcast(): void {
    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ surfaces: this.surfaces }, null, 2),
        'utf-8',
      );
    } catch (err) {
      // Persistence failures must never crash the app; state stays live.
      console.warn('[workspace] failed to persist surfaces:', err);
    }
    if (this.onUpdate) {
      try {
        this.onUpdate({ surfaces: this.list() });
      } catch (err) {
        console.warn('[workspace] broadcast failed:', err);
      }
    }
  }
}

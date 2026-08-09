// src/main/services/spatial_memory.ts
import { BrowserWindow } from 'electron';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class SpatialMemory {
  private boundsMap: Map<string, Bounds> = new Map();
  private recencyOrder: string[] = [];

  public recordBounds(appName: string, bounds: Bounds): void {
    this.boundsMap.set(appName, bounds);
    this.recencyOrder = this.recencyOrder.filter(name => name !== appName);
    this.recencyOrder.unshift(appName);
  }

  public getBounds(appName: string): Bounds | undefined {
    return this.boundsMap.get(appName);
  }

  public restoreBounds(appName: string, window: BrowserWindow): void {
    const bounds = this.boundsMap.get(appName);
    if (bounds) {
      window.setBounds(bounds);
    }
  }

  public getRecentApps(limit: number = 10): string[] {
    return this.recencyOrder.slice(0, limit);
  }
}

export const spatialMemory = new SpatialMemory();

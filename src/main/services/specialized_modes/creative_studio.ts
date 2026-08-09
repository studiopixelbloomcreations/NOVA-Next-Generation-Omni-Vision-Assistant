// src/main/services/specialized_modes/creative_studio.ts
import { EventEmitter } from 'events';
import { desktopCapturer } from 'electron';
import { IModePayload } from '../../../shared/ipc_protocols';

export class CreativeStudio extends EventEmitter {
  private activeApp = '';

  public async detectActiveApp(): Promise<IModePayload | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
      });

      const creativeKeywords = [
        'photoshop',
        'figma',
        'canva',
        'blender',
        'after effects',
        'premiere',
        'illustrator',
        'indesign',
        'lightroom',
        'procreate',
        'clip studio',
        'krita',
        'gimp',
        'sketch',
        'affinity',
        'da vinci',
        'resolve',
        'final cut',
        'logic pro',
        'ableton',
        'fl studio',
      ];

      for (const source of sources) {
        const title = source.name.toLowerCase();
        for (const keyword of creativeKeywords) {
          if (title.includes(keyword)) {
            this.activeApp = keyword;
            this.emit('mode-activated', { mode: 'CREATIVE', app: this.activeApp });
            return { mode: 'CREATIVE', app: this.activeApp };
          }
        }
      }

      this.activeApp = '';
      return null;
    } catch (err) {
      console.error('[CreativeStudio] App detection failed:', err);
      return null;
    }
  }

  public async captureCanvasRegion(): Promise<string | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (sources.length > 0 && sources[0].thumbnail) {
        const base64 = sources[0].thumbnail.toDataURL().split(',')[1];
        return base64;
      }
    } catch (err) {
      console.error('[CreativeStudio] Capture failed:', err);
    }
    return null;
  }

  public checkContrast(foreground: string, background: string): number {
    const fgLum = this.getLuminance(foreground);
    const bgLum = this.getLuminance(background);
    const ratio = (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
    return Math.round(ratio * 100) / 100;
  }

  private getLuminance(hex: string): number {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;

    const [rs, gs, bs] = [r, g, b].map(c =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    );

    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
  }

  public detectAlignmentGrid(imageData: ImageData): Array<{ x: number; y: number; angle: number }> {
    const { width, height, data } = imageData;
    const gray = new Float32Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    const edges = new Float32Array(width * height);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let gx = 0;
        let gy = 0;

        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = (y + ky) * width + (x + kx);
            const kernelIdx = (ky + 1) * 3 + (kx + 1);
            gx += gray[idx] * sobelX[kernelIdx];
            gy += gray[idx] * sobelY[kernelIdx];
          }
        }

        edges[y * width + x] = Math.sqrt(gx * gx + gy * gy);
      }
    }

    const lines: Array<{ x: number; y: number; angle: number }> = [];
    const threshold = 100;

    for (let y = 0; y < height; y += 10) {
      for (let x = 0; x < width; x += 10) {
        if (edges[y * width + x] > threshold) {
          const angle = Math.atan2(
            edges[Math.min(y + 1, height - 1) * width + x] - edges[Math.max(y - 1, 0) * width + x],
            edges[y * width + Math.min(x + 1, width - 1)] - edges[y * width + Math.max(x - 1, 0)]
          );

          lines.push({ x, y, angle });
        }
      }
    }

    return lines;
  }
}

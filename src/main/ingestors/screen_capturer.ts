// src/main/ingestors/screen_capturer.ts
import { EventEmitter } from 'events';
import { screen, desktopCapturer } from 'electron';

// Attempt to load the native module; otherwise, use the JavaScript block-hash fallback.
let nativeModule: any = null;
try {
  nativeModule = require('../../../native_modules/index.node');
} catch (e) {
  console.warn('Native Rust module index.node not found. Utilizing JavaScript block-hash fallback.');
}

const BLOCK_SIZE = 128;
// Hash every 4th pixel within a block; enough entropy for delta detection
// at a fraction of the cost of full-pixel scans.
const PIXEL_SAMPLE_STRIDE = 4;

export interface IScreenTelemetry {
  width: number;
  height: number;
  frameRate: number;
  mutatedBlocks: number;
  totalBlocks: number;
}

export class ScreenCapturer extends EventEmitter {
  private isCapturing: boolean = false;
  private prevHashes: number[] = [];
  private readonly frameRate: number;
  private timerId: NodeJS.Timeout | null = null;
  private hasLoggedCaptureError: boolean = false;

  private lastWidth: number = 0;
  private lastHeight: number = 0;
  private lastMutatedBlocks: number = 0;
  private lastTotalBlocks: number = 0;

  constructor(frameRate: number = 2) {
    super();
    this.frameRate = frameRate;
  }

  public startCapture(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;
    void this.captureLoop();
  }

  public stopCapture(): void {
    this.isCapturing = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  public getTelemetry(): IScreenTelemetry {
    return {
      width: this.lastWidth,
      height: this.lastHeight,
      frameRate: this.frameRate,
      mutatedBlocks: this.lastMutatedBlocks,
      totalBlocks: this.lastTotalBlocks,
    };
  }

  private async captureLoop(): Promise<void> {
    if (!this.isCapturing) return;

    try {
      const primary = screen.getPrimaryDisplay();
      const { width: displayWidth, height: displayHeight } = primary.size;
      const requestWidth = Math.round(displayWidth * primary.scaleFactor);
      const requestHeight = Math.round(displayHeight * primary.scaleFactor);

      let currHashes: number[] | null = null;
      let frameWidth = 0;
      let frameHeight = 0;

      if (
        nativeModule &&
        typeof nativeModule.capture_frame === 'function' &&
        typeof nativeModule.calculateBlock_hashes === 'function'
      ) {
        const buffer: Buffer = nativeModule.capture_frame();
        frameWidth = requestWidth;
        frameHeight = requestHeight;
        currHashes = nativeModule.calculateBlock_hashes(buffer, frameWidth, frameHeight, BLOCK_SIZE);
      } else {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: requestWidth, height: requestHeight },
        });
        const thumbnail = sources.length > 0 ? sources[0].thumbnail : null;
        if (thumbnail && !thumbnail.isEmpty()) {
          const size = thumbnail.getSize();
          frameWidth = size.width;
          frameHeight = size.height;
          // Raw BGRA bytes — the block hasher indexes the pixel grid directly,
          // which is only valid on uncompressed bitmap data.
          const bitmap = thumbnail.toBitmap();
          currHashes = this.calculateBlockHashes(bitmap, frameWidth, frameHeight, BLOCK_SIZE);
        }
      }

      if (currHashes) {
        const mutated = this.findMutatedBlocks(this.prevHashes, currHashes);

        this.lastWidth = frameWidth;
        this.lastHeight = frameHeight;
        this.lastMutatedBlocks = mutated.length;
        this.lastTotalBlocks = currHashes.length;
        this.prevHashes = currHashes;
        this.hasLoggedCaptureError = false;

        if (mutated.length > 0) {
          this.emit('delta-detected', {
            mutatedCount: mutated.length,
            totalBlocks: currHashes.length,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      if (!this.hasLoggedCaptureError) {
        this.hasLoggedCaptureError = true;
        console.error('[screen_capturer] capture cycle failed (suppressing repeats until recovery):', err);
      }
    } finally {
      if (this.isCapturing) {
        this.timerId = setTimeout(() => {
          void this.captureLoop();
        }, 1000 / this.frameRate);
      }
    }
  }

  private calculateBlockHashes(buffer: Buffer, width: number, height: number, blockSize: number): number[] {
    const cols = Math.ceil(width / blockSize);
    const rows = Math.ceil(height / blockSize);
    const hashes: number[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const startX = c * blockSize;
        const startY = r * blockSize;
        const endX = Math.min(startX + blockSize, width);
        const endY = Math.min(startY + blockSize, height);

        // FNV-1a 32-bit over sampled BGRA pixels.
        let hash = 0x811c9dc5;
        for (let y = startY; y < endY; y++) {
          const rowOffset = y * width;
          for (let x = startX; x < endX; x += PIXEL_SAMPLE_STRIDE) {
            const pixelIdx = (rowOffset + x) * 4;
            if (pixelIdx + 3 < buffer.length) {
              hash = Math.imul(hash ^ buffer[pixelIdx], 0x01000193);
              hash = Math.imul(hash ^ buffer[pixelIdx + 1], 0x01000193);
              hash = Math.imul(hash ^ buffer[pixelIdx + 2], 0x01000193);
              hash = Math.imul(hash ^ buffer[pixelIdx + 3], 0x01000193);
            }
          }
        }
        hashes.push(hash >>> 0);
      }
    }
    return hashes;
  }

  private findMutatedBlocks(prevHashes: number[], currHashes: number[]): number[] {
    if (nativeModule && typeof nativeModule.findMutated_blocks === 'function') {
      return nativeModule.findMutated_blocks(prevHashes, currHashes);
    }

    const mutated: number[] = [];
    const minLen = Math.min(prevHashes.length, currHashes.length);
    for (let i = 0; i < minLen; i++) {
      if (prevHashes[i] !== currHashes[i]) {
        mutated.push(i);
      }
    }
    for (let i = prevHashes.length; i < currHashes.length; i++) {
      mutated.push(i);
    }
    return mutated;
  }
}

export const screenCapturer = new ScreenCapturer();

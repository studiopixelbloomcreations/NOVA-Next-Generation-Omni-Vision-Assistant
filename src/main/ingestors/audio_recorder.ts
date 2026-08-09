// src/main/ingestors/audio_recorder.ts
import { BrowserWindow } from 'electron';

export interface AudioFrame {
  data: Float32Array;
  timestamp: number;
  sampleRate: number;
}

export class AudioRecorderManager {
  private mainWindow: BrowserWindow | null = null;
  private isRecording = false;

  public setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  public startRecording(): void {
    if (this.isRecording || !this.mainWindow) return;
    this.isRecording = true;
    this.mainWindow.webContents.send('audio-recorder:start');
  }

  public stopRecording(): void {
    if (!this.isRecording || !this.mainWindow) return;
    this.isRecording = false;
    this.mainWindow.webContents.send('audio-recorder:stop');
  }

  public onAudioFrame(_callback: (frame: AudioFrame) => void): void {
    // This would be called from the renderer via IPC
    // Implementation would go here
  }
}

export const audioRecorderManager = new AudioRecorderManager();
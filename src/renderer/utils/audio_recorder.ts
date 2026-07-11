// src/renderer/utils/audio_recorder.ts
let ipcRenderer: any = null;
try {
  if (typeof window !== 'undefined' && (window as any).require) {
    ipcRenderer = (window as any).require('electron').ipcRenderer;
  }
} catch (e) {
  ipcRenderer = null;
}

import { browserBridge } from './browser_bridge';

export class AudioRecorder {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  // Ensure the audio context exists and is resumed. Can be called from a user gesture.
  public async resumeAudio(): Promise<void> {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
    } catch (e) {
      console.warn('resumeAudio failed:', e);
    }
  }

  public async startRecording(onAmplitudeUpdate: (amp: number) => void): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Ensure the audio context exists and is resumed. This may need a user gesture.
      await this.resumeAudio();
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      
      // Use 2048 buffer size for real-time low latency
      this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
      
      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Compute amplitude RMS
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        onAmplitudeUpdate(rms);

        // Convert Float32Array to 16-bit signed PCM (Int16Array)
        const pcmBuffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const sample = Math.max(-1, Math.min(1, inputData[i]));
          pcmBuffer[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        }

        if (ipcRenderer) {
          // Send Node Buffer over IPC to the main process
          const buf = Buffer.from(pcmBuffer.buffer);
          ipcRenderer.send('user-audio-chunk', buf);
        } else {
          // Browser fallback: encode to base64 and send as realtimeInput.audio JSON
          const u8 = new Uint8Array(pcmBuffer.buffer);
          let binary = '';
          for (let i = 0; i < u8.length; i++) {
            binary += String.fromCharCode(u8[i]);
          }
          const base64 = (typeof btoa === 'function') ? btoa(binary) : Buffer.from(u8).toString('base64');

          const message = {
            realtimeInput: {
              audio: {
                data: base64,
                mimeType: 'audio/pcm;rate=16000',
              },
            },
          };

          browserBridge.sendRaw(message);
        }
      };
    } catch (err) {
      console.error('Failed to initialize microphone hardware capture:', err);
      throw err;
    }
  }

  public stopRecording(): void {
    if (this.processor) {
      // Release the onaudioprocess closure (and its captured stream) before
      // disconnecting, so the graph doesn't keep the microphone alive.
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}

export const audioRecorder = new AudioRecorder();

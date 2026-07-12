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
  private vadWorklet: AudioWorkletNode | null = null;

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
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      
      await this.resumeAudio();
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      
      this.source = this.audioCtx.createMediaStreamSource(this.stream);

      // Use 512 sample buffer for ~32ms frames at 16kHz (good for VAD)
      this.processor = this.audioCtx.createScriptProcessor(512, 1, 1);
      
      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Compute amplitude RMS for UI
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

        // Send PCM to main process for VAD processing
        if (ipcRenderer) {
          const buf = Buffer.from(pcmBuffer.buffer);
          ipcRenderer.send('user-audio-chunk', buf);
        } else {
          // Browser fallback
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
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.vadWorklet) {
      this.vadWorklet.disconnect();
      this.vadWorklet = null;
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
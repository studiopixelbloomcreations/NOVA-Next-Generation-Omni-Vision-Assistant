import React, { useState, useEffect, useRef } from 'react';
import { MainUI } from './renderer/components/MainUI';
import { HUDUI } from './renderer/components/HUDUI';
import { WindowControls } from './renderer/components/WindowControls';
import { audioRecorder } from './renderer/utils/audio_recorder';
import {
  NovaVoiceState,
  NovaIpcChannel,
  IVoiceStatePayload,
  ISystemTelemetryPayload,
  IContextChipPayload,
} from './shared/ipc_protocols';
import { ITranscriptEntry } from './renderer/components/RightPanel';
import { browserBridge } from './renderer/utils/browser_bridge';

// Check if running in Electron environment
const isElectron = typeof window !== 'undefined' && window.process && (window.process as any).type === 'renderer';
const ipcRenderer = isElectron ? (window as any).require('electron').ipcRenderer : null;

export const App: React.FC = () => {
  const [showHUD, setShowHUD] = useState(false);
  const [voiceState, setVoiceState] = useState<NovaVoiceState>('IDLE');
  const [amplitude, setAmplitude] = useState(0);

  const [progressSteps, setProgressSteps] = useState<any[]>([]);
  const [createdTools, setCreatedTools] = useState<any[]>([]);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [aiAmplitude, setAiAmplitude] = useState(0);
  const [transcripts, setTranscripts] = useState<ITranscriptEntry[]>([]);
  const [telemetry, setTelemetry] = useState<ISystemTelemetryPayload | null>(null);
  const [contextChips, setContextChips] = useState<IContextChipPayload['chips']>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Start physical microphone hardware stream capture.
    // Time-based hysteresis: entering LISTENING is instant, but returning to
    // IDLE requires 600ms of sustained silence so per-buffer amplitude dips
    // don't flap the state machine (and spam the main process).
    audioRecorder.startRecording((amp) => {
      setAmplitude(amp);

      setVoiceState((prev) => {
        if (amp > 0.12 && prev === 'IDLE') {
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          if (ipcRenderer) {
            ipcRenderer.send('user-speaking-active', true);
          }
          return 'LISTENING';
        }
        if (amp > 0.12 && prev === 'LISTENING' && silenceTimerRef.current) {
          // Speech resumed before the silence window elapsed.
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        if (amp <= 0.04 && prev === 'LISTENING' && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            if (ipcRenderer) {
              ipcRenderer.send('user-speaking-active', false);
            }
            setVoiceState((current) => (current === 'LISTENING' ? 'IDLE' : current));
          }, 600);
        }
        return prev;
      });
    }).catch((err) => {
      console.error('Microphone capture failed to start:', err);
    });

    if (ipcRenderer) {

      // IPC listeners for voice changes and amplitude updates from Main process
      const onVoiceState = (_event: any, payload: IVoiceStatePayload) => {
        setVoiceState(payload.currentState);
        if (payload.inputAmplitude !== undefined) {
          setAmplitude(payload.inputAmplitude);
        }
      };

      const onWaveInput = (_event: any, amp: number) => {
        setAmplitude(amp);
      };

      const onAiAmplitude = (_event: any, amp: number) => {
        setAiAmplitude(amp);
      };

      const onProgressUpdate = (_event: any, payload: any) => {
        if (payload && payload.allSteps) {
          setProgressSteps(payload.allSteps);
        }
      };

      const onToolCreated = (_event: any, payload: any) => {
        if (payload) {
          setCreatedTools((prev) => {
            const exists = prev.some((t) => t.id === payload.id);
            if (exists) return prev;
            return [...prev, payload];
          });
          setActiveToolId(payload.id);
        }
      };

      const onAiAudioChunk = (_event: any, chunk: any) => {
        try {
          if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            nextStartTimeRef.current = audioCtxRef.current.currentTime;
          }
          const audioCtx = audioCtxRef.current;
          if (audioCtx.state === 'suspended') {
            audioCtx.resume();
          }

          // Node buffers sent over IPC are Uint8Array in the browser
          const rawBuffer = chunk.buffer || chunk;
          const dataView = new DataView(rawBuffer);
          const sampleCount = Math.floor(rawBuffer.byteLength / 2);
          const floatData = new Float32Array(sampleCount);

          for (let i = 0; i < sampleCount; i++) {
            // Read 16-bit PCM (signed)
            const sample = dataView.getInt16(i * 2, true);
            floatData[i] = sample / 32768;
          }

          const audioBuffer = audioCtx.createBuffer(1, sampleCount, 24000);
          audioBuffer.copyToChannel(floatData, 0);

          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);

          const now = audioCtx.currentTime;
          if (nextStartTimeRef.current < now) {
            nextStartTimeRef.current = now + 0.05;
          }
          source.start(nextStartTimeRef.current);
          nextStartTimeRef.current += audioBuffer.duration;

          activeSourcesRef.current.push(source);
          source.onended = () => {
            activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
          };
        } catch (err) {
          console.error('Error playing AI audio chunk:', err);
        }
      };

      const onAudioBufferFlush = () => {
        nextStartTimeRef.current = 0;
        activeSourcesRef.current.forEach((source) => {
          try {
            source.stop();
          } catch {
            // Source may already have finished playing
          }
        });
        activeSourcesRef.current = [];
        setVoiceState('LISTENING');
      };

      const onAiTextToken = (_event: any, token: string) => {
        setTranscripts((prev) => {
          if (prev.length === 0 || prev[prev.length - 1].sender !== 'NOVA AI') {
            return [...prev, { sender: 'NOVA AI', text: token }];
          }
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            text: updated[updated.length - 1].text + token,
          };
          return updated;
        });
      };

      const onUserTextTranscribed = (_event: any, text: string) => {
        setTranscripts((prev) => [...prev, { sender: 'USER', text }]);
      };

      const onBootLifecycle = (_event: any, steps: any) => {
        setProgressSteps(steps);
      };

      const onTelemetry = (_event: any, payload: ISystemTelemetryPayload) => {
        setTelemetry(payload);
      };

      const onContextChips = (_event: any, payload: IContextChipPayload) => {
        setContextChips(payload?.chips ?? []);
      };

      ipcRenderer.on(NovaIpcChannel.SYSTEM_TELEMETRY, onTelemetry);
      ipcRenderer.on(NovaIpcChannel.CONTEXT_CHIP_UPDATE, onContextChips);
      ipcRenderer.on(NovaIpcChannel.VOICE_STATE_CHANGE, onVoiceState);
      ipcRenderer.on(NovaIpcChannel.USER_WAVEFORM_INPUT, onWaveInput);
      ipcRenderer.on('ai-amplitude', onAiAmplitude);
      ipcRenderer.on('agent-progress-update', onProgressUpdate);
      ipcRenderer.on('agent-tool-created', onToolCreated);
      ipcRenderer.on('ai-audio-chunk', onAiAudioChunk);
      ipcRenderer.on('ai-text-token', onAiTextToken);
      ipcRenderer.on(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, onUserTextTranscribed);
      ipcRenderer.on(NovaIpcChannel.AUDIO_BUFFER_FLUSH, onAudioBufferFlush);
      ipcRenderer.on('nova-ipc:boot-lifecycle', onBootLifecycle);

      return () => {
        audioRecorder.stopRecording();
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        ipcRenderer.removeListener(NovaIpcChannel.SYSTEM_TELEMETRY, onTelemetry);
        ipcRenderer.removeListener(NovaIpcChannel.CONTEXT_CHIP_UPDATE, onContextChips);
        ipcRenderer.removeListener(NovaIpcChannel.VOICE_STATE_CHANGE, onVoiceState);
        ipcRenderer.removeListener(NovaIpcChannel.USER_WAVEFORM_INPUT, onWaveInput);
        ipcRenderer.removeListener('ai-amplitude', onAiAmplitude);
        ipcRenderer.removeListener('agent-progress-update', onProgressUpdate);
        ipcRenderer.removeListener('agent-tool-created', onToolCreated);
        ipcRenderer.removeListener('ai-audio-chunk', onAiAudioChunk);
        ipcRenderer.removeListener('ai-text-token', onAiTextToken);
        ipcRenderer.removeListener(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, onUserTextTranscribed);
        ipcRenderer.removeListener(NovaIpcChannel.AUDIO_BUFFER_FLUSH, onAudioBufferFlush);
        ipcRenderer.removeListener('nova-ipc:boot-lifecycle', onBootLifecycle);
        if (audioCtxRef.current) {
          audioCtxRef.current.close();
          audioCtxRef.current = null;
        }
      };
    } else {
        // Browser runtime: wire up browserBridge events
        const onAiAudioChunk = (chunk: any) => {
          try {
            if (!audioCtxRef.current) {
              audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
              nextStartTimeRef.current = audioCtxRef.current.currentTime;
            }
            const audioCtx = audioCtxRef.current!;
            if (audioCtx.state === 'suspended') audioCtx.resume();

            const rawBuffer = chunk;
            const dataView = new DataView(rawBuffer);
            const sampleCount = Math.floor(rawBuffer.byteLength / 2);
            const floatData = new Float32Array(sampleCount);

            for (let i = 0; i < sampleCount; i++) {
              const sample = dataView.getInt16(i * 2, true);
              floatData[i] = sample / 32768;
            }

            const audioBuffer = audioCtx.createBuffer(1, sampleCount, 24000);
            audioBuffer.copyToChannel(floatData, 0);

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);

            const now = audioCtx.currentTime;
            if (nextStartTimeRef.current < now) nextStartTimeRef.current = now + 0.05;
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += audioBuffer.duration;

            activeSourcesRef.current.push(source);
            source.onended = () => {
              activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
            };
          } catch (err) {
            console.error('Error playing AI audio chunk (browser):', err);
          }
        };

        const onAiTextToken = (token: string) => {
          setTranscripts((prev) => {
            if (prev.length === 0 || prev[prev.length - 1].sender !== 'NOVA AI') {
              return [...prev, { sender: 'NOVA AI', text: token }];
            }
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              text: updated[updated.length - 1].text + token,
            };
            return updated;
          });
        };

        const onUserTextTranscribed = (text: string) => {
          setTranscripts((prev) => [...prev, { sender: 'USER', text }]);
        };

        const onConnected = () => {
          // Clear any boot/loading progress and mark voice as idle — match Electron IPC behavior
          setProgressSteps([]);
          setVoiceState('IDLE');
        };

        browserBridge.on('ai-audio-chunk', onAiAudioChunk);
        browserBridge.on('ai-text-token', onAiTextToken);
        browserBridge.on('user-text-transcribed', onUserTextTranscribed);
        browserBridge.on('connected', onConnected);

        return () => {
          audioRecorder.stopRecording();
          browserBridge.off('ai-audio-chunk', onAiAudioChunk);
          browserBridge.off('ai-text-token', onAiTextToken);
          browserBridge.off('user-text-transcribed', onUserTextTranscribed);
          browserBridge.off('connected', onConnected);
        };
    }
  }, []);

  const handleToggleHUD = (visible: boolean) => {
    setShowHUD(visible);
    if (ipcRenderer) {
      ipcRenderer.send(NovaIpcChannel.HUD_VISIBILITY_REQ, visible);
    }
    // Trigger audio context resume on user gesture (browser runtime)
    try {
      audioRecorder.resumeAudio().catch(() => {});
    } catch {}
  };

  const handleSearchSubmit = (text: string) => {
    setTranscripts((prev) => [...prev, { sender: 'USER', text }]);
    if (ipcRenderer) {
      ipcRenderer
        .invoke(NovaIpcChannel.TRIGGER_AUTOMATION, text)
        .then((res: any) => {
          if (res && res.success === false) {
            setTranscripts((prev) => [
              ...prev,
              { sender: 'NOVA AI', text: `Automation failed: ${res.error ?? 'unknown error'}` },
            ]);
          }
        })
        .catch((err: unknown) => {
          setTranscripts((prev) => [
            ...prev,
            { sender: 'NOVA AI', text: `Automation dispatch failed: ${err instanceof Error ? err.message : String(err)}` },
          ]);
        });
    } else {
      // Browser runtime: route the typed command straight into the live session.
      browserBridge.sendRaw({ realtimeInput: { text } });
    }
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#020205]">
      <WindowControls />
      {showHUD ? (
        <HUDUI
          voiceState={voiceState}
          amplitude={amplitude}
          aiAmplitude={aiAmplitude}
          progressSteps={progressSteps}
          createdTools={createdTools}
          transcripts={transcripts}
          activeToolId={activeToolId}
          setActiveToolId={setActiveToolId}
          telemetry={telemetry}
          contextChips={contextChips}
          onSearchSubmit={handleSearchSubmit}
          onCloseHUD={() => handleToggleHUD(false)}
        />
      ) : (
        <MainUI
          voiceState={voiceState}
          amplitude={amplitude}
          onActivateHUD={() => handleToggleHUD(true)}
        />
      )}
    </div>
  );
};
export default App;

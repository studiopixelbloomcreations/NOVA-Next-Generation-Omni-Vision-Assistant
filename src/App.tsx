import React, { useState, useEffect, useRef } from 'react';
import { MainUI } from './renderer/components/MainUI';
import { HUDUI } from './renderer/components/HUDUI';
import { audioRecorder } from './renderer/utils/audio_recorder';
import {
  NovaVoiceState,
  NovaIpcChannel,
  IVoiceStatePayload,
  ISystemTelemetryPayload,
  IContextChipPayload,
  IRuntimeStatePayload,
  IActivityEventPayload,
  IMicStatePayload,
  IWorkspaceSurface,
} from './shared/ipc_protocols';
import { ITranscriptEntry } from './renderer/components/RightPanel';
import { IToolApprovalRequest } from './renderer/components/CenterHUD';

const getIpcRenderer = () => {
  try {
    if (typeof window !== 'undefined' && (window as any).__nova_ipc__) {
      return (window as any).__nova_ipc__;
    }
    if (typeof window !== 'undefined' && (window as any).require) {
      return (window as any).require('electron').ipcRenderer;
    }
  } catch {
    // Electron runtime required
  }
  return null;
};
const ipcRenderer = getIpcRenderer();

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
  const [runtimeState, setRuntimeState] = useState<IRuntimeStatePayload | null>(null);
  const [activityFeed, setActivityFeed] = useState<IActivityEventPayload[]>([]);
  const [contextChips, setContextChips] = useState<IContextChipPayload['chips']>([]);
  const [toolSynthesisPhase, setToolSynthesisPhase] = useState<string>('IDLE');
  const [toolSynthesisSteps, setToolSynthesisSteps] = useState<any[]>([]);
  const [showToolSynthesis, setShowToolSynthesis] = useState(false);
  const [approvalRequest, setApprovalRequest] = useState<IToolApprovalRequest | null>(null);
  const [micState, setMicState] = useState<IMicStatePayload | null>(null);
  const [workspaceSurfaces, setWorkspaceSurfaces] = useState<IWorkspaceSurface[]>([]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the toggle path: getUserMedia open can take hundreds of ms, so a
  // rapid second toggle must not fire while the first is in flight.
  const micTogglingRef = useRef(false);
  // True once the boot auto-capture has confirmed capture state to main.
  const bootCaptureConfirmedRef = useRef(false);

  useEffect(() => {
    audioRecorder
      .startRecording(amp => {
        setAmplitude(amp);
        if (ipcRenderer) {
          // The callback is invoked only by a real ScriptProcessor audio
          // frame. Do not require non-zero energy here: a working microphone
          // can legitimately be silent, and gating state on amp > 0 made the
          // UI remain "initializing" until the user spoke loudly enough.
          // Confirm exactly once after the first real frame arrives.
          if (!bootCaptureConfirmedRef.current) {
            bootCaptureConfirmedRef.current = true;
            ipcRenderer.send(NovaIpcChannel.MIC_CAPTURE_ACTIVE, true);
          }
        }

        setVoiceState(prev => {
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
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          if (amp <= 0.04 && prev === 'LISTENING' && !silenceTimerRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              silenceTimerRef.current = null;
              if (ipcRenderer) {
                ipcRenderer.send('user-speaking-active', false);
              }
              setVoiceState(current => (current === 'LISTENING' ? 'IDLE' : current));
            }, 600);
          }
          return prev;
        });
      })
      .catch(err => {
        console.error('Microphone capture failed to start:', err);
        if (ipcRenderer) {
          const msg =
            err instanceof DOMException && err.name === 'NotAllowedError'
              ? 'Microphone permission was denied — enable it in Windows privacy settings or the app permission prompt.'
              : err instanceof Error
                ? err.message
                : String(err);
          ipcRenderer.send(NovaIpcChannel.MIC_CAPTURE_ERROR, msg);
        }
      });

    if (ipcRenderer) {
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
          setCreatedTools(prev => {
            const exists = prev.some(t => t.id === payload.id);
            if (exists) return prev;
            return [...prev, payload];
          });
          setActiveToolId(payload.id);
        }
      };

      const onAiAudioChunk = (_event: any, chunk: any) => {
        try {
          if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
              sampleRate: 24000,
            });
            nextStartTimeRef.current = audioCtxRef.current.currentTime;
          }
          const audioCtx = audioCtxRef.current;
          if (audioCtx.state === 'suspended') {
            audioCtx.resume();
          }

          const uint8Array = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          const arrayBuffer = uint8Array.buffer.slice(
            uint8Array.byteOffset,
            uint8Array.byteOffset + uint8Array.byteLength,
          );
          const dataView = new DataView(arrayBuffer);
          const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
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
          if (nextStartTimeRef.current < now) {
            nextStartTimeRef.current = now + 0.05;
          }
          source.start(nextStartTimeRef.current);
          nextStartTimeRef.current += audioBuffer.duration;

          activeSourcesRef.current.push(source);
          source.onended = () => {
            activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
          };
        } catch (err) {
          console.error('Error playing AI audio chunk:', err);
        }
      };

      const onAudioBufferFlush = () => {
        nextStartTimeRef.current = 0;
        activeSourcesRef.current.forEach(source => {
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
        setTranscripts(prev => {
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

      const onUserTextTranscribed = (_event: any, payload: string | { text?: string; partial?: boolean }) => {
        const text = typeof payload === 'string' ? payload : payload?.text ?? '';
        const partial = typeof payload === 'string' ? false : payload?.partial === true;
        if (!text) return;
        // Gemini sends input transcription as small incremental deltas. Keep
        // one live USER entry so every delta appears immediately without
        // creating a new transcript row for each websocket frame.
        setTranscripts(prev => {
          const last = prev[prev.length - 1];
          if (!last || last.sender !== 'USER') {
            return [...prev, { sender: 'USER', text: partial ? `${text} …` : text }];
          }
          const updated = [...prev];
          updated[updated.length - 1] = { ...last, text: partial ? `${text} …` : text };
          return updated;
        });
      };

      const onBootLifecycle = (_event: any, steps: any) => {
        setProgressSteps(steps);
      };

      const onApprovalRequest = (_event: any, payload: any) => {
        if (payload && payload.name) {
          setApprovalRequest(payload);
        }
      };

      const onTelemetry = (_event: any, payload: ISystemTelemetryPayload) => {
        setTelemetry(payload);
      };

      const onContextChips = (_event: any, payload: IContextChipPayload) => {
        setContextChips(payload?.chips ?? []);
      };

      const onRuntimeState = (_event: any, payload: IRuntimeStatePayload) => {
        if (payload && payload.overall) setRuntimeState(payload);
      };

      const onActivity = (_event: any, payload: IActivityEventPayload) => {
        if (payload && payload.message) {
          setActivityFeed(prev => {
            const next = [payload, ...prev];
            return next.length > 60 ? next.slice(0, 60) : next;
          });
        }
      };

      const onMicState = (_event: any, payload: IMicStatePayload) => {
        if (payload && payload.state) setMicState(payload);
      };

      const onWorkspaceUpdate = (_event: any, payload: { surfaces?: IWorkspaceSurface[] }) => {
        if (payload && Array.isArray(payload.surfaces)) {
          setWorkspaceSurfaces(payload.surfaces);
        }
      };

      // Main asked the renderer to actually open/close the microphone (user
      // clicked the mic control). This is a REAL getUserMedia start/stop.
      const onMicToggleRequest = async () => {
        if (micTogglingRef.current) return; // in-flight guard (double-click)
        micTogglingRef.current = true;
        try {
          if (audioRecorder.isCapturing) {
            audioRecorder.stopRecording();
            if (ipcRenderer) ipcRenderer.send(NovaIpcChannel.MIC_CAPTURE_ACTIVE, false);
          } else {
            try {
              bootCaptureConfirmedRef.current = false;
              await audioRecorder.startRecording(amp => {
                setAmplitude(amp);
                if (ipcRenderer && !bootCaptureConfirmedRef.current) {
                  // startRecording's callback is driven by actual captured
                  // frames, including silent frames; this is the authoritative
                  // capture confirmation for the toggle path.
                  bootCaptureConfirmedRef.current = true;
                  ipcRenderer.send(NovaIpcChannel.MIC_CAPTURE_ACTIVE, true);
                }
              });
            } catch (err) {
              console.error('Microphone failed to open on toggle:', err);
              if (ipcRenderer) {
                const msg =
                  err instanceof DOMException && err.name === 'NotAllowedError'
                    ? 'Microphone permission was denied — enable it in Windows privacy settings or the app permission prompt.'
                    : err instanceof Error
                      ? err.message
                      : String(err);
                ipcRenderer.send(NovaIpcChannel.MIC_CAPTURE_ERROR, msg);
              }
            }
          }
        } finally {
          micTogglingRef.current = false;
        }
      };

      ipcRenderer.on(NovaIpcChannel.SYSTEM_TELEMETRY, onTelemetry);
      ipcRenderer.on(NovaIpcChannel.RUNTIME_STATE_CHANGE, onRuntimeState);
      ipcRenderer.on(NovaIpcChannel.RUNTIME_ACTIVITY, onActivity);
      ipcRenderer.on(NovaIpcChannel.MIC_STATE_CHANGE, onMicState);
      ipcRenderer.on(NovaIpcChannel.MIC_TOGGLE_REQUEST, onMicToggleRequest);
      ipcRenderer.on(NovaIpcChannel.WORKSPACE_UPDATE, onWorkspaceUpdate);
      ipcRenderer.on(NovaIpcChannel.CONTEXT_CHIP_UPDATE, onContextChips);
      ipcRenderer.on(NovaIpcChannel.VOICE_STATE_CHANGE, onVoiceState);
      ipcRenderer.on(NovaIpcChannel.USER_WAVEFORM_INPUT, onWaveInput);
      ipcRenderer.on('ai-amplitude', onAiAmplitude);
      ipcRenderer.on('agent-progress-update', onProgressUpdate);
      ipcRenderer.on('agent-tool-created', onToolCreated);
      ipcRenderer.on('agent-tool-approval-request', onApprovalRequest);
      const onToolSynthesisPhase = (_event: any, payload: any) => {
        if (payload) {
          setToolSynthesisPhase(payload.phase);
          setShowToolSynthesis(
            payload.phase !== 'IDLE' && payload.phase !== 'COMPLETED' && payload.phase !== 'FAILED',
          );
          // Clear any pending approval banner when the build resolves.
          if (payload.phase === 'COMPLETED' || payload.phase === 'FAILED') {
            setApprovalRequest(null);
          }
        }
      };
      const onToolSynthesisSteps = (_event: any, payload: any) => {
        if (payload && payload.steps) {
          setToolSynthesisSteps(payload.steps);
        }
      };
      ipcRenderer.on('agent-tool-synthesis-phase', onToolSynthesisPhase);
      ipcRenderer.on('agent-tool-synthesis-steps', onToolSynthesisSteps);
      ipcRenderer.on('ai-audio-chunk', onAiAudioChunk);
      ipcRenderer.on('ai-text-token', onAiTextToken);
      ipcRenderer.on(NovaIpcChannel.SPEECH_TEXT_TRANSCRIBED, onUserTextTranscribed);
      ipcRenderer.on(NovaIpcChannel.AUDIO_BUFFER_FLUSH, onAudioBufferFlush);
      ipcRenderer.on('nova-ipc:boot-lifecycle', onBootLifecycle);

      // The boot lifecycle events may have fired before this React tree
      // mounted (one-shot broadcasts are lost to late subscribers), so pull
      // the current snapshot instead of waiting on a signal that already
      // happened — this is what makes the boot tracker come alive.
      ipcRenderer
        .invoke(NovaIpcChannel.GET_BOOT_STATE)
        .then((snapshot: any) => {
          if (!snapshot) return;
          if (Array.isArray(snapshot.bootSteps) && snapshot.bootSteps.length > 0) {
            setProgressSteps(snapshot.bootSteps);
          }
          if (snapshot.telemetry) {
            setTelemetry(snapshot.telemetry);
          }
        })
        .catch(() => undefined);

      // Pull the authoritative runtime state + recent activity so a late
      // subscriber renders the REAL system state immediately (never a
      // placeholder), then keep it live via the pushed snapshots above.
      ipcRenderer
        .invoke(NovaIpcChannel.GET_RUNTIME_STATE)
        .then((payload: any) => {
          if (!payload) return;
          if (payload.state?.overall) setRuntimeState(payload.state);
          if (Array.isArray(payload.activity)) setActivityFeed(payload.activity);
        })
        .catch(() => undefined);

      // Pull the current microphone state so the mic control renders the real
      // device/availability truth immediately.
      ipcRenderer
        .invoke(NovaIpcChannel.GET_MIC_STATE)
        .then((payload: IMicStatePayload | null) => {
          if (payload && payload.state) setMicState(payload);
        })
        .catch(() => undefined);

      // Pull any persisted workspace surfaces from a previous session so a
      // late subscriber renders them immediately (then live via pushes).
      ipcRenderer
        .invoke(NovaIpcChannel.WORKSPACE_LIST)
        .then((payload: { surfaces?: IWorkspaceSurface[] } | null) => {
          if (payload && Array.isArray(payload.surfaces)) {
            setWorkspaceSurfaces(payload.surfaces);
          }
        })
        .catch(() => undefined);

      return () => {
        audioRecorder.stopRecording();
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        ipcRenderer.removeListener(NovaIpcChannel.SYSTEM_TELEMETRY, onTelemetry);
        ipcRenderer.removeListener(NovaIpcChannel.RUNTIME_STATE_CHANGE, onRuntimeState);
        ipcRenderer.removeListener(NovaIpcChannel.RUNTIME_ACTIVITY, onActivity);
        ipcRenderer.removeListener(NovaIpcChannel.MIC_STATE_CHANGE, onMicState);
        ipcRenderer.removeListener(NovaIpcChannel.MIC_TOGGLE_REQUEST, onMicToggleRequest);
        ipcRenderer.removeListener(NovaIpcChannel.WORKSPACE_UPDATE, onWorkspaceUpdate);
        ipcRenderer.removeListener(NovaIpcChannel.CONTEXT_CHIP_UPDATE, onContextChips);
        ipcRenderer.removeListener(NovaIpcChannel.VOICE_STATE_CHANGE, onVoiceState);
        ipcRenderer.removeListener(NovaIpcChannel.USER_WAVEFORM_INPUT, onWaveInput);
        ipcRenderer.removeListener('ai-amplitude', onAiAmplitude);
        ipcRenderer.removeListener('agent-progress-update', onProgressUpdate);
        ipcRenderer.removeListener('agent-tool-created', onToolCreated);
        ipcRenderer.removeListener('agent-tool-approval-request', onApprovalRequest);
        ipcRenderer.removeListener('agent-tool-synthesis-phase', onToolSynthesisPhase);
        ipcRenderer.removeListener('agent-tool-synthesis-steps', onToolSynthesisSteps);
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
    }
    return undefined;
  }, []);

  const handleToggleHUD = (visible: boolean) => {
    setShowHUD(visible);
    if (ipcRenderer) {
      ipcRenderer.send(NovaIpcChannel.HUD_VISIBILITY_REQ, visible);
    }
  };

  const handleApprove = () => {
    setApprovalRequest(null);
    if (ipcRenderer) {
      ipcRenderer.invoke(NovaIpcChannel.TOOL_APPROVE).catch(() => undefined);
    }
  };

  const handleReject = () => {
    setApprovalRequest(null);
    if (ipcRenderer) {
      ipcRenderer.invoke(NovaIpcChannel.TOOL_REJECT).catch(() => undefined);
    }
  };

  const handleCloseSurface = (id: string) => {
    if (ipcRenderer) {
      ipcRenderer.invoke(NovaIpcChannel.WORKSPACE_CLOSE, id).catch(() => undefined);
    }
  };

  const handleOpenUrl = (url: string) => {
    if (ipcRenderer) {
      ipcRenderer.invoke(NovaIpcChannel.WORKSPACE_OPEN_URL, url).catch(() => undefined);
    }
  };

  const handleMicToggle = () => {
    if (ipcRenderer) {
      ipcRenderer.invoke(NovaIpcChannel.MIC_TOGGLE).catch(() => undefined);
    }
  };

  const handleMicDiagnostic = async (): Promise<any> => {
    if (!ipcRenderer) return null;
    try {
      // Prefer the Python WASAPI diagnostic (real capture, local analysis).
      const pyResult = await ipcRenderer.invoke(NovaIpcChannel.MIC_DIAGNOSTIC, 500);
      if (pyResult && pyResult.ok !== undefined) return pyResult;
      // Fall back to the renderer getUserMedia diagnostic.
      return await audioRecorder.runDiagnostic();
    } catch {
      try {
        return await audioRecorder.runDiagnostic();
      } catch {
        return { ok: false, error: 'microphone diagnostic failed' };
      }
    }
  };

  const handleSearchSubmit = (text: string) => {
    setTranscripts(prev => [...prev, { sender: 'USER', text }]);
    if (ipcRenderer) {
      ipcRenderer
        .invoke(NovaIpcChannel.TRIGGER_AUTOMATION, text)
        .then((res: any) => {
          if (!res) return;
          if (res.success === false) {
            setTranscripts(prev => [
              ...prev,
              { sender: 'NOVA AI', text: res.error ?? 'NOVA is unavailable — check the provider connection.' },
            ]);
          } else if (typeof res.response === 'string' && res.response.trim()) {
            // Reasoning/engineering answers from the reasoning engine are shown
            // in the transcript like any other NOVA response.
            setTranscripts(prev => [...prev, { sender: 'NOVA AI', text: res.response }]);
          }
        })
        .catch((err: unknown) => {
          setTranscripts(prev => [
            ...prev,
            {
              sender: 'NOVA AI',
              text: `Automation dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ]);
        });
    }
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#020205]">
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
          runtimeState={runtimeState}
          activityFeed={activityFeed}
          contextChips={contextChips}
          micState={micState}
          onMicToggle={handleMicToggle}
          onMicDiagnostic={handleMicDiagnostic}
          onSearchSubmit={handleSearchSubmit}
          toolSynthesisPhase={toolSynthesisPhase}
          toolSynthesisSteps={toolSynthesisSteps}
          showToolSynthesis={showToolSynthesis}
          approvalRequest={approvalRequest}
          onApprove={handleApprove}
          onReject={handleReject}
          workspaceSurfaces={workspaceSurfaces}
          onCloseSurface={handleCloseSurface}
          onOpenUrl={handleOpenUrl}
        />
      ) : (
        <MainUI
          voiceState={voiceState}
          amplitude={amplitude}
          runtimeState={runtimeState}
          onActivateHUD={() => handleToggleHUD(true)}
        />
      )}
    </div>
  );
};
export default App;

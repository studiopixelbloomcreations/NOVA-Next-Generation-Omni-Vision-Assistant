// src/renderer/components/CenterHUD.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { Camera, Folder, Search, Cpu, X, Radio, Zap, Mic, MicOff, AlertTriangle, Activity } from 'lucide-react';
import {
  ISystemTelemetryPayload,
  IContextChipPayload,
  IRuntimeStatePayload,
  IMicStatePayload,
  OverallStatus,
} from '../../shared/ipc_protocols';

function extractUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface ActionCard {
  title: string;
  query: string;
  icon: React.ElementType;
  contextual?: boolean;
}

export interface IToolApprovalRequest {
  toolId: string | null;
  name: string;
  description: string;
  intent: string;
  requestedAt: number;
}

interface CenterHUDProps {
  onSearchSubmit: (text: string) => void;
  createdTools?: any[];
  activeToolId?: string | null;
  setActiveToolId?: (id: string | null) => void;
  telemetry: ISystemTelemetryPayload | null;
  runtimeState: IRuntimeStatePayload | null;
  contextChips: IContextChipPayload['chips'];
  micState: IMicStatePayload | null;
  onMicToggle: () => void;
  onMicDiagnostic: () => Promise<any>;
  toolSynthesisPhase?: string;
  toolSynthesisSteps?: any[];
  showToolSynthesis?: boolean;
  approvalRequest?: IToolApprovalRequest | null;
  onApprove?: () => void;
  onReject?: () => void;
}

export const CenterHUD: React.FC<CenterHUDProps> = ({
  onSearchSubmit,
  createdTools = [],
  activeToolId = null,
  setActiveToolId = () => {},
  telemetry,
  runtimeState,
  contextChips,
  micState,
  onMicToggle,
  onMicDiagnostic,
  toolSynthesisPhase = 'IDLE',
  toolSynthesisSteps = [],
  showToolSynthesis = true,
  approvalRequest = null,
  onApprove = () => {},
  onReject = () => {},
}) => {
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<string | null>(null);

  // REAL microphone state — every value comes from MicManager via IPC.
  const micListening = micState?.listening === true;
  const micAvailable = micState?.available === true;
  const micStateLabel =
    micState?.state === 'LISTENING'
      ? 'LISTENING'
      : micState?.state === 'PERMISSION_REQUIRED'
        ? 'PERMISSION'
        : micState?.state === 'ERROR'
          ? 'ERROR'
          : micState?.state === 'UNAVAILABLE'
            ? 'NO MIC'
            : micState?.state === 'INITIALIZING'
              ? 'INIT'
              : micState?.state === 'READY'
                ? 'READY'
                : micState?.state ?? '—';
  const micDevice = micState?.defaultCapture ?? null;

  const runDiagnostic = async () => {
    setDiagnosticBusy(true);
    setDiagnosticResult(null);
    try {
      const res = await onMicDiagnostic();
      if (res && res.ok) {
        setDiagnosticResult(
          `Signal OK — RMS ${res.rms?.toFixed(3)} peak ${res.peak?.toFixed(3)} @ ${res.sampleRate ?? '?'}Hz (${res.frames ?? 0} frames)`,
        );
      } else {
        setDiagnosticResult(`Mic diagnostic failed: ${res?.error ?? 'unknown error'}`);
      }
    } catch {
      setDiagnosticResult('Mic diagnostic failed');
    } finally {
      setDiagnosticBusy(false);
    }
  };
  const [inputText, setInputText] = useState('');
  const [now, setNow] = useState(() => new Date());
  const [sessionStartTime] = useState(Date.now());

  // Helper to calculate synthesis progress based on phase
  const getSynthesisProgress = useCallback((): number => {
    const phaseOrder: Record<string, number> = {
      IDLE: 0,
      SEARCHING_REGISTRY: 5,
      TOOL_NOT_FOUND: 10,
      DESIGNING_ARCHITECTURE: 20,
      WRITING_CODE: 40,
      COMPILING_ASSETS: 60,
      RUNNING_SANITY_TESTS: 80,
      DEPLOYING_TOOL: 95,
      COMPLETED: 100,
      FAILED: 100,
    };
    return phaseOrder[toolSynthesisPhase] ?? 0;
  }, [toolSynthesisPhase]);

  // Live clock sync - 1 second interval for second-precision
  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(intervalId);
  }, []);

  const timeLabel = now.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  const dateLabel = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  // Session uptime
  const sessionUptimeMs = Date.now() - sessionStartTime;
  const uptimeMinutes = Math.floor(sessionUptimeMs / 60000);
  const uptimeSeconds = Math.floor((sessionUptimeMs % 60000) / 1000);
  const uptimeLabel = `${uptimeMinutes.toString().padStart(2, '0')}:${uptimeSeconds.toString().padStart(2, '0')}`;

  const handleKeyPress = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && inputText.trim() !== '') {
        onSearchSubmit(inputText.trim());
        setInputText('');
      }
    },
    [inputText, onSearchSubmit],
  );

  // Dynamic action cards driven by live context chips
  const actionCards = React.useMemo((): ActionCard[] => {
    const baseCards: ActionCard[] = [
      { title: 'Analyze Screen', query: 'Analyze what is currently on my screen', icon: Camera },
      { title: 'List Projects', query: 'List all active projects in workspace', icon: Folder },
      {
        title: 'Search History',
        query: 'Search interaction history for relevant context',
        icon: Search,
      },
    ];

    // Add context-aware actions based on active chips
    const contextualActions: ActionCard[] = contextChips.slice(0, 1).map(chip => ({
      title: `Inspect ${chip.label.slice(0, 18)}`,
      query: `Provide deep analysis of ${chip.label}`,
      icon: Zap,
      contextual: true,
    }));

    return [...baseCards, ...contextualActions].slice(0, 4);
  }, [contextChips]);

  const activeTool = createdTools.find(t => t.id === activeToolId);

  // REAL state labels — the top-right strip reports what the runtime actually
  // says. Nothing here is hardcoded; every value comes from the runtime state
  // hub or live telemetry.
  const captureLabel = telemetry
    ? `${telemetry.captureWidth}×${telemetry.captureHeight} @ ${telemetry.frameRate}fps`
    : 'NO SIGNAL';
  const deltaLabel = telemetry ? `${telemetry.mutatedBlocks}/${telemetry.totalBlocks} Δ` : '—';
  const latencyLabel =
    telemetry && telemetry.geminiState === 'CONNECTED' ? `${telemetry.streamLatencyMs}ms` : '—';
  const geminiLabel = runtimeState
    ? runtimeState.gemini
    : telemetry
      ? telemetry.geminiState
      : 'OFFLINE';
  const overallLabel = runtimeState ? runtimeState.overall : 'BOOTING';
  const currentTask = runtimeState ? runtimeState.currentTask : 'Initializing…';

  const overallTone: Record<OverallStatus, string> = {
    ONLINE: 'text-emerald-400',
    BOOTING: 'text-amber-400',
    DEGRADED: 'text-orange-400',
    ERROR: 'text-rose-400',
  };

  const telemetryFields = [
    { label: 'STATE', value: overallLabel },
    { label: 'CAPTURE', value: captureLabel },
    { label: 'DELTA', value: deltaLabel },
    { label: 'LINK', value: latencyLabel },
    { label: 'GEMINI', value: geminiLabel },
    { label: 'UPTIME', value: uptimeLabel },
  ];

  const telemetryFieldTone = (label: string) =>
    label === 'STATE' ? overallTone[runtimeState?.overall ?? 'BOOTING'] : 'text-cyan-300/80';

  // Render live visualization for synthesized tools
  const renderToolWidget = useCallback(() => {
    if (!activeTool) return null;

    const streamUrl: string | undefined = activeTool.payload?.streamUrl;

    if (streamUrl) {
      return (
        <div className="flex flex-col gap-4 h-full">
          <div className="flex justify-between items-center border-b border-[#ffffff10] pb-3">
            <div>
              <h3 className="font-orbitron text-xs font-bold text-cyan-400 tracking-[0.1em]">
                {activeTool.name}
              </h3>
              <p className="text-[10px] text-[#ffffff40]">{activeTool.description}</p>
            </div>
            <button
              onClick={() => setActiveToolId(null)}
              className="text-[#ffffff40] hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 min-h-[180px] bg-black/60 border border-cyan-500/10 rounded-xl relative overflow-hidden flex items-center justify-center">
            <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(#00d4ff_1px,transparent_1px)] [background-size:10px_10px]" />
            <div className="flex flex-col items-center gap-3 relative z-10 text-center px-4">
              <Radio size={28} className="text-cyan-400/60" />
              <span className="font-rajdhani text-[11px] font-bold text-cyan-300/80 tracking-[0.15em] uppercase">
                LIVE STREAM ACTIVE — PLAYING IN LIVE FEED PANEL
              </span>
              <span className="text-[9px] text-[#ffffff30] tracking-[0.05em] uppercase">
                Type: {activeTool.payload?.streamType ?? 'unknown'} | Source:{' '}
                {extractUrlHost(streamUrl)}
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-3 h-full">
        <div className="flex justify-between items-center border-b border-[#ffffff10] pb-2">
          <div>
            <h3 className="font-orbitron text-xs font-bold text-blue-400 tracking-[0.1em]">
              {activeTool.name}
            </h3>
            <p className="text-[10px] text-[#ffffff40]">{activeTool.description}</p>
          </div>
          <button
            onClick={() => setActiveToolId(null)}
            className="text-[#ffffff40] hover:text-white transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center border border-[#ffffff05] rounded-xl bg-black/20">
          <Cpu size={24} className="text-blue-400/60 mb-2" />
          <span className="font-rajdhani text-xs font-semibold text-white/60">
            Sandbox Tool Compiled & Registered
          </span>
          {activeTool.status === 'failed' ? (
            <span className="text-[9px] text-rose-400 font-bold uppercase mt-1 tracking-[0.1em]">
              Status: Compilation Failed
            </span>
          ) : (
            <span className="text-[9px] text-emerald-400 font-bold uppercase mt-1 tracking-[0.1em]">
              Status: Sandbox Online
            </span>
          )}
        </div>
      </div>
    );
  }, [activeTool, setActiveToolId]);

  return (
    <div className="flex-1 h-full px-8 py-6 flex flex-col justify-between select-none overflow-hidden">
      {/* Top Header Indicators */}
      <div className="flex justify-between items-start flex-shrink-0">
        <div className="flex flex-col gap-1">
          <h1 className="font-orbitron text-xl font-bold tracking-[0.25em] text-[#f5f8ff] drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">
            N O V A&nbsp;&nbsp;A I
          </h1>
          <p className="font-rajdhani text-[9px] font-semibold tracking-[0.22em] text-blue-400/40 uppercase">
            ADVANCED NEURAL INTELLIGENCE
          </p>
        </div>

        <div className="flex items-start gap-4">
          {/* Real microphone control — reflects live MicManager state and
              actually opens/closes the microphone via getUserMedia. */}
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={onMicToggle}
              aria-label={`Microphone: ${micStateLabel}${micListening ? ' — listening' : ''}. Click to ${micListening ? 'stop' : 'start'} listening`}
              title={`Microphone ${micStateLabel}${micDevice ? ` — ${micDevice}` : ''}. Click to ${micListening ? 'stop' : 'start'} listening.`}
              className={`group flex items-center gap-2 rounded-xl border px-3 py-2 transition-all duration-200 cursor-pointer ${
                micListening
                  ? 'border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20'
                  : micState?.state === 'ERROR' || micState?.state === 'PERMISSION_REQUIRED'
                    ? 'border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20'
                    : micAvailable
                      ? 'border-blue-500/20 bg-[#ffffff03] hover:bg-blue-500/10 hover:border-blue-500/40'
                      : 'border-[#ffffff10] bg-[#ffffff02]'
              }`}
            >
              <span className="relative flex items-center justify-center w-6 h-6">
                {micListening ? (
                  <>
                    <span className="absolute inset-0 rounded-full bg-emerald-400/40 animate-ping" />
                    <Mic size={13} className="text-emerald-300 relative" />
                  </>
                ) : micState?.state === 'PERMISSION_REQUIRED' || micState?.state === 'ERROR' ? (
                  <AlertTriangle size={13} className="text-rose-400" />
                ) : micAvailable ? (
                  <Mic size={13} className="text-blue-300/80 group-hover:text-blue-200" />
                ) : (
                  <MicOff size={13} className="text-[#ffffff25]" />
                )}
              </span>
              <span
                className={`font-mono text-[9px] font-bold tracking-[0.1em] ${
                  micListening
                    ? 'text-emerald-300'
                    : micState?.state === 'PERMISSION_REQUIRED' || micState?.state === 'ERROR'
                      ? 'text-rose-400'
                      : micAvailable
                        ? 'text-blue-300/70'
                        : 'text-[#ffffff30]'
                }`}
              >
                {micListening ? '● LISTENING' : micStateLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={runDiagnostic}
              disabled={diagnosticBusy || !micAvailable}
              aria-label="Run microphone diagnostic"
              title="Run a real local microphone diagnostic (records a short sample locally, never transmitted)"
              className="flex items-center gap-1 text-[8px] font-rajdhani font-bold tracking-[0.12em] uppercase text-[#ffffff35] hover:text-cyan-300/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Activity size={9} />
              {diagnosticBusy ? 'Testing…' : 'Mic Test'}
            </button>
            {diagnosticResult && (
              <span className="font-mono text-[8px] text-cyan-300/70 tracking-[0.05em] max-w-[220px] text-right">
                {diagnosticResult}
              </span>
            )}
          </div>

          {/* Live system telemetry strip */}
          <div className="glass-base rounded-xl border border-blue-500/10 px-4 py-2 flex items-center gap-4">
            {telemetryFields.map(field => (
              <div key={field.label} className="flex flex-col items-end">
                <span className="font-rajdhani text-[8px] font-bold tracking-[0.15em] text-[#ffffff30] uppercase">
                  {field.label}
                </span>
                <span
                  className={`font-mono text-[10px] font-bold ${telemetryFieldTone(field.label)} tracking-[0.05em]`}
                >
                  {field.value}
                </span>
              </div>
            ))}
          </div>

          {/* Live localized clock + session uptime */}
          <div className="text-right">
            <p className="font-rajdhani text-xs font-bold tracking-[0.1em] text-blue-300/80">
              {timeLabel}
            </p>
            <p className="font-rajdhani text-[9px] font-semibold tracking-[0.15em] text-[#ffffff30] uppercase mt-0.5">
              {dateLabel}
            </p>
            <p className="font-mono text-[8px] text-cyan-400/60 tracking-[0.1em] mt-1">
              {currentTask}
            </p>
          </div>
        </div>
      </div>

      {/* Tool Synthesis Progress Bar */}
      {showToolSynthesis &&
        toolSynthesisPhase !== 'IDLE' &&
        toolSynthesisPhase !== 'COMPLETED' &&
        toolSynthesisPhase !== 'FAILED' && (
          <div className="flex-shrink-0 mb-4 glass-base rounded-xl border border-cyan-500/20 p-4 animate-slide-down">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center animate-pulse">
                <Cpu size={14} className="text-cyan-400" />
              </div>
              <div className="flex-1">
                <p className="font-orbitron text-xs font-bold text-cyan-400 tracking-[0.1em] uppercase">
                  SYNTHESIZING TOOL
                </p>
                <p className="font-rajdhani text-[10px] text-cyan-300/70 tracking-[0.05em] uppercase">
                  {toolSynthesisPhase.replace(/_/g, ' ')}
                </p>
              </div>
            </div>

            {/* Progress bar with steps */}
            <div className="space-y-2">
              <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 via-cyan-400 to-cyan-600 rounded-full transition-all duration-500 ease-out"
                  style={{ width: getSynthesisProgress() + '%' }}
                />
              </div>
              <div className="flex items-center justify-between text-[9px] font-rajdhani uppercase tracking-[0.1em]">
                <span className="text-cyan-400/80">INITIALIZING</span>
                <span className="text-white/60">{Math.round(getSynthesisProgress())}%</span>
                <span className="text-cyan-400/80">DEPLOYING</span>
              </div>

              {/* Step indicators */}
              {toolSynthesisSteps.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2">
                  {toolSynthesisSteps.map((step, idx) => (
                    <div
                      key={step.stepId}
                      className="flex-shrink-0 flex flex-col items-center gap-1"
                    >
                      <div
                        className={`w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold transition-all ${
                          step.status === 'completed'
                            ? 'bg-emerald-500 text-black'
                            : step.status === 'active'
                              ? 'bg-cyan-500 text-black animate-pulse'
                              : step.status === 'failed'
                                ? 'bg-rose-500 text-white'
                                : 'bg-white/10 text-white/30 border border-white/20'
                        }`}
                      >
                        {step.status === 'completed'
                          ? '✓'
                          : step.status === 'active'
                            ? idx + 1
                            : '✗'}
                      </div>
                      <span className="text-[7px] font-rajdhani uppercase tracking-[0.05em] text-white/40 whitespace-nowrap max-w-[80px] text-center truncate">
                        {step.label.length > 18 ? step.label.slice(0, 18) + '…' : step.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      {/* Main Dialogue Transcript / Tool Window Container */}
      <div className="flex-1 flex items-center justify-center my-4 overflow-hidden">
        <div className="w-full max-w-[620px] h-[300px] flex flex-col justify-between">
          <div className="w-full h-full glass-base p-6 rounded-2xl glass-accent-border border-blue-500/10 shadow-[0_4px_30px_rgba(0,0,0,0.5)] overflow-hidden">
            {activeTool ? (
              renderToolWidget()
            ) : (
              <div className="flex flex-col justify-between h-full">
                <div>
                  <h4 className="font-rajdhani text-[11px] font-bold tracking-[0.12em] text-cyan-400 uppercase mb-2">
                    WORKSPACE ACTIVE
                  </h4>
                  <p className="font-rajdhani text-xs font-semibold tracking-[0.05em] text-blue-100/60 leading-relaxed">
                    Genesis Core execution pipeline ready. Speak or enter a query command below to
                    trigger automatic tool generation and capture results.
                  </p>
                </div>

                {/* Display list of generated tools if any exist */}
                {createdTools.length > 0 && (
                  <div className="mt-4">
                    <span className="font-rajdhani text-[10px] font-bold tracking-[0.15em] text-[#ffffff20] uppercase block mb-2">
                      GENERATED UTILITIES
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {createdTools.map(tool => (
                        <button
                          key={tool.id}
                          onClick={() => setActiveToolId(tool.id)}
                          className="bg-blue-500/5 hover:bg-blue-500/10 border border-blue-500/20 px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all cursor-pointer"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="font-rajdhani text-xs font-bold text-white/80">
                            {tool.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tool approval gate (human-in-the-loop) */}
      {approvalRequest && (
        <div
          role="alertdialog"
          aria-label="Tool synthesis requires approval"
          className="flex-shrink-0 mb-4 glass-base rounded-xl border border-amber-500/40 p-4 flex flex-col gap-3 animate-slide-down"
        >
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-amber-400" />
            <p className="font-orbitron text-[10px] font-bold text-amber-300 tracking-[0.12em] uppercase">
              APPROVAL REQUIRED
            </p>
          </div>
          <div>
            <p className="font-rajdhani text-sm font-bold text-[#f5f8ff]">{approvalRequest.name}</p>
            <p className="font-rajdhani text-[11px] text-[#ffffff50] leading-relaxed">
              {approvalRequest.description}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onReject}
              aria-label="Reject tool synthesis"
              className="px-4 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/40 text-rose-300 font-rajdhani text-xs font-bold tracking-[0.1em] uppercase hover:bg-rose-500/20 transition-all"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onApprove}
              aria-label="Approve tool synthesis"
              className="px-4 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 font-rajdhani text-xs font-bold tracking-[0.1em] uppercase hover:bg-emerald-500/20 transition-all"
            >
              Approve
            </button>
          </div>
        </div>
      )}

      {/* Bottom Interface Controls Wrapper */}
      <div className="flex flex-col gap-5 flex-shrink-0">
        {/* COMMAND INPUT BAR */}
        <div className="glass-base rounded-xl border border-blue-500/10 focus-within:border-blue-500/40 focus-within:bg-[#ffffff05] transition-all duration-200 flex items-center gap-3 px-4 py-3">
          <Search size={15} className="text-blue-400/70 flex-shrink-0" />
          <input
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Enter a query command — press Enter to trigger tool generation"
            className="flex-1 bg-transparent outline-none border-none font-rajdhani text-sm font-semibold tracking-[0.02em] text-[#f5f8ff] placeholder:text-[#ffffff30] placeholder:font-medium"
            aria-label="Command input"
          />
          <span className="font-rajdhani text-[9px] font-bold tracking-[0.15em] text-[#ffffff20] uppercase flex-shrink-0 hidden sm:block">
            ⏎ ENTER
          </span>
        </div>

        {/* SUGGESTED ACTIONS CARD ROW */}
        <div>
          <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.2em] text-[#ffffff30] uppercase mb-2.5 px-1">
            SUGGESTED ACTIONS
          </h5>
          <div className="hud-actions-grid grid grid-cols-4 gap-3.5">
            {actionCards.map(card => {
              const Icon = card.icon;
              return (
                <button
                  type="button"
                  key={card.title}
                  onClick={() => onSearchSubmit(card.query)}
                  aria-label={`${card.contextual ? 'Context action' : 'Action'}: ${card.title}`}
                  className="glass-base p-3.5 rounded-xl flex items-center gap-3 hover:border-blue-500/30 hover:bg-[#ffffff05] cursor-pointer transition-all duration-200 group text-left"
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-500/5 border border-blue-500/10 flex items-center justify-center text-blue-400 group-hover:text-blue-300 group-hover:border-blue-500/25 transition-all duration-200">
                    <Icon size={13} />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-rajdhani text-[9px] font-bold tracking-[0.05em] text-[#ffffff40] uppercase">
                      {card.contextual ? 'CONTEXT' : 'TRIGGER'}
                    </span>
                    <span className="font-rajdhani text-xs font-bold tracking-[0.03em] text-[#f5f8ff] mt-0.5">
                      {card.title}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CenterHUD;

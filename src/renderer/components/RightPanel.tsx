// src/renderer/components/RightPanel.tsx
import React, { useEffect, useRef } from 'react';
import { Terminal } from 'lucide-react';
import { LiveFeed } from './LiveFeed';
import {
  ISystemTelemetryPayload,
  IContextChipPayload,
  IRuntimeStatePayload,
  IActivityEventPayload,
} from '../../shared/ipc_protocols';

export interface ITranscriptEntry {
  sender: 'USER' | 'NOVA AI';
  text: string;
}

interface RightPanelProps {
  transcripts?: ITranscriptEntry[];
  createdTools?: any[];
  telemetry: ISystemTelemetryPayload | null;
  runtimeState: IRuntimeStatePayload | null;
  activityFeed: IActivityEventPayload[];
  contextChips: IContextChipPayload['chips'];
}

const CHIP_SEVERITY_CLASSES: Record<IContextChipPayload['chips'][number]['severity'], string> = {
  low: 'border-blue-500/30 text-blue-300/90',
  medium: 'border-amber-500/40 text-amber-300/90',
  critical: 'border-rose-500/50 text-rose-300/90',
};

// Real system status derived from the authoritative runtime state.
function deriveSystemStatus(runtimeState: IRuntimeStatePayload | null): {
  label: string;
  className: string;
  detail: string;
} {
  if (!runtimeState) {
    return { label: 'INITIALIZING', className: 'text-amber-400', detail: 'Awaiting runtime state…' };
  }
  switch (runtimeState.overall) {
    case 'ONLINE':
      return { label: 'ONLINE', className: 'text-emerald-400', detail: runtimeState.currentTask };
    case 'BOOTING':
      return { label: 'BOOTING', className: 'text-amber-400', detail: runtimeState.currentTask };
    case 'DEGRADED':
      return { label: 'DEGRADED', className: 'text-orange-400', detail: runtimeState.currentTask };
    case 'ERROR':
      return {
        label: 'ERROR',
        className: 'text-rose-400',
        detail: runtimeState.lastError ?? runtimeState.currentTask,
      };
  }
}

const ACTIVITY_TONE: Record<IActivityEventPayload['level'], string> = {
  info: 'text-cyan-300/90',
  success: 'text-emerald-400/90',
  warn: 'text-amber-300/90',
  error: 'text-rose-400/90',
};

const ACTIVITY_DOT: Record<IActivityEventPayload['level'], string> = {
  info: 'bg-cyan-400/70',
  success: 'bg-emerald-400/80',
  warn: 'bg-amber-400/80',
  error: 'bg-rose-400/80',
};

export const RightPanel: React.FC<RightPanelProps> = ({
  transcripts = [],
  createdTools = [],
  runtimeState,
  activityFeed,
  contextChips,
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom of the transcription box as text stream arrives
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts]);

  const systemStatus = deriveSystemStatus(runtimeState);

  return (
    <div className="rail-right w-[320px] h-full border-l border-[#ffffff08] bg-[#02020540] p-6 flex flex-col gap-5 overflow-y-auto select-none">
      {/* SYSTEM STATUS CARD — REAL runtime state (never fabricated) */}
      <div className="glass-base p-4 rounded-xl relative overflow-hidden flex-shrink-0">
        <div className="flex justify-between items-center">
          <div>
            <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
              SYSTEM STATUS
            </h5>
            <p
              className={`font-orbitron text-xs font-bold tracking-[0.1em] mt-1 uppercase ${systemStatus.className}`}
            >
              {systemStatus.label}
            </p>
            <p className="font-rajdhani text-[9px] font-medium text-[#ffffff45] tracking-[0.05em] mt-0.5 truncate max-w-[220px]">
              {systemStatus.detail}
            </p>
          </div>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              runtimeState?.overall === 'ONLINE'
                ? 'bg-emerald-400 animate-pulse'
                : runtimeState?.overall === 'BOOTING'
                  ? 'bg-amber-400 animate-pulse'
                  : runtimeState?.overall === 'DEGRADED'
                    ? 'bg-orange-400'
                    : runtimeState
                      ? 'bg-rose-400'
                      : 'bg-[#ffffff20]'
            }`}
          />
        </div>

        {/* Real per-subsystem health grid */}
        {runtimeState && (
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {[
              { key: 'python', label: 'PY' },
              { key: 'gemini', label: 'AI' },
              { key: 'groq', label: 'GROQ' },
              { key: 'memory', label: 'MEM' },
              { key: 'toolRegistry', label: 'TOOLS' },
              { key: 'microphone', label: 'MIC' },
            ].map(({ key, label }) => {
              const status = runtimeState[key as 'python' | 'gemini' | 'groq' | 'memory' | 'toolRegistry' | 'microphone'];
              const color =
                status === 'online'
                  ? 'text-emerald-400/90 border-emerald-500/25'
                  : status === 'unconfigured' || status === 'degraded'
                    ? 'text-amber-400/90 border-amber-500/25'
                    : status === 'error' || status === 'offline'
                      ? 'text-rose-400/90 border-rose-500/25'
                      : 'text-[#ffffff35] border-white/10';
              return (
                <div
                  key={label}
                  className={`border bg-[#ffffff02] rounded-md px-1.5 py-1 text-center ${color}`}
                  title={runtimeState.details[key] ?? status}
                >
                  <span className="font-rajdhani text-[8px] font-bold tracking-[0.1em] uppercase">
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ACTIVITY FEED CARD — real runtime events pushed over IPC */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-2 flex-shrink-0">
        <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
          ACTIVITY
        </h5>
        {activityFeed.length === 0 ? (
          <p className="font-rajdhani text-[9px] text-[#ffffff25] uppercase tracking-[0.1em]">
            Waiting for runtime events…
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto pr-1">
            {activityFeed.slice(0, 12).map(evt => (
              <div key={evt.id} className="flex items-start gap-2">
                <span className={`w-1.5 h-1.5 rounded-full mt-1 flex-shrink-0 ${ACTIVITY_DOT[evt.level]}`} />
                <p className={`font-rajdhani text-[9px] font-semibold tracking-[0.02em] leading-snug ${ACTIVITY_TONE[evt.level]}`}>
                  {evt.message}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* LIVE FEED CARD */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-3 flex-shrink-0">
        <div className="flex justify-between items-center">
          <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
            LIVE FEED
          </h5>
          <div
            className={`flex items-center gap-1.5 ${
              runtimeState?.overall === 'ONLINE'
                ? 'text-emerald-400'
                : runtimeState?.overall === 'ERROR'
                  ? 'text-rose-400'
                  : 'text-amber-400'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                runtimeState?.overall === 'ONLINE'
                  ? 'bg-emerald-400'
                  : runtimeState?.overall === 'ERROR'
                    ? 'bg-rose-400'
                    : 'bg-amber-400'
              }`}
            />
            <span className="font-rajdhani text-[9px] font-bold tracking-[0.15em] uppercase">
              {runtimeState?.overall ?? 'BOOTING'}
            </span>
          </div>
        </div>

        <LiveFeed createdTools={createdTools} />
      </div>

      {/* ──────────────────────────────────────────────────────── */}
      {/* TALL SCROLLABLE TRANSCRIPTION BOX (Replaces Voice Input) */}
      {/* ──────────────────────────────────────────────────────── */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-3 flex-1 min-h-[160px] overflow-hidden">
        <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase flex-shrink-0">
          TRANSCRIPTION BLOCK
        </h5>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
          {transcripts.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[#ffffff20] text-center p-4">
              <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">
                No active transcription stream
              </span>
            </div>
          ) : (
            transcripts.map((entry, idx) => (
              <div key={idx} className="flex flex-col gap-0.5">
                <span
                  className={`font-rajdhani text-[9px] font-bold tracking-[0.08em] uppercase ${
                    entry.sender === 'USER' ? 'text-[#00f0ff]' : 'text-[#d6e6ff]'
                  }`}
                >
                  {entry.sender}
                </span>
                <p
                  className={`font-rajdhani text-[11px] font-semibold leading-relaxed tracking-[0.02em] ${
                    entry.sender === 'USER' ? 'text-[#00f0ff]' : 'text-[#d6e6ff]'
                  }`}
                >
                  {entry.text}
                </p>
              </div>
            ))
          )}
          <div ref={chatEndRef} />
        </div>
      </div>

      {/* ACTIVE CONTEXT CARD */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-3 flex-shrink-0">
        <div className="flex justify-between items-center">
          <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
            ACTIVE CONTEXT
          </h5>
          <span className="font-rajdhani text-[9px] font-bold text-blue-400 tracking-[0.05em] uppercase">
            {contextChips.length} {contextChips.length === 1 ? 'Source' : 'Sources'}
          </span>
        </div>

        {contextChips.length === 0 ? (
          <div className="text-[#ffffff20] text-center py-2">
            <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">
              No active context
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {contextChips.map(chip => (
              <div
                key={chip.id}
                className={`bg-[#ffffff02] border px-2 py-1 rounded-full flex items-center gap-1.5 transition-all ${CHIP_SEVERITY_CLASSES[chip.severity]}`}
              >
                <span className="font-rajdhani text-[10px] font-bold tracking-[0.02em]">
                  {chip.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ──────────────────────────────────────────────────────── */}
      {/* TOOLS BOX (Replaces Memory Snapshot constellation grid)  */}
      {/* ──────────────────────────────────────────────────────── */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-3 flex-shrink-0">
        <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
          CAPABILITY TOOLS
        </h5>

        {createdTools.length === 0 ? (
          <div className="text-[#ffffff20] text-center py-2">
            <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">
              No synthesized tools yet
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto pr-1">
            {createdTools.map(tool => (
              <div
                key={tool.id}
                className="bg-emerald-500/5 border border-emerald-500/20 hover:border-emerald-400 px-2 py-1 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <Terminal size={10} className="text-emerald-400" />
                <span className="font-rajdhani text-[10px] font-bold text-emerald-300 tracking-[0.02em]">
                  {tool.name}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RightPanel;

// src/renderer/components/RightPanel.tsx
import React, { useEffect, useRef } from 'react';
import { Terminal } from 'lucide-react';
import { LiveFeed } from './LiveFeed';
import { ISystemTelemetryPayload, IContextChipPayload } from '../../shared/ipc_protocols';

export interface ITranscriptEntry {
  sender: 'USER' | 'NOVA AI';
  text: string;
}

interface RightPanelProps {
  transcripts?: ITranscriptEntry[];
  createdTools?: any[];
  telemetry: ISystemTelemetryPayload | null;
  contextChips: IContextChipPayload['chips'];
}

const CHIP_SEVERITY_CLASSES: Record<IContextChipPayload['chips'][number]['severity'], string> = {
  low: 'border-blue-500/30 text-blue-300/90',
  medium: 'border-amber-500/40 text-amber-300/90',
  critical: 'border-rose-500/50 text-rose-300/90',
};

function deriveSystemStatus(telemetry: ISystemTelemetryPayload | null): { label: string; className: string } {
  if (!telemetry) {
    return { label: '—', className: 'text-[#ffffff40]' };
  }
  switch (telemetry.geminiState) {
    case 'CONNECTED':
      return { label: 'OPTIMAL', className: 'text-cyan-400' };
    case 'CONNECTING':
      return { label: 'LINKING', className: 'text-amber-400' };
    default:
      return { label: 'DEGRADED', className: 'text-rose-400' };
  }
}

export const RightPanel: React.FC<RightPanelProps> = ({
  transcripts = [],
  createdTools = [],
  telemetry,
  contextChips,
}) => {
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom of the transcription box as text stream arrives
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcripts]);

  const systemStatus = deriveSystemStatus(telemetry);

  return (
    <div className="w-[320px] h-full border-l border-[#ffffff08] bg-[#02020540] p-6 flex flex-col gap-5 overflow-y-auto select-none">

      {/* SYSTEM STATUS CARD */}
      <div className="glass-base p-4 rounded-xl relative overflow-hidden flex-shrink-0">
        <div className="flex justify-between items-center">
          <div>
            <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
              SYSTEM STATUS
            </h5>
            <p className={`font-orbitron text-xs font-bold tracking-[0.1em] mt-1 uppercase ${systemStatus.className}`}>
              {systemStatus.label}
            </p>
          </div>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              telemetry?.geminiState === 'CONNECTED'
                ? 'bg-cyan-400 animate-pulse'
                : telemetry?.geminiState === 'CONNECTING'
                ? 'bg-amber-400 animate-pulse'
                : telemetry
                ? 'bg-rose-400'
                : 'bg-[#ffffff20]'
            }`}
          />
        </div>
      </div>

      {/* LIVE FEED CARD */}
      <div className="glass-base p-4 rounded-xl flex flex-col gap-3 flex-shrink-0">
        <div className="flex justify-between items-center">
          <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.18em] text-[#ffffff50] uppercase">
            LIVE FEED
          </h5>
          <div className="flex items-center gap-1.5 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-rajdhani text-[9px] font-bold tracking-[0.15em] uppercase">ONLINE</span>
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
              <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">No active transcription stream</span>
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
            <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">No active context</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {contextChips.map((chip) => (
              <div
                key={chip.id}
                className={`bg-[#ffffff02] border px-2 py-1 rounded-full flex items-center gap-1.5 transition-all ${CHIP_SEVERITY_CLASSES[chip.severity]}`}
              >
                <span className="font-rajdhani text-[10px] font-bold tracking-[0.02em]">{chip.label}</span>
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
            <span className="font-rajdhani text-[10px] font-bold tracking-[0.1em] uppercase">No synthesized tools yet</span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto pr-1">
            {createdTools.map((tool) => (
              <div
                key={tool.id}
                className="bg-emerald-500/5 border border-emerald-500/20 hover:border-emerald-400 px-2 py-1 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer"
              >
                <Terminal size={10} className="text-emerald-400" />
                <span className="font-rajdhani text-[10px] font-bold text-emerald-300 tracking-[0.02em]">{tool.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
};

export default RightPanel;

// src/renderer/components/CenterHUD.tsx
import React, { useState, useEffect } from 'react';
import { Camera, Globe, Folder, Search, Cpu, X, Radio } from 'lucide-react';
import { ISystemTelemetryPayload } from '../../shared/ipc_protocols';

interface CenterHUDProps {
  onSearchSubmit: (text: string) => void;
  createdTools?: any[];
  activeToolId?: string | null;
  setActiveToolId?: (id: string | null) => void;
  telemetry: ISystemTelemetryPayload | null;
}

function extractUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const CenterHUD: React.FC<CenterHUDProps> = ({
  onSearchSubmit,
  createdTools = [],
  activeToolId = null,
  setActiveToolId = () => {},
  telemetry,
}) => {
  const [inputText, setInputText] = useState('');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(intervalId);
  }, []);

  const timeLabel = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dateLabel = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputText.trim() !== '') {
      onSearchSubmit(inputText.trim());
      setInputText('');
    }
  };

  const actionCards = [
    { title: 'Live Global News', query: 'Watch live global news', icon: Globe },
    { title: 'Summarize Screen', query: 'Summarize what is on my screen', icon: Camera },
    { title: 'List Projects', query: 'List my projects', icon: Folder },
    { title: 'Search History', query: 'Search my interaction history', icon: Search },
  ];

  const activeTool = createdTools.find((t) => t.id === activeToolId);

  const captureLabel = telemetry
    ? `${telemetry.captureWidth}×${telemetry.captureHeight} @ ${telemetry.frameRate}fps`
    : '—';
  const deltaLabel = telemetry ? `${telemetry.mutatedBlocks}/${telemetry.totalBlocks} blocks` : '—';
  const latencyLabel =
    telemetry && telemetry.geminiState === 'CONNECTED' ? `${telemetry.streamLatencyMs}ms` : '—';
  const geminiLabel = telemetry ? telemetry.geminiState : '—';

  const telemetryFields = [
    { label: 'CAPTURE', value: captureLabel },
    { label: 'DELTA', value: deltaLabel },
    { label: 'LINK', value: latencyLabel },
    { label: 'GEMINI', value: geminiLabel },
  ];

  // Render live visualization for synthesized tools
  const renderToolWidget = () => {
    if (!activeTool) return null;

    const streamUrl: string | undefined = activeTool.payload?.streamUrl;

    if (streamUrl) {
      return (
        <div className="flex flex-col gap-4 h-full">
          <div className="flex justify-between items-center border-b border-[#ffffff10] pb-3">
            <div>
              <h3 className="font-orbitron text-xs font-bold text-cyan-400 tracking-[0.1em]">{activeTool.name}</h3>
              <p className="text-[10px] text-[#ffffff40]">{activeTool.description}</p>
            </div>
            <button onClick={() => setActiveToolId(null)} className="text-[#ffffff40] hover:text-white transition-colors">
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
                Type: {activeTool.payload?.streamType ?? 'unknown'} | Source: {extractUrlHost(streamUrl)}
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
            <h3 className="font-orbitron text-xs font-bold text-blue-400 tracking-[0.1em]">{activeTool.name}</h3>
            <p className="text-[10px] text-[#ffffff40]">{activeTool.description}</p>
          </div>
          <button onClick={() => setActiveToolId(null)} className="text-[#ffffff40] hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center border border-[#ffffff05] rounded-xl bg-black/20">
          <Cpu size={24} className="text-blue-400/60 mb-2" />
          <span className="font-rajdhani text-xs font-semibold text-white/60">Sandbox Tool Compiled & Registered</span>
          {activeTool.status === 'failed' ? (
            <span className="text-[9px] text-rose-400 font-bold uppercase mt-1 tracking-[0.1em]">Status: Compilation Failed</span>
          ) : (
            <span className="text-[9px] text-emerald-400 font-bold uppercase mt-1 tracking-[0.1em]">Status: Sandbox Online</span>
          )}
        </div>
      </div>
    );
  };

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
          {/* Live system telemetry strip */}
          <div className="glass-base rounded-xl border border-blue-500/10 px-4 py-2 flex items-center gap-4">
            {telemetryFields.map((field) => (
              <div key={field.label} className="flex flex-col items-end">
                <span className="font-rajdhani text-[8px] font-bold tracking-[0.15em] text-[#ffffff30] uppercase">
                  {field.label}
                </span>
                <span className="font-mono text-[10px] font-bold text-cyan-300/80 tracking-[0.05em]">
                  {field.value}
                </span>
              </div>
            ))}
          </div>

          {/* Live localized clock */}
          <div className="text-right">
            <p className="font-rajdhani text-xs font-bold tracking-[0.1em] text-blue-300/80">{timeLabel}</p>
            <p className="font-rajdhani text-[9px] font-semibold tracking-[0.15em] text-[#ffffff30] uppercase mt-0.5">
              {dateLabel}
            </p>
          </div>
        </div>
      </div>

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
                    Genesis Core execution pipeline ready. Speak or enter a query command below to trigger automatic tool generation and capture results.
                  </p>
                </div>

                {/* Display list of generated tools if any exist */}
                {createdTools.length > 0 && (
                  <div className="mt-4">
                    <span className="font-rajdhani text-[10px] font-bold tracking-[0.15em] text-[#ffffff20] uppercase block mb-2">GENERATED UTILITIES</span>
                    <div className="flex flex-wrap gap-2">
                      {createdTools.map((tool) => (
                        <button
                          key={tool.id}
                          onClick={() => setActiveToolId(tool.id)}
                          className="bg-blue-500/5 hover:bg-blue-500/10 border border-blue-500/20 px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all cursor-pointer"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          <span className="font-rajdhani text-xs font-bold text-white/80">{tool.name}</span>
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

      {/* Bottom Interface Controls Wrapper */}
      <div className="flex flex-col gap-5 flex-shrink-0">

        {/* COMMAND INPUT BAR */}
        <div className="glass-base rounded-xl border border-blue-500/10 focus-within:border-blue-500/40 focus-within:bg-[#ffffff05] transition-all duration-200 flex items-center gap-3 px-4 py-3">
          <Search size={15} className="text-blue-400/70 flex-shrink-0" />
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
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
          <div className="grid grid-cols-4 gap-3.5">
            {actionCards.map((card, idx) => {
              const Icon = card.icon;
              return (
                <div
                  key={idx}
                  onClick={() => onSearchSubmit(card.query)}
                  className="glass-base p-3.5 rounded-xl flex items-center gap-3 hover:border-blue-500/30 hover:bg-[#ffffff05] cursor-pointer transition-all duration-200 group"
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-500/5 border border-blue-500/10 flex items-center justify-center text-blue-400 group-hover:text-blue-300 group-hover:border-blue-500/25 transition-all duration-200">
                    <Icon size={13} />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-rajdhani text-[9px] font-bold tracking-[0.05em] text-[#ffffff40] uppercase">
                      TRIGGER
                    </span>
                    <span className="font-rajdhani text-xs font-bold tracking-[0.03em] text-[#f5f8ff] mt-0.5">
                      {card.title}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
};

export default CenterHUD;

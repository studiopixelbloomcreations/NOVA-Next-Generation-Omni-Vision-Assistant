// src/renderer/components/Sidebar.tsx
import React, { useState, useEffect } from 'react';
import { Loader, CheckCircle, AlertCircle, Circle } from 'lucide-react';
import { ISystemTelemetryPayload } from '../../shared/ipc_protocols';

export interface IProgressStep {
  stepId: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  timestamp: number;
}

interface SidebarProps {
  currentTab?: string;
  onTabChange?: (tab: string) => void;
  progressSteps?: IProgressStep[];
  geminiState?: ISystemTelemetryPayload['geminiState'];
}

export const Sidebar: React.FC<SidebarProps> = ({ progressSteps = [], geminiState }) => {
  const [glowPulse, setGlowPulse] = useState(0);

  // Animate the progress bar glow pulse
  useEffect(() => {
    let frameId: number;
    let t = 0;
    const animate = () => {
      t += 0.03;
      setGlowPulse(Math.sin(t) * 0.5 + 0.5);
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const connection =
    geminiState === 'CONNECTED'
      ? { label: 'ONLINE', text: 'text-emerald-400/70', ping: 'bg-emerald-400', dot: 'bg-emerald-500' }
      : geminiState === 'CONNECTING'
      ? { label: 'LINKING', text: 'text-amber-400/70', ping: 'bg-amber-400', dot: 'bg-amber-500' }
      : { label: 'OFFLINE', text: 'text-rose-400/70', ping: 'bg-rose-400', dot: 'bg-rose-500' };

  const completedCount = progressSteps.filter(s => s.status === 'completed').length;
  const totalSteps = progressSteps.length;
  const progressPercent = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;

  const getStepIcon = (status: string, label: string) => {
    if (label.includes('Found Matches') && status === 'completed') {
      return (
        <span className="relative flex h-2 w-2 mr-1">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500 shadow-[0_0_8px_#10b981]" />
        </span>
      );
    }

    switch (status) {
      case 'completed':
        return <CheckCircle size={11} className="text-emerald-400" />;
      case 'active':
        return <Loader size={11} className="text-cyan-400 animate-spin" />;
      case 'failed':
        return <AlertCircle size={11} className="text-rose-400" />;
      default:
        return <Circle size={11} className="text-[#ffffff15]" />;
    }
  };

  return (
    <div className="w-[240px] h-full flex flex-col justify-between border-r border-[#ffffff08] bg-[#02020550] px-5 py-8 select-none">
      {/* Top Header Section */}
      <div>
        <div className="mb-10 px-2">
          <h2 className="font-orbitron text-[18px] font-bold tracking-[0.25em] text-[#f5f8ff] drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">
            NOVA AI
          </h2>
          <p className="font-rajdhani text-[9px] font-semibold tracking-[0.2em] text-blue-400/40 uppercase mt-1">
            INTELLIGENCE WITHOUT LIMITS
          </p>
        </div>

        {/* Pure IPC Event-Driven Stepper */}
        <div className="mt-4 px-2">
          <h5 className="font-rajdhani text-[10px] font-bold tracking-[0.2em] text-[#ffffff30] uppercase mb-5">
            SYSTEM BOOT TRACKER
          </h5>

          {progressSteps.length === 0 ? (
            <div className="text-[#ffffff20] text-[10px] uppercase font-bold tracking-[0.1em] pl-1 animate-pulse">
              Awaiting Initializing Signal...
            </div>
          ) : (
            <div className="relative">
              {/* Vertical glowing gradient track bar */}
              <div className="absolute left-[5px] top-0 bottom-0 w-[2px] bg-[#ffffff08] rounded-full overflow-hidden">
                <div
                  className="absolute bottom-0 left-0 w-full rounded-full transition-all duration-700 ease-out"
                  style={{
                    height: `${progressPercent}%`,
                    background: `linear-gradient(to top, rgba(0, 212, 255, ${0.4 + glowPulse * 0.4}), rgba(168, 85, 247, ${0.3 + glowPulse * 0.3}), rgba(0, 212, 255, 0.1))`,
                    boxShadow: `0 0 ${6 + glowPulse * 8}px rgba(0, 212, 255, ${0.3 + glowPulse * 0.4})`,
                  }}
                />
              </div>

              {/* Stepper text items */}
              <div className="flex flex-col gap-5 pl-5">
                {progressSteps.map((step) => {
                  const isActive = step.status === 'active';
                  const isCompleted = step.status === 'completed';

                  return (
                    <div key={step.stepId} className="relative flex flex-col gap-1">
                      {/* Stepper node point */}
                      <div
                        className={`absolute -left-5 top-[2px] w-[12px] h-[12px] rounded-full flex items-center justify-center transition-all duration-300 ${
                          isCompleted
                            ? 'bg-emerald-500/20 border border-emerald-500/40'
                            : isActive
                            ? 'bg-cyan-500/20 border border-cyan-500/50'
                            : 'bg-[#ffffff03] border border-[#ffffff08]'
                        }`}
                      >
                        <div
                          className={`w-[4px] h-[4px] rounded-full ${
                            isCompleted ? 'bg-emerald-400' : isActive ? 'bg-cyan-400' : 'bg-[#ffffff10]'
                          }`}
                        />
                      </div>

                      {/* Step description */}
                      <div className="flex items-center gap-1.5">
                        {getStepIcon(step.status, step.label)}
                        <span
                          className={`font-rajdhani text-[10px] font-semibold tracking-[0.05em] leading-snug transition-colors duration-300 ${
                            isCompleted
                              ? 'text-emerald-400/90'
                              : isActive
                              ? 'text-cyan-300'
                              : 'text-[#ffffff20]'
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar Footer Section */}
      <div className="px-2">
        <div className="flex items-center gap-3">
          <div className="w-[32px] h-[32px] rounded-lg bg-[radial-gradient(circle_at_center,rgba(56,132,255,0.3)_0%,rgba(0,0,0,0.5)_100%)] border border-blue-500/20 flex items-center justify-center relative">
            <span className="absolute top-1 right-1 flex h-1.5 w-1.5">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${connection.ping}`}></span>
              <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${connection.dot}`}></span>
            </span>
            <div className="w-2.5 h-2.5 bg-blue-400 rotate-45 rounded-sm" />
          </div>
          <div>
            <h4 className="font-rajdhani text-[11px] font-bold tracking-[0.1em] text-[#f5f8ff] uppercase">
              NOVA AI
            </h4>
            <p className={`font-rajdhani text-[9px] font-medium tracking-[0.05em] uppercase ${connection.text}`}>
              {connection.label}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;

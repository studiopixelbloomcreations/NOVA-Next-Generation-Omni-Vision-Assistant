// src/renderer/components/HUDUI.tsx
import React from 'react';
import { Sidebar, IProgressStep } from './Sidebar';
import { CenterHUD } from './CenterHUD';
import { RightPanel, ITranscriptEntry } from './RightPanel';
import { WebGLWaveform } from './WebGLWaveform';
import { NovaVoiceState, ISystemTelemetryPayload, IContextChipPayload } from '../../shared/ipc_protocols';

interface HUDUIProps {
  voiceState: NovaVoiceState;
  amplitude: number; // user amplitude
  aiAmplitude?: number;
  progressSteps?: IProgressStep[];
  createdTools?: any[];
  transcripts?: ITranscriptEntry[];
  activeToolId?: string | null;
  setActiveToolId?: (id: string | null) => void;
  telemetry: ISystemTelemetryPayload | null;
  contextChips: IContextChipPayload['chips'];
  onSearchSubmit: (text: string) => void;
  toolSynthesisPhase?: string;
  toolSynthesisSteps?: any[];
  showToolSynthesis?: boolean;
}

export const HUDUI: React.FC<HUDUIProps> = ({
  voiceState,
  amplitude,
  aiAmplitude = 0,
  progressSteps = [],
  createdTools = [],
  transcripts = [],
  activeToolId = null,
  setActiveToolId = () => {},
  telemetry,
  contextChips,
  onSearchSubmit,
  toolSynthesisPhase = 'IDLE',
  toolSynthesisSteps = [],
  showToolSynthesis = true,
}) => {
  return (
    <div className="w-screen h-screen bg-[#020205] flex flex-col relative overflow-hidden text-white font-rajdhani select-none border border-blue-500/10">
      
      {/* Background radial highlight */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(10,35,80,0.04)_0%,rgba(0,0,0,0)_80%)] pointer-events-none" />

      {/* Main Body panels */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT SIDEBAR NAVIGATION & PROGRESS TRACKING */}
        <div className="relative z-10 flex-shrink-0">
          <Sidebar onTabChange={() => {}} progressSteps={progressSteps} geminiState={telemetry?.geminiState} />
        </div>

        {/* CENTER USER WORKSPACE CONSOLE (Main Interface Window replaces orb) */}
        <div className="flex-1 flex flex-col relative z-10 bg-[#02020520] backdrop-blur-[2px] overflow-hidden">
          <CenterHUD
            onSearchSubmit={onSearchSubmit}
            createdTools={createdTools}
            activeToolId={activeToolId}
            setActiveToolId={setActiveToolId}
            telemetry={telemetry}
            contextChips={contextChips}
            toolSynthesisPhase={toolSynthesisPhase}
            toolSynthesisSteps={toolSynthesisSteps}
            showToolSynthesis={showToolSynthesis}
          />
        </div>

        {/* RIGHT METRICS DASHBOARD PANEL */}
        <div className="relative z-10 flex-shrink-0">
          <RightPanel
            transcripts={transcripts}
            createdTools={createdTools}
            telemetry={telemetry}
            contextChips={contextChips}
          />
        </div>
      </div>

      {/* BOTTOM HORIZON AUDIO MESH LAYOUT */}
      <div className="h-[120px] flex-shrink-0 relative z-20">
        <WebGLWaveform
          voiceState={voiceState}
          amplitude={amplitude}
          aiAmplitude={aiAmplitude}
          height={120}
        />
      </div>

    </div>
  );
};

export default HUDUI;

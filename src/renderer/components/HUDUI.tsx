// src/renderer/components/HUDUI.tsx
import React from 'react';
import { Sidebar, IProgressStep } from './Sidebar';
import { CenterHUD, IToolApprovalRequest } from './CenterHUD';
import { RightPanel, ITranscriptEntry } from './RightPanel';
import { WebGLWaveform } from './WebGLWaveform';
import { WorkspacePanel } from './WorkspacePanel';
import {
  NovaVoiceState,
  ISystemTelemetryPayload,
  IContextChipPayload,
  IRuntimeStatePayload,
  IActivityEventPayload,
  IMicStatePayload,
  IWorkspaceSurface,
} from '../../shared/ipc_protocols';

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
  runtimeState: IRuntimeStatePayload | null;
  activityFeed: IActivityEventPayload[];
  contextChips: IContextChipPayload['chips'];
  micState: IMicStatePayload | null;
  onMicToggle: () => void;
  onMicDiagnostic: () => Promise<any>;
  onSearchSubmit: (text: string) => void;
  toolSynthesisPhase?: string;
  toolSynthesisSteps?: any[];
  showToolSynthesis?: boolean;
  approvalRequest?: IToolApprovalRequest | null;
  onApprove?: () => void;
  onReject?: () => void;
  workspaceSurfaces?: IWorkspaceSurface[];
  onCloseSurface?: (id: string) => void;
  onOpenUrl?: (url: string) => void;
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
  runtimeState,
  activityFeed,
  contextChips,
  micState,
  onMicToggle,
  onMicDiagnostic,
  onSearchSubmit,
  toolSynthesisPhase = 'IDLE',
  toolSynthesisSteps = [],
  showToolSynthesis = true,
  approvalRequest = null,
  onApprove = () => {},
  onReject = () => {},
  workspaceSurfaces = [],
  onCloseSurface = () => {},
  onOpenUrl = () => {},
}) => {
  return (
    <div className="w-screen h-screen bg-[#020205] flex flex-col relative overflow-hidden text-white font-rajdhani select-none border border-blue-500/10">
      {/* Background radial highlight */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(10,35,80,0.04)_0%,rgba(0,0,0,0)_80%)] pointer-events-none" />

      {/* Main Body panels */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT SIDEBAR NAVIGATION & PROGRESS TRACKING */}
        <div className="relative z-10 flex-shrink-0">
          <Sidebar
            onTabChange={() => {}}
            progressSteps={progressSteps}
            geminiState={telemetry?.geminiState}
            runtimeState={runtimeState}
          />
        </div>

        {/* CENTER USER WORKSPACE CONSOLE (Main Interface Window replaces orb) */}
        <div className="flex-1 flex flex-col relative z-10 bg-[#02020520] backdrop-blur-[2px] overflow-hidden">
          <CenterHUD
            onSearchSubmit={onSearchSubmit}
            createdTools={createdTools}
            activeToolId={activeToolId}
            setActiveToolId={setActiveToolId}
            telemetry={telemetry}
            runtimeState={runtimeState}
            contextChips={contextChips}
            micState={micState}
            onMicToggle={onMicToggle}
            onMicDiagnostic={onMicDiagnostic}
            toolSynthesisPhase={toolSynthesisPhase}
            toolSynthesisSteps={toolSynthesisSteps}
            showToolSynthesis={showToolSynthesis}
            approvalRequest={approvalRequest}
            onApprove={onApprove}
            onReject={onReject}
          />
          {workspaceSurfaces.some(s => s.state === 'open') && (
            <div className="absolute inset-0 z-20 bg-[#020205F2]">
              <WorkspacePanel surfaces={workspaceSurfaces} onClose={onCloseSurface} onOpenUrl={onOpenUrl} />
            </div>
          )}
        </div>

        {/* NOVA WORKSPACE — internal surfaces (workspace-first) */}
        {/* RIGHT METRICS DASHBOARD PANEL */}
        <div className="relative z-10 flex-shrink-0">
          <RightPanel
            transcripts={transcripts}
            createdTools={createdTools}
            telemetry={telemetry}
            runtimeState={runtimeState}
            activityFeed={activityFeed}
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

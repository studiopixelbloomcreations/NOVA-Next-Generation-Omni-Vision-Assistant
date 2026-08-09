import React from 'react';
import { CircularOrb } from './CircularOrb';
import { NovaVoiceState, IRuntimeStatePayload } from '../../shared/ipc_protocols';

interface MainUIProps {
  voiceState: NovaVoiceState;
  amplitude: number;
  runtimeState: IRuntimeStatePayload | null;
  onActivateHUD: () => void;
}

export const MainUI: React.FC<MainUIProps> = ({
  voiceState,
  amplitude,
  runtimeState,
  onActivateHUD,
}) => {
  return (
    <div
      onClick={onActivateHUD}
      className="w-screen h-screen bg-[#020205] flex items-center justify-center relative overflow-hidden cursor-pointer select-none"
    >
      {/* Background radial overlay */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(10,35,80,0.06)_0%,rgba(0,0,0,0)_80%)]" />

      {/* Main interactive Perlin-noise visual mesh */}
      <div className="relative z-10 w-[600px] h-[600px] flex items-center justify-center">
        <CircularOrb voiceState={voiceState} amplitude={amplitude} width={600} height={600} />

        {/* Floating Center Text exactly matching Main UI.png layout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none">
          <h1 className="font-orbitron text-[26px] font-light tracking-[1.1em] text-[#d6e6ff] translate-x-[0.55em] drop-shadow-[0_0_12px_rgba(160,200,255,0.7)] select-none">
            GENESIS
          </h1>
        </div>
      </div>

      {/* Ambience bottom label — real overall state, never fabricated */}
      <div className="absolute bottom-10 left-1/2 transform -translate-x-1/2 text-center select-none pointer-events-none">
        <p
          className={`font-rajdhani text-sm font-semibold tracking-[0.25em] uppercase ${
            runtimeState?.overall === 'ONLINE'
              ? 'text-emerald-400/70'
              : runtimeState?.overall === 'ERROR'
                ? 'text-rose-400/70'
                : 'text-blue-400/50'
          }`}
        >
          {runtimeState?.overall === 'ONLINE'
            ? '● ' + runtimeState.overall + ' — Tap anywhere or speak to open HUD'
            : runtimeState?.overall === 'ERROR'
              ? '● ' + runtimeState.overall + ' — Tap to inspect'
              : '● ' + (runtimeState?.overall ?? 'BOOTING') + ' — Tap anywhere or speak to open HUD'}
        </p>
        {runtimeState?.currentTask && runtimeState.overall !== 'ONLINE' && (
          <p className="font-rajdhani text-[10px] font-semibold tracking-[0.2em] text-[#ffffff35] uppercase mt-1">
            {runtimeState.currentTask}
          </p>
        )}
      </div>
    </div>
  );
};
export default MainUI;

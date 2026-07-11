import React from 'react';

// nodeIntegration is enabled and no preload script exists, so the Electron
// surface is window.require('electron') — not a window.electron bridge.
const ipcRenderer = (() => {
  try {
    if (typeof window !== 'undefined' && (window as any).require) {
      return (window as any).require('electron').ipcRenderer;
    }
  } catch {
    // Browser runtime: no window chrome to control.
  }
  return null;
})();

const sendWindowAction = (channel: string) => {
  ipcRenderer?.send(channel);
};

export const WindowControls: React.FC = () => {
  // Browser runtime has no frameless window to control — render nothing
  // instead of dead buttons.
  if (!ipcRenderer) return null;

  return (
    <div className="absolute top-3 right-3 z-50 flex items-center gap-2">
      <button
        type="button"
        aria-label="Minimize window"
        onClick={() => sendWindowAction('window-minimize')}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/20 text-sm text-slate-200 transition hover:bg-white/10"
      >
        —
      </button>
      <button
        type="button"
        aria-label="Maximize window"
        onClick={() => sendWindowAction('window-maximize')}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/20 text-sm text-slate-200 transition hover:bg-white/10"
      >
        □
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={() => sendWindowAction('window-close')}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-sm text-red-300 transition hover:bg-red-500/20"
      >
        ×
      </button>
    </div>
  );
};

export default WindowControls;

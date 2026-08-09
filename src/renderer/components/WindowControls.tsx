// src/renderer/components/WindowControls.tsx
import React, { useState, useEffect } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';

const getIpcRenderer = () => {
  try {
    if (typeof window !== 'undefined' && (window as any).__nova_ipc__) {
      return (window as any).__nova_ipc__;
    }
    if (typeof window !== 'undefined' && (window as any).require) {
      return (window as any).require('electron').ipcRenderer;
    }
  } catch {
    // Non-electron environment fallback
  }
  return null;
};

export const WindowControls: React.FC = () => {
  const ipc = getIpcRenderer();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!ipc) return;

    const handleMaximizeChange = (_event: any, state: boolean) => {
      setIsMaximized(state);
    };

    if (typeof ipc.on === 'function') {
      ipc.on('window-maximized-state', handleMaximizeChange);
      return () => {
        if (typeof ipc.removeListener === 'function') {
          ipc.removeListener('window-maximized-state', handleMaximizeChange);
        }
      };
    }
    return undefined;
  }, [ipc]);

  if (!ipc) return null;

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    ipc.send('window-minimize');
  };

  const handleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    ipc.send('window-maximize');
    setIsMaximized(prev => !prev);
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    ipc.send('window-close');
  };

  return (
    <div
      className="absolute top-3 right-4 z-50 flex items-center gap-1.5 select-none no-drag"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={handleMinimize}
        className="w-7 h-7 rounded-lg bg-black/40 border border-[#ffffff10] text-[#ffffff60] hover:text-cyan-300 hover:border-cyan-500/40 hover:bg-cyan-500/10 flex items-center justify-center transition-all duration-200 cursor-pointer"
      >
        <Minus size={12} />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        title={isMaximized ? 'Restore' : 'Maximize'}
        onClick={handleMaximize}
        className="w-7 h-7 rounded-lg bg-black/40 border border-[#ffffff10] text-[#ffffff60] hover:text-cyan-300 hover:border-cyan-500/40 hover:bg-cyan-500/10 flex items-center justify-center transition-all duration-200 cursor-pointer"
      >
        {isMaximized ? <Copy size={11} className="rotate-180" /> : <Square size={11} />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        title="Close"
        onClick={handleClose}
        className="w-7 h-7 rounded-lg bg-black/40 border border-rose-500/20 text-[#ffffff60] hover:text-rose-300 hover:border-rose-500/60 hover:bg-rose-500/20 flex items-center justify-center transition-all duration-200 cursor-pointer"
      >
        <X size={13} />
      </button>
    </div>
  );
};

export default WindowControls;


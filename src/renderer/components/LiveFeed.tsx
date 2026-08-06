// src/renderer/components/LiveFeed.tsx
import React, { useEffect, useRef, useState } from 'react';
import { ILiveStreamPayload } from '../../shared/ipc_protocols';

const isElectron = typeof window !== 'undefined' && window.process && (window.process as any).type === 'renderer';
const ipcRenderer = isElectron ? (window as any).require('electron').ipcRenderer : null;

interface LiveFeedProps {
  createdTools?: any[];
}

function isHlsStream(payload: ILiveStreamPayload): boolean {
  return payload.streamType === 'hls' || payload.streamUrl.endsWith('.m3u8');
}

function hasStreamPayload(tool: any): boolean {
  return typeof tool?.payload?.streamUrl === 'string' && tool.payload.streamUrl.length > 0;
}

const HlsPlayer: React.FC<{ streamUrl: string }> = ({ streamUrl }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let hls: import('hls.js').default | null = null;
    let cancelled = false;
    setFailed(false);

    (async () => {
      const { default: Hls } = await import('hls.js');
      if (cancelled || !videoRef.current) return;

      if (Hls.isSupported()) {
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal && !cancelled) {
            setFailed(true);
            hls?.destroy();
          }
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(videoRef.current);
      } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        videoRef.current.src = streamUrl;
      } else {
        setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [streamUrl]);

  if (failed) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-black/60">
        <span className="font-mono text-[9px] font-bold text-rose-400 tracking-[0.12em] uppercase">
          Stream failed to load
        </span>
        <span className="font-rajdhani text-[8px] text-[#ffffff30] uppercase tracking-[0.08em]">
          Source unreachable or unsupported
        </span>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      controls
      className="w-full h-full"
    />
  );
};

export const LiveFeed: React.FC<LiveFeedProps> = ({ createdTools = [] }) => {
  const [videoPayload, setVideoPayload] = useState<ILiveStreamPayload | null>(null);

  useEffect(() => {
    if (ipcRenderer) {
      const onToolCreated = (_event: any, payload: any) => {
        if (hasStreamPayload(payload)) {
          setVideoPayload(payload.payload);
        }
      };

      ipcRenderer.on('agent-tool-created', onToolCreated);
      return () => {
        ipcRenderer.removeListener('agent-tool-created', onToolCreated);
      };
    }
    return undefined;
  }, []);

  useEffect(() => {
    const videoTool = createdTools.find(hasStreamPayload);
    if (videoTool) {
      setVideoPayload(videoTool.payload);
    }
  }, [createdTools]);

  if (!videoPayload) {
    return (
      <div className="h-[95px] border border-cyan-500/10 bg-black/60 rounded-lg relative overflow-hidden flex flex-col items-center justify-center p-3">
        <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(#00d4ff_1px,transparent_1px)] [background-size:8px_8px] pointer-events-none" />

        <span className="font-mono text-[9px] font-bold text-cyan-400/80 tracking-[0.18em] uppercase text-center">
          NO ACTIVE STREAM
        </span>
        <span className="font-rajdhani text-[8px] text-[#ffffff20] uppercase mt-1 tracking-[0.1em]">
          Ask NOVA to open a live feed
        </span>
      </div>
    );
  }

  const useHls = isHlsStream(videoPayload);

  return (
    <div className="h-[95px] border border-emerald-500/20 bg-black rounded-lg relative overflow-hidden flex flex-col justify-between">
      <div className="flex-1 w-full h-full relative z-10 bg-[#ffffff02]">
        {videoPayload.streamUrl ? (
          useHls ? (
            <HlsPlayer streamUrl={videoPayload.streamUrl} />
          ) : (
            React.createElement('webview', {
              src: videoPayload.streamUrl,
              style: { width: '100%', height: '100%' },
            })
          )
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#ffffff30] text-[9px] uppercase font-mono font-bold tracking-[0.1em]">
            Stream reference broken
          </div>
        )}
      </div>

      <div className="flex justify-between items-center text-[10px] font-rajdhani relative z-20 mt-0.5 border-t border-[#ffffff05] bg-black/80 px-2 py-1 flex-shrink-0">
        <span className="font-bold text-emerald-400 tracking-[0.08em] uppercase flex items-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-ping" />
          AUTONOMOUS STREAM
        </span>
        <span className="font-bold text-[#ffffff30] tracking-[0.08em] uppercase">Online</span>
      </div>
    </div>
  );
};

export default LiveFeed;

// src/renderer/components/WorkspacePanel.tsx
// NOVA Workspace surfaces — everything NOVA presents stays inside the app.
//
// Renders real internal surfaces pushed by the Workspace Manager:
//   web/video  -> <webview> (real page, never an external browser)
//   image      -> <img> from base64
//   news       -> structured result list (real search items); clicks open
//                 articles in a new in-workspace web surface
//   pdf        -> <webview src="file://...">
//   file/note/code/tool-result -> text content
import React, { useMemo } from 'react';
import { IWorkspaceSurface, WorkspaceSurfaceType } from '../../shared/ipc_protocols';

// <webview> is an Electron-only element; declare it so TSX accepts it.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          style?: React.CSSProperties;
          allowpopups?: string;
        },
        HTMLElement
      >;
    }
  }
}

interface WorkspacePanelProps {
  surfaces: IWorkspaceSurface[];
  onClose: (id: string) => void;
  onOpenUrl: (url: string) => void;
}

const TYPE_LABEL: Record<WorkspaceSurfaceType, string> = {
  web: 'WEB',
  video: 'VIDEO',
  image: 'IMAGE',
  pdf: 'PDF',
  file: 'FILE',
  note: 'NOTE',
  news: 'NEWS',
  'tool-result': 'RESULT',
  code: 'CODE',
};

const TYPE_COLOR: Record<WorkspaceSurfaceType, string> = {
  web: 'text-cyan-300 border-cyan-500/40',
  video: 'text-fuchsia-300 border-fuchsia-500/40',
  image: 'text-emerald-300 border-emerald-500/40',
  pdf: 'text-rose-300 border-rose-500/40',
  file: 'text-sky-300 border-sky-500/40',
  note: 'text-amber-300 border-amber-500/40',
  news: 'text-blue-300 border-blue-500/40',
  'tool-result': 'text-violet-300 border-violet-500/40',
  code: 'text-lime-300 border-lime-500/40',
};

const DIRECT_VIDEO_RE = /\.(mp4|webm|ogg|mov)(\?|$)/i;

function SurfaceBody({
  surface,
  onOpenUrl,
}: {
  surface: IWorkspaceSurface;
  onOpenUrl: (url: string) => void;
}) {
  switch (surface.type) {
    case 'web':
    case 'pdf': {
      const src = surface.type === 'pdf' && surface.source ? `file://${surface.source}` : surface.source;
      return (
        <webview
          src={src}
          style={{ width: '100%', height: '100%', border: 'none', background: '#000' }}
        />
      );
    }
    case 'video':
      if (DIRECT_VIDEO_RE.test(surface.source)) {
        return (
          <video
            src={surface.source}
            controls
            autoPlay
            style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          />
        );
      }
      return (
        <webview
          src={surface.source}
          style={{ width: '100%', height: '100%', border: 'none', background: '#000' }}
        />
      );
    case 'image': {
      const dataUrl = `data:${surface.source || 'image/png'};base64,${surface.content ?? ''}`;
      return (
        <div className="w-full h-full flex items-center justify-center bg-black/60 overflow-hidden">
          <img
            src={dataUrl}
            alt={surface.title}
            className="max-w-full max-h-full object-contain"
          />
        </div>
      );
    }
    case 'news': {
      let items: Array<{ title: string; url: string; source?: string }> = [];
      try {
        const parsed = JSON.parse(surface.content ?? '[]');
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = [];
      }
      if (items.length === 0) {
        return <p className="text-[#ffffff60] text-xs p-3">No items in this feed.</p>;
      }
      return (
        <div className="w-full h-full overflow-y-auto p-3 flex flex-col gap-2">
          {items.map((item, i) => (
            <button
              key={i}
              onClick={() => item.url && onOpenUrl(item.url)}
              className="text-left bg-[#ffffff06] hover:bg-[#ffffff14] border border-[#ffffff10] hover:border-cyan-500/40 rounded-lg px-3 py-2 transition-colors group"
              title={item.url}
            >
              <p className="text-[12px] leading-snug text-[#e8f4ff] group-hover:text-cyan-200 transition-colors">
                {item.title}
              </p>
              <p className="text-[10px] text-[#ffffff40] mt-1 truncate">
                {item.source || item.url}
              </p>
            </button>
          ))}
        </div>
      );
    }
    case 'file':
    case 'note':
    case 'tool-result':
    case 'code':
      return (
        <pre className="w-full h-full overflow-auto p-3 text-[11px] leading-relaxed text-[#d6e6f5] whitespace-pre-wrap break-words m-0">
          {surface.content ?? ''}
        </pre>
      );
    default:
      return <p className="text-[#ffffff60] text-xs p-3">Unsupported surface type.</p>;
  }
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ surfaces, onClose, onOpenUrl }) => {
  const openSurfaces = useMemo(() => surfaces.filter(s => s.state === 'open'), [surfaces]);
  if (openSurfaces.length === 0) return null;

  return (
    <div className="w-[400px] h-full border-l border-[#ffffff10] bg-[#02040aCC] backdrop-blur-md flex flex-col overflow-hidden select-none">
      <div className="px-4 py-3 border-b border-[#ffffff10] flex items-center justify-between flex-shrink-0">
        <div>
          <h5 className="font-orbitron text-[10px] font-bold tracking-[0.2em] text-cyan-300/90 uppercase">
            NOVA Workspace
          </h5>
          <p className="font-rajdhani text-[10px] text-[#ffffff50] mt-0.5">
            {openSurfaces.length} surface{openSurfaces.length === 1 ? '' : 's'} open
          </p>
        </div>
        <div className="text-[9px] text-[#ffffff40] font-rajdhani tracking-wider">
          INSIDE NOVA
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-3">
        {openSurfaces.map(surface => (
          <div
            key={surface.id}
            className="glass-base rounded-xl overflow-hidden border border-[#ffffff12] flex flex-col min-h-[140px] max-h-[340px]"
          >
            <div className="px-3 py-2 border-b border-[#ffffff10] flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`font-orbitron text-[8px] font-bold tracking-[0.15em] px-1.5 py-0.5 rounded border ${TYPE_COLOR[surface.type]}`}
                >
                  {TYPE_LABEL[surface.type]}
                </span>
                <p className="text-[11px] font-semibold text-[#e8f4ff] truncate" title={surface.title}>
                  {surface.title}
                </p>
              </div>
              <button
                onClick={() => onClose(surface.id)}
                className="text-[#ffffff50] hover:text-rose-400 hover:bg-rose-500/10 rounded-md w-6 h-6 flex items-center justify-center transition-colors flex-shrink-0"
                title="Close surface"
                aria-label={`Close ${surface.title}`}
              >
                ✕
              </button>
            </div>
            <div className="flex-1 min-h-0 relative">
              <SurfaceBody surface={surface} onOpenUrl={onOpenUrl} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WorkspacePanel;

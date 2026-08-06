// src/renderer/components/WebGLWaveform.tsx
import React, { useRef, useEffect } from 'react';
import { NovaVoiceState } from '../../shared/ipc_protocols';

interface WebGLWaveformProps {
  voiceState: NovaVoiceState;
  amplitude: number; // acts as userAmplitude
  aiAmplitude?: number; // optional AI amplitude
  width?: number | string;
  height?: number;
}

export const WebGLWaveform: React.FC<WebGLWaveformProps> = ({
  voiceState,
  amplitude,
  aiAmplitude = 0,
  width = '100%',
  height = 120,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const amplitudeRef = useRef(amplitude);
  const aiAmplitudeRef = useRef(aiAmplitude);
  const voiceStateRef = useRef(voiceState);

  // Keep refs in sync without triggering re-renders
  amplitudeRef.current = amplitude;
  aiAmplitudeRef.current = aiAmplitude;
  voiceStateRef.current = voiceState;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;

    // Particles system — created once, stored in closure
    const particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      alpha: number;
      size: number;
      color: string;
    }> = [];

    const maxParticles = 240;
    for (let i = 0; i < maxParticles; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: (canvas.height / 2) + (Math.random() - 0.5) * 40,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.15,
        alpha: 0.15 + Math.random() * 0.7,
        size: 0.5 + Math.random() * 1.5,
        color: Math.random() > 0.4 ? 'rgba(0, 212, 255, ' : 'rgba(168, 85, 247, ',
      });
    }

    // Fractal Brownian Motion (fBm) approximation for horizontal filament deforming
    const fbm = (x: number, t: number): number => {
      let value = 0;
      let amp = 0.5;
      let freq = 1.0;
      for (let i = 0; i < 4; i++) {
        value += amp * Math.sin(x * freq + t * 1.8);
        freq *= 2.2;
        amp *= 0.45;
      }
      return value;
    };

    const render = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }
      const centerY = h / 2;

      ctx.clearRect(0, 0, w, h);

      // Read latest values from refs (no re-render dependency)
      const currentVoiceState = voiceStateRef.current;
      const currentUserAmp = amplitudeRef.current || 0;
      const currentAiAmp = aiAmplitudeRef.current || 0;
      const combinedAmp = Math.max(currentUserAmp, currentAiAmp, 0.015);

      // Voice State Parameters
      let speed = 0.018;
      let waveComplexity = 1.0;
      let particleScatter = 1.0;

      if (currentVoiceState === 'LISTENING') {
        speed = 0.045;
        waveComplexity = 1.5;
        particleScatter = 2.2;
      } else if (currentVoiceState === 'REASONING') {
        speed = 0.06;
        waveComplexity = 2.2;
        particleScatter = 1.6;
      } else if (currentVoiceState === 'SPEAKING') {
        speed = 0.038;
        waveComplexity = 1.3;
        particleScatter = 2.8;
      } else {
        // IDLE
        speed = 0.012;
        waveComplexity = 0.8;
        particleScatter = 0.5;
      }

      time += speed;

      // Create neon gradients matching Waveform UI.jpg
      const cyanGlow = ctx.createLinearGradient(0, 0, w, 0);
      cyanGlow.addColorStop(0, 'rgba(0, 100, 255, 0)');
      cyanGlow.addColorStop(0.3, 'rgba(0, 212, 255, 0.15)');
      cyanGlow.addColorStop(0.5, 'rgba(0, 212, 255, 0.9)');
      cyanGlow.addColorStop(0.7, 'rgba(0, 212, 255, 0.15)');
      cyanGlow.addColorStop(1, 'rgba(0, 100, 255, 0)');

      const purpleGlow = ctx.createLinearGradient(0, 0, w, 0);
      purpleGlow.addColorStop(0, 'rgba(168, 85, 247, 0)');
      purpleGlow.addColorStop(0.2, 'rgba(168, 85, 247, 0.1)');
      purpleGlow.addColorStop(0.4, 'rgba(168, 85, 247, 0.65)');
      purpleGlow.addColorStop(0.6, 'rgba(168, 85, 247, 0.65)');
      purpleGlow.addColorStop(0.8, 'rgba(168, 85, 247, 0.1)');
      purpleGlow.addColorStop(1, 'rgba(168, 85, 247, 0)');

      // Draw background glow spot at the center
      const radialGlow = ctx.createRadialGradient(w / 2, centerY, 5, w / 2, centerY, Math.min(w / 2, 260));
      radialGlow.addColorStop(0, `rgba(0, 180, 255, ${0.14 * combinedAmp})`);
      radialGlow.addColorStop(0.5, `rgba(140, 50, 255, ${0.05 * combinedAmp})`);
      radialGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = radialGlow;
      ctx.fillRect(0, 0, w, h);

      // Set shadow characteristics for glowing filament lines
      ctx.shadowBlur = 10 + combinedAmp * 22;
      ctx.shadowColor = 'rgba(0, 180, 255, 0.65)';

      // ────────────────────────────────────────────────────────
      // Layer A & B: Waves generation using fBm and electric spikes
      // ────────────────────────────────────────────────────────
      const waveLayers = 6;
      for (let l = 0; l < waveLayers; l++) {
        ctx.beginPath();
        const layerOffset = l * (Math.PI / 4);
        const thickness = l === 0 ? 2.4 : 0.8 + (l * 0.35);
        ctx.lineWidth = thickness;

        if (l % 2 === 0) {
          ctx.strokeStyle = cyanGlow;
          ctx.shadowColor = 'rgba(0, 212, 255, 0.45)';
        } else {
          ctx.strokeStyle = purpleGlow;
          ctx.shadowColor = 'rgba(168, 85, 247, 0.35)';
        }

        const pointsCount = 140;
        for (let i = 0; i <= pointsCount; i++) {
          const x = (i / pointsCount) * w;
          const relativeX = i / pointsCount;

          // Envelope boundary tapering
          const envelope = Math.sin(relativeX * Math.PI);

          // Bi-directional amplitude weight (read from refs)
          const ampModifier = (1 - relativeX) * currentUserAmp + relativeX * currentAiAmp + 0.05;
          
          // Basic horizontal sine calculation
          const theta = relativeX * Math.PI * 3 * waveComplexity + time + layerOffset;
          let yOffset = Math.sin(theta) * 32 * ampModifier * envelope;

          // FBm calculations for organic micro-ripples
          const noise = fbm(relativeX * Math.PI * 4 * waveComplexity, time + layerOffset);
          yOffset += noise * 18 * ampModifier * envelope;

          // Generate razor-sharp electric spikes when active tokens drop (amplitude surges)
          if (combinedAmp > 0.15 && relativeX > 0.3 && relativeX < 0.7) {
            const spikeIndex = Math.sin(relativeX * Math.PI * 35 + time * 12);
            if (spikeIndex > 0.82) {
              // Add steep vector spikes
              yOffset += (Math.random() > 0.5 ? 1 : -1) * (combinedAmp * 52) * envelope;
            }
          }

          const y = centerY + yOffset;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      ctx.shadowBlur = 0;

      // ────────────────────────────────────────────────────────
      // Layer E: Fine Line Web Mesh
      // ────────────────────────────────────────────────────────
      ctx.strokeStyle = 'rgba(0, 180, 255, 0.08)';
      ctx.lineWidth = 0.45;
      ctx.beginPath();
      const step = 6;
      for (let x = 0; x < w; x += step) {
        const relativeX = x / w;
        const envelope = Math.sin(relativeX * Math.PI);
        const ampModifier = (1 - relativeX) * currentUserAmp + relativeX * currentAiAmp + 0.04;
        
        const yTop = centerY - Math.abs(Math.sin(relativeX * Math.PI * 2.8 + time) * 38 * ampModifier * envelope);
        const yBottom = centerY + Math.abs(Math.cos(relativeX * Math.PI * 2.8 - time) * 38 * ampModifier * envelope);

        ctx.moveTo(x, yTop);
        ctx.lineTo(x, yBottom);
      }
      ctx.stroke();

      // ────────────────────────────────────────────────────────
      // Layer D: Particle Mist (warped by frequency offsets)
      // ────────────────────────────────────────────────────────
      particles.forEach((p) => {
        if (p.x < 0 || p.x > w) {
          p.x = Math.random() * w;
          p.y = centerY + (Math.random() - 0.5) * 20;
        }

        const relativeX = p.x / w;
        const ampModifier = (1 - relativeX) * currentUserAmp + relativeX * currentAiAmp + 0.05;

        // Animate particles based on physical resonance scaling
        p.x += p.vx * (1 + ampModifier * particleScatter * 4.5);
        p.y += p.vy + (Math.random() - 0.5) * (ampModifier * 2.0);

        const maxOffset = 50 * ampModifier * Math.sin(relativeX * Math.PI) + 15;
        if (Math.abs(p.y - centerY) > maxOffset) {
          p.y = centerY + (Math.random() - 0.5) * maxOffset * 0.82;
        }

        ctx.fillStyle = p.color + (p.alpha * (0.35 + ampModifier * 0.65)) + ')';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });

      // Horizon separator
      ctx.strokeStyle = 'rgba(0, 120, 255, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, centerY);
      ctx.lineTo(w, centerY);
      ctx.stroke();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div
      className="relative overflow-hidden bg-black/85 flex items-center justify-center border-t border-[#ffffff05]"
      style={{ width: typeof width === 'number' ? `${width}px` : width }}
    >
      <canvas
        ref={canvasRef}
        className="w-full block"
        style={{ height: typeof height === 'number' ? `${height}px` : height }}
      />
    </div>
  );
};

export default WebGLWaveform;

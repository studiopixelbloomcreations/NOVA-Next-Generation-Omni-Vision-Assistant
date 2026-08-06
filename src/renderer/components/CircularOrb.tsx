// src/renderer/components/CircularOrb.tsx
import React, { useRef, useEffect } from 'react';
import { NovaVoiceState } from '../../shared/ipc_protocols';

interface CircularOrbProps {
  voiceState: NovaVoiceState;
  amplitude: number;
  width?: number;
  height?: number;
}

export const CircularOrb: React.FC<CircularOrbProps> = ({
  voiceState,
  amplitude,
  width = 600,
  height = 600,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;

    // Orbiting particle array with individual physics parameters
    const particles: Array<{
      angle: number;
      radius: number;
      speed: number;
      size: number;
      alpha: number;
      offsetX: number;
      offsetY: number;
    }> = [];

    for (let i = 0; i < 180; i++) {
      particles.push({
        angle: Math.random() * Math.PI * 2,
        radius: 160 + Math.random() * 80,
        speed: 0.002 + Math.random() * 0.006,
        size: 0.6 + Math.random() * 1.8,
        alpha: 0.15 + Math.random() * 0.7,
        offsetX: 0,
        offsetY: 0,
      });
    }

    // Fractal Brownian Motion (fBm) approximation for organic visual warping
    const fbm = (x: number, y: number, t: number): number => {
      let value = 0;
      let amp = 0.5;
      let freq = 1.0;
      for (let i = 0; i < 4; i++) {
        // Overlay sinusoidal coordinate fields at scaling frequencies
        value += amp * Math.sin(x * freq + y * freq * 0.8 + t * 1.6);
        freq *= 2.1;
        amp *= 0.48;
      }
      return value;
    };

    const render = () => {
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;

      // Dynamics parameters based on current voiceState
      let speed = 0.012;
      let complexity = 3.0;
      let layers = 6;
      let baseRadius = 175;
      let waveScale = 18;

      if (voiceState === 'LISTENING') {
        speed = 0.035;
        complexity = 4.5;
        layers = 7;
        waveScale = 25 + amplitude * 45;
      } else if (voiceState === 'REASONING') {
        speed = 0.05;
        complexity = 6.0;
        layers = 9;
        baseRadius = 170 + Math.sin(time * 2.5) * 8;
        waveScale = 16;
      } else if (voiceState === 'SPEAKING') {
        speed = 0.022;
        complexity = 3.5;
        layers = 6;
        waveScale = 22 + amplitude * 55;
      } else {
        // IDLE
        speed = 0.007;
        complexity = 2.2;
        layers = 5;
        waveScale = 10;
      }

      time += speed;

      // Render radial back-glow
      const radialGlow = ctx.createRadialGradient(cx, cy, baseRadius - 80, cx, cy, baseRadius + 120);
      radialGlow.addColorStop(0, 'rgba(0, 5, 20, 0)');
      radialGlow.addColorStop(0.5, `rgba(10, 70, 190, ${0.05 + amplitude * 0.08})`);
      radialGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = radialGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius + 150, 0, Math.PI * 2);
      ctx.fill();

      // Glowing circular filaments (fBm-warped)
      ctx.shadowBlur = 12 + amplitude * 18;
      ctx.shadowColor = 'rgba(56, 150, 255, 0.6)';

      for (let l = 0; l < layers; l++) {
        ctx.beginPath();
        const layerPhase = (l * Math.PI) / layers;
        const layerAmp = waveScale * (1 - l * 0.11);
        const opacity = 0.25 + (0.55 * (layers - l)) / layers;
        
        if (l % 2 === 0) {
          ctx.strokeStyle = `rgba(56, 170, 255, ${opacity})`;
        } else {
          ctx.strokeStyle = `rgba(168, 85, 247, ${opacity * 0.85})`;
        }
        ctx.lineWidth = 0.8 + (l * 0.35);

        for (let a = 0; a <= 360; a += 1) {
          const angle = (a * Math.PI) / 180;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);

          // Calculate displacement using Fractal Brownian Motion
          const noise = fbm(
            cosA * complexity + layerPhase,
            sinA * complexity - layerPhase,
            time
          );

          // Add vocal resonance scaling directly to the radial offset
          const r = baseRadius + noise * layerAmp * (1.0 + amplitude * 1.5);
          const x = cx + cosA * r;
          const y = cy + sinA * r;

          if (a === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.closePath();
        ctx.stroke();
      }

      // Draw Orbiting Neural Particles (warped by vocal resonance offsets)
      ctx.shadowBlur = 4;
      ctx.shadowColor = '#ffffff';
      particles.forEach((p) => {
        p.angle += p.speed * (voiceState === 'REASONING' ? 2.5 : 1.0);
        
        // Use fBm calculations to add micro-vibrations
        const noiseVal = fbm(Math.cos(p.angle) * 2, Math.sin(p.angle) * 2, time) * 10;
        
        // Vocal Resonance Scaling: pushes particles outward when active
        const resonanceScale = 1.0 + amplitude * 2.2;
        const currentRadius = p.radius * resonanceScale + noiseVal;

        const x = cx + Math.cos(p.angle) * currentRadius;
        const y = cy + Math.sin(p.angle) * currentRadius;

        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * (0.7 + 0.3 * Math.sin(time + p.angle))})`;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.shadowBlur = 0;
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [voiceState, amplitude, width, height]);

  return (
    <div className="relative flex items-center justify-center">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="max-w-full max-h-full"
      />
    </div>
  );
};

export default CircularOrb;

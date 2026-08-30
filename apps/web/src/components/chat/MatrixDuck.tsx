import { useEffect, useRef } from "react";
import { useAppStore } from "../../lib/store";

interface MatrixDuckProps {
  isWorking: boolean;
  size?: number;
}

function ModernDuck({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 96 96" aria-hidden="true">
      <defs>
        <linearGradient id="duck-shell" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f8d34f" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <ellipse cx="48" cy="78" rx="27" ry="5" fill="#020617" opacity=".55" />
      <path d="M25 64c0-18 10-31 27-31 14 0 23 9 23 23 0 16-12 25-29 25-12 0-21-6-21-17Z" fill="url(#duck-shell)" stroke="#fde68a" strokeWidth="2" />
      <circle cx="58" cy="29" r="15" fill="#facc15" stroke="#fde68a" strokeWidth="2" />
      <path d="M69 30h15c3 0 4 4 1 6l-12 5Z" fill="#fb923c" stroke="#fed7aa" strokeWidth="2" />
      <circle cx="62" cy="26" r="2.5" fill="#0f172a" />
      <path className="matrix-duck-wing matrix-duck-wing-left" d="M29 52c-10 3-12 13-3 17 6 4 13-1 17-7-5-1-9-4-14-10Z" fill="#f59e0b" stroke="#fde68a" strokeWidth="1.5" />
      <path className="matrix-duck-wing matrix-duck-wing-right" d="M67 52c10 3 12 13 3 17-6 4-13-1-17-7 5-1 9-4 14-10Z" fill="#f59e0b" stroke="#fde68a" strokeWidth="1.5" />
      <path d="M34 79v7m25-7v7" stroke="#fb923c" strokeWidth="4" strokeLinecap="round" />
      <path d="M31 86h8m17 0h8" stroke="#fdba74" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function MatrixDuck({ isWorking, size = 80 }: MatrixDuckProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { animationStyle } = useAppStore();
  const matrixCharsRef = useRef<string>("ｦｧｨｩｪｫｬｭｮｯ");
  const particlesRef = useRef<
    Array<{ x: number; y: number; vx: number; vy: number; life: number }>
  >([]);

  // Matrix falling characters animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isWorking) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = (canvas.width = canvas.offsetWidth);
    const height = (canvas.height = canvas.offsetHeight);
    let animationId: number;

    const chars = matrixCharsRef.current.split("");
    const particles: (typeof particlesRef.current) = [];

    const animate = () => {
      // Clear with transparency
      ctx.fillStyle = "rgba(0, 15, 0, 0.1)";
      ctx.fillRect(0, 0, width, height);

      // Add new particles
      if (Math.random() > 0.7) {
        particles.push({
          x: Math.random() * width,
          y: -20,
          vx: (Math.random() - 0.5) * 2,
          vy: Math.random() * 3 + 2,
          life: 1,
        });
      }

      // Draw and update particles
      ctx.fillStyle = "#00ff00";
      ctx.font = "14px monospace";
      ctx.globalAlpha = 0.7;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        if (!p) continue;
        const char = chars[Math.floor(Math.random() * chars.length)] || "ｦ";

        ctx.fillText(char, p.x, p.y);

        p.x += p.vx;
        p.y += p.vy;
        p.life -= 0.01;

        if (p.life <= 0 || p.y > height) {
          particles.splice(i, 1);
        }
      }

      ctx.globalAlpha = 1;
      particlesRef.current = particles;
      animationId = requestAnimationFrame(animate);
    };

    animate();
    return () => cancelAnimationFrame(animationId);
  }, [isWorking]);

  if (!isWorking) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ width: size, height: size }}>
        <ModernDuck className="h-14 w-14 animate-bounce" />
      </div>
    );
  }

  // Render different animation styles based on settings
  if (animationStyle === "minimal") {
    return (
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-lg border border-green-500/30 bg-black/20 flex items-center justify-center">
          <ModernDuck className="h-14 w-14 animate-pulse" />
        </div>
      </div>
    );
  }

  if (animationStyle === "neon") {
    return (
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-lg border-2 border-green-400 bg-black/40 flex items-center justify-center"
          style={{ boxShadow: "0 0 20px rgba(34, 197, 94, 0.5)" }}>
          <ModernDuck className="h-14 w-14 animate-pulse" />
          <div className="absolute inset-0 rounded-lg border-2 border-green-500 opacity-30 animate-pulse"
            style={{ animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" }} />
        </div>
      </div>
    );
  }

  // Default Matrix style
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <style>{`
        @keyframes matrix-duck-type-left {
          0%, 100% { transform: rotate(9deg) translate(0, 0); }
          50% { transform: rotate(-19deg) translate(-2px, 3px); }
        }
        @keyframes matrix-duck-type-right {
          0%, 100% { transform: rotate(-9deg) translate(0, 0); }
          50% { transform: rotate(19deg) translate(2px, 3px); }
        }
        .matrix-duck-wing-left { transform-origin: 43px 60px; animation: matrix-duck-type-left .28s ease-in-out infinite; }
        .matrix-duck-wing-right { transform-origin: 53px 60px; animation: matrix-duck-type-right .28s ease-in-out .14s infinite; }
        @media (prefers-reduced-motion: reduce) {
          .matrix-duck-wing-left, .matrix-duck-wing-right { animation: none; }
        }
      `}</style>
      {/* Matrix background */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 rounded-lg border border-green-500/50"
        style={{
          background: "rgba(0, 20, 0, 0.3)",
          width: size,
          height: size,
        }}
      />
      {/* Centered working duck; its wings animate like typing hands. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <ModernDuck className="h-[76%] w-[76%] animate-pulse" />
      </div>
    </div>
  );
}

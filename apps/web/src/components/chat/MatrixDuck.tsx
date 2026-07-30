import { useEffect, useRef } from "react";
import { useAppStore } from "../../lib/store";

interface MatrixDuckProps {
  isWorking: boolean;
  size?: number;
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
        <div className="text-5xl animate-bounce">🦆</div>
      </div>
    );
  }

  // Render different animation styles based on settings
  if (animationStyle === "minimal") {
    return (
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-lg border border-green-500/30 bg-black/20 flex items-center justify-center">
          <div className="text-4xl animate-pulse">🦆</div>
        </div>
      </div>
    );
  }

  if (animationStyle === "neon") {
    return (
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 rounded-lg border-2 border-green-400 bg-black/40 flex items-center justify-center"
          style={{ boxShadow: "0 0 20px rgba(34, 197, 94, 0.5)" }}>
          <div className="text-4xl animate-pulse">🦆</div>
          <div className="absolute inset-0 rounded-lg border-2 border-green-500 opacity-30 animate-pulse"
            style={{ animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite" }} />
        </div>
      </div>
    );
  }

  // Default Matrix style
  return (
    <div className="relative" style={{ width: size, height: size }}>
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
      {/* Duck on laptop */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative">
          {/* Laptop */}
          <div className="w-16 h-10 bg-gray-800 rounded-b-lg border-2 border-gray-700 flex items-center justify-center">
            {/* Screen glow */}
            <div className="w-14 h-8 bg-green-900/50 rounded border border-green-500/30 flex items-center justify-center text-xs text-green-400 font-mono overflow-hidden">
              <div className="animate-pulse text-center">
                <div className="text-[6px]">●●●</div>
                <div className="text-[6px]">●●●</div>
              </div>
            </div>
          </div>
          {/* Duck */}
          <div className="absolute -top-4 -right-2 text-2xl animate-pulse">
            🦆
          </div>
          {/* Keyboard */}
          <div className="w-16 h-1 bg-gray-700 rounded-b-lg" />
        </div>
      </div>
    </div>
  );
}

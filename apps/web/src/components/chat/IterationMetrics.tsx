import { Zap, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

interface IterationMetric {
  iterationNumber: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  timestamp: Date;
}

export function IterationMetrics({
  conversationId,
  socket,
}: {
  conversationId: string;
  socket: any;
}) {
  const [metrics, setMetrics] = useState<IterationMetric[]>([]);
  const [totalTokensUsed, setTotalTokensUsed] = useState(0);

  useEffect(() => {
    if (!socket) return;

    const handleIterationMetrics = (data: any) => {
      // Only show for this conversation
      if (data.conversationId !== conversationId) return;

      const metric: IterationMetric = {
        iterationNumber: data.iterationNumber,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        timestamp: new Date(data.timestamp),
      };

      setMetrics((prev) => [...prev, metric].slice(-5)); // Keep last 5 iterations

      if (data.totalTokens) {
        setTotalTokensUsed((prev) => prev + data.totalTokens);
      }
    };

    socket.on("agent:iteration-metrics", handleIterationMetrics);
    return () => socket.off("agent:iteration-metrics", handleIterationMetrics);
  }, [socket, conversationId]);

  if (metrics.length === 0) {
    return null;
  }

  const latestMetric = metrics[metrics.length - 1]!;
  const avgTokensPerIteration = Math.round(totalTokensUsed / metrics.length);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-300 rounded-lg border border-amber-800/40 bg-amber-900/20 p-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        {/* Real-time metrics */}
        <div className="flex items-center gap-4 flex-1">
          <div className="flex items-center gap-1">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-gray-400">Iteration</span>
            <span className="font-semibold text-amber-300">{latestMetric.iterationNumber}</span>
          </div>

          {latestMetric.inputTokens && (
            <div className="flex items-center gap-1 text-gray-400">
              <span>In:</span>
              <span className="font-mono text-amber-300">{latestMetric.inputTokens}</span>
            </div>
          )}

          {latestMetric.outputTokens && (
            <div className="flex items-center gap-1 text-gray-400">
              <span>Out:</span>
              <span className="font-mono text-amber-300">{latestMetric.outputTokens}</span>
            </div>
          )}

          {latestMetric.totalTokens && (
            <div className="flex items-center gap-1 text-gray-400 font-semibold">
              <span>Total:</span>
              <span className="text-amber-300">{latestMetric.totalTokens}</span>
            </div>
          )}
        </div>

        {/* Summary stats */}
        <div className="flex items-center gap-3 text-gray-500 border-l border-amber-800/40 pl-3">
          <div className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            <span className="text-[11px]">{totalTokensUsed} total</span>
          </div>
          <div className="text-[11px]">
            <span className="text-gray-600">avg:</span>
            <span className="text-amber-300 ml-1 font-mono">{avgTokensPerIteration}</span>
            <span className="text-gray-600">/iter</span>
          </div>
        </div>
      </div>

      {/* Iterations history */}
      {metrics.length > 1 && (
        <div className="mt-2 pt-2 border-t border-amber-800/30">
          <div className="flex items-center gap-1 flex-wrap">
            {metrics.map((metric, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-900/30 text-amber-200"
                title={`Iteration ${metric.iterationNumber}: ${metric.totalTokens} tokens`}
              >
                <span className="font-mono">#{metric.iterationNumber}</span>
                <span className="text-amber-400 font-semibold">{metric.totalTokens}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

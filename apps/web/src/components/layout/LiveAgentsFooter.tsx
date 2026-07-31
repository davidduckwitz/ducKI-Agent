import { NavLink } from "react-router-dom";
import { Activity } from "lucide-react";
import { useI18n } from "../../lib/i18n";

/**
 * Pinned to the bottom of the sidebar and never collapses - the running-agent count
 * is the one thing that must stay visible no matter which sections are folded away.
 */
export function LiveAgentsFooter({
  runningCount,
  runningTools,
  gatewayActive,
  bitcoinPuzzles,
  collapsed,
}: {
  runningCount: number;
  runningTools: Set<string>;
  gatewayActive: boolean;
  bitcoinPuzzles: number;
  collapsed?: boolean;
}) {
  const { t } = useI18n();
  const busy = runningCount > 0;

  if (collapsed) {
    return (
      <div className="border-t border-border p-2">
        <NavLink
          to="/agents"
          title={`${t("layout.sidebar.liveAgents")}: ${runningCount}`}
          className={({ isActive }) =>
            `rail-item relative mx-auto ${isActive ? "bg-emerald-500/20 text-emerald-300" : ""}`
          }
        >
          <Activity className={`h-4 w-4 ${busy ? "text-emerald-400" : ""}`} />
          {busy && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-bold text-white">
              {runningCount}
            </span>
          )}
        </NavLink>
      </div>
    );
  }

  return (
    <div className="border-t border-border p-2">
      <NavLink
        to="/agents"
        className={({ isActive }) =>
          `block rounded-lg border px-2.5 py-2 transition ${
            isActive ? "border-emerald-500/60 bg-emerald-500/15" : "border-border bg-accent/50 hover:border-foreground/30"
          }`
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <Activity className={`h-3.5 w-3.5 ${busy ? "animate-pulse text-emerald-400" : "text-muted-foreground"}`} />
            {t("layout.sidebar.liveAgents")}
          </span>
          <span
            className={`rounded-full px-1.5 text-[11px] font-semibold ${
              busy ? "bg-emerald-500/20 text-emerald-300" : "bg-muted text-muted-foreground"
            }`}
          >
            {runningCount}
          </span>
        </div>

        {runningTools.size > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {Array.from(runningTools).map((toolName) => (
              <span key={toolName} className="chip max-w-full text-yellow-300">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-400" />
                <span className="truncate">{toolName}</span>
              </span>
            ))}
          </div>
        )}

        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">{t("layout.gateway")}</span>
          <span className={`inline-flex items-center gap-1 ${gatewayActive ? "text-green-400" : "text-red-400"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${gatewayActive ? "bg-green-400" : "bg-red-400"}`} />
            {gatewayActive ? t("common.active") : t("common.inactive")}
          </span>
        </div>

        {bitcoinPuzzles > 0 && (
          <div className="mt-1 flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground">Bitcoin Puzzle</span>
            <span className="inline-flex items-center gap-1 text-yellow-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-yellow-400" />
              {bitcoinPuzzles}
            </span>
          </div>
        )}
      </NavLink>
    </div>
  );
}

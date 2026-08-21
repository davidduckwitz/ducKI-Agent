import { useState } from "react";
import { AlertTriangle, Check, ShieldAlert, X } from "lucide-react";
import type { RenderedChatMessage } from "../chat/chatTypes";

interface PartWriteFile {
  path?: string;
  received?: number;
  totalParts?: number;
}

const ANIMATE_IN = "animate-in fade-in slide-in-from-top-1 duration-300";

/**
 * Visible banner for the CodingAgent's part-write decisions in the coding-area chat.
 * The CodingAgent emits a `decision` event when a parted write (totalParts/partNumber)
 * was left incomplete at run end:
 *  - part_healed    -> a follow-up run appended the missing parts (success)
 *  - part_warning   -> healing did not finish the job, parts are still missing (warning)
 *  - part_heal_error-> the healing attempt itself failed (error)
 * Those events only ever showed up as collapsible rows in the Activity tab; the chat tab
 * filters event messages out entirely. This banner surfaces them prominently in the chat.
 */
export function PartWriteBanner({
  msg,
  t,
}: {
  msg: RenderedChatMessage;
  t: (key: string) => string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const data = msg.eventData;

  const kind: "healed" | "warning" | "error" =
    data?.part_healed === true ? "healed" : data?.part_heal_error === true ? "error" : "warning";

  const files = Array.isArray(data?.files) ? (data.files as PartWriteFile[]) : [];

  if (dismissed) return null;

  const styles = {
    healed: {
      box: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
      icon: <Check className="h-4 w-4 shrink-0 text-emerald-300" />,
      title: t("codingPage.partWriteHealed"),
    },
    warning: {
      box: "border-amber-500/40 bg-amber-500/10 text-amber-100",
      icon: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />,
      title: t("codingPage.partWriteWarning"),
    },
    error: {
      box: "border-red-500/40 bg-red-500/10 text-red-100",
      icon: <ShieldAlert className="h-4 w-4 shrink-0 text-red-300" />,
      title: t("codingPage.partWriteHealError"),
    },
  }[kind];

  return (
    <div
      role={kind === "warning" || kind === "error" ? "alert" : "status"}
      className={`${ANIMATE_IN} rounded-lg border px-3 py-2 text-xs ${styles.box}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5">{styles.icon}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{styles.title}</span>
            <span className="shrink-0 text-[10px] opacity-60">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </div>
          {msg.content && <div className="whitespace-pre-wrap opacity-90">{msg.content}</div>}
          {files.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {files.map((file, index) => (
                <li key={index} className="flex items-baseline gap-2">
                  <span className="break-all font-mono text-[11px]">{file.path}</span>
                  {typeof file.received === "number" && typeof file.totalParts === "number" && (
                    <span className="shrink-0 rounded bg-black/25 px-1.5 py-0.5 text-[10px]">
                      {file.received}/{file.totalParts} {t("codingPage.partWriteParts")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          title={t("common.close")}
          aria-label={t("common.close")}
          className="shrink-0 rounded p-0.5 opacity-60 transition hover:bg-black/20 hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

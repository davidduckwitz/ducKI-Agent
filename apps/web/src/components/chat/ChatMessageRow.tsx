import { FileText, User } from "lucide-react";
import { DuckyMascot } from "./DuckyMascot";
import { eventDataWithoutInternalText, eventIcon, eventLabel, extractInternalLlmText } from "./eventMeta";
import type { RenderedChatMessage } from "./chatTypes";
import { api } from "../../lib/api";

interface RowCommonProps {
  compactMode?: boolean;
}

const ANIMATE_IN = "animate-in fade-in slide-in-from-bottom-1 duration-300";
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

type Attachment = Record<string, unknown>;

function isImageAttachment(attachment: Attachment): boolean {
  const mimeType = attachment["mimeType"];
  if (typeof mimeType === "string") return mimeType.startsWith("image/");
  const name = attachment["name"] ?? attachment["path"] ?? attachment["url"];
  return typeof name === "string" && IMAGE_EXTENSIONS.test(name);
}

// Prefer the locally-saved shared-workspace path (served inline via /shared/view or
// downloadable via /shared/download); fall back to the original external URL (e.g. a
// Discord CDN link) if no local copy exists yet.
function attachmentViewSrc(attachment: Attachment): string | undefined {
  const path = attachment["path"];
  if (typeof path === "string" && path.length > 0) return api.shared.viewUrl(path);
  const url = attachment["url"];
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

function attachmentDownloadHref(attachment: Attachment): string | undefined {
  const path = attachment["path"];
  if (typeof path === "string" && path.length > 0) return api.shared.downloadUrl(path);
  const url = attachment["url"];
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

export function EventRow({
  msg,
  t,
  expanded,
  onToggle,
}: RowCommonProps & {
  msg: RenderedChatMessage;
  t: (key: string) => string;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const internalText = extractInternalLlmText(msg.eventData);
  const restData = eventDataWithoutInternalText(msg.eventData);

  return (
    <details
      open={expanded}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className={`${ANIMATE_IN} rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-100`}
    >
      <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          {eventIcon(msg.eventType)}
          <span className="font-medium whitespace-nowrap">{eventLabel(t, msg.eventType)}</span>
          <span className="text-indigo-200/80 truncate">{msg.content}</span>
        </span>
        <span className="text-[10px] text-indigo-200/70 whitespace-nowrap">
          {new Date(msg.timestamp).toLocaleTimeString()}
        </span>
      </summary>
      <div className="mt-2 pl-6 space-y-2">
        <div className="text-indigo-100 whitespace-pre-wrap">{msg.content}</div>
        {internalText && (
          <div className="rounded border border-fuchsia-400/30 bg-fuchsia-500/10 p-2">
            <div className="text-[10px] uppercase tracking-wide text-fuchsia-200/80 mb-1">
              {t("chat.internalLlmResponse")}
            </div>
            <div className="text-fuchsia-50/90 whitespace-pre-wrap text-[11px]">{internalText}</div>
          </div>
        )}
        {restData && (
          <pre className="rounded border border-indigo-400/20 bg-black/20 p-2 text-[11px] whitespace-pre-wrap overflow-x-auto">
            {JSON.stringify(restData, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

export function MessageRow({ msg, compactMode, t }: RowCommonProps & { msg: RenderedChatMessage; t: (key: string) => string }) {
  const metadata = msg.metadata as
    | {
        portal?: string;
        mode?: string;
        agentEmoji?: string;
        attachments?: Array<Record<string, unknown>>;
        voice?: { transcript?: string };
      }
    | undefined;

  return (
    <div className={`${ANIMATE_IN} flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          msg.role === "user" ? "bg-blue-600" : "bg-gray-700"
        }`}
      >
        {msg.role === "user" ? <User className="w-4 h-4" /> : <DuckyMascot working={false} size={24} />}
      </div>
      <div
        className={`${
          compactMode
            ? "max-w-[94%] sm:max-w-[82%] lg:max-w-[74%] rounded-lg px-3 py-2 text-[13px]"
            : "max-w-[90%] sm:max-w-[80%] lg:max-w-[72%] rounded-xl px-4 py-3 text-sm"
        } whitespace-pre-wrap ${msg.role === "user" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-100"}`}
      >
        {metadata && (metadata.portal || metadata.mode || metadata.agentEmoji) && (
          <div className="mb-2 flex flex-wrap gap-1 text-[10px]">
            {typeof metadata.portal === "string" && (
              <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 uppercase tracking-wide">
                {metadata.portal}
              </span>
            )}
            {typeof metadata.mode === "string" && (
              <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 capitalize">
                {metadata.mode}
              </span>
            )}
            {typeof metadata.agentEmoji === "string" && (
              <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5">{metadata.agentEmoji}</span>
            )}
          </div>
        )}
        {msg.content}
        {metadata?.attachments && metadata.attachments.length > 0 && (() => {
          const images = metadata.attachments.filter(isImageAttachment);
          const documents = metadata.attachments.filter((a) => !isImageAttachment(a));
          return (
            <div className="mt-2 space-y-2">
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {images.map((attachment, index) => {
                    const src = attachmentViewSrc(attachment);
                    const name = String(attachment.name ?? `${t("chat.fileLabel")} ${index + 1}`);
                    if (!src) return null;
                    return (
                      <a key={index} href={src} target="_blank" rel="noreferrer">
                        <img
                          src={src}
                          alt={name}
                          className="max-w-[220px] max-h-[220px] rounded-lg border border-white/10 object-cover"
                        />
                      </a>
                    );
                  })}
                </div>
              )}
              {documents.length > 0 && (
                <div className="space-y-1 text-[11px] opacity-90">
                  {documents.map((attachment, index) => {
                    const name = String(attachment.name ?? `${t("chat.fileLabel")} ${index + 1}`);
                    const href = attachmentDownloadHref(attachment);
                    return (
                      <div key={index} className="rounded border border-white/10 bg-black/20 px-2 py-1">
                        {href ? (
                          <a
                            href={href}
                            className="font-medium inline-flex items-center gap-1 underline decoration-dotted hover:text-white"
                          >
                            <FileText className="w-3 h-3" />
                            {name}
                          </a>
                        ) : (
                          <div className="font-medium">{name}</div>
                        )}
                        <div className="opacity-80 break-all">
                          {String(attachment.path ?? attachment.url ?? attachment.mimeType ?? t("chat.noAttachmentLabel"))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}
        {metadata?.voice && (
          <div className="mt-2 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] opacity-90">
            <div className="font-medium">{t("chat.voiceInput")}</div>
            <div className="opacity-80">{String(metadata.voice.transcript ?? "")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function StreamingRow({
  compactMode,
  streamingContent,
  t,
}: RowCommonProps & { streamingContent: string; t: (key: string) => string }) {
  return (
    <div className={`${ANIMATE_IN} flex gap-3`}>
      <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
        <DuckyMascot working size={26} title={t("chat.duckyWorkingTitle")} />
      </div>
      <div
        className={`${
          compactMode
            ? "max-w-[94%] sm:max-w-[82%] lg:max-w-[74%] rounded-lg px-3 py-2 text-[13px]"
            : "max-w-[90%] sm:max-w-[80%] lg:max-w-[72%] rounded-xl px-4 py-3 text-sm"
        } bg-gray-800 text-gray-100 whitespace-pre-wrap`}
      >
        {streamingContent || <span className="text-gray-400 animate-pulse">{t("chat.workingLabel")}</span>}
      </div>
    </div>
  );
}

import { FileText, User } from "lucide-react";
import { DuckyMascot } from "./DuckyMascot";
import { eventDataWithoutInternalText, eventIcon, eventLabel, eventTone, extractInternalLlmText } from "./eventMeta";
import type { RenderedChatMessage } from "./chatTypes";
import { api } from "../../lib/api";
import { BrowserPreview } from "./BrowserPreview";
import { MarkdownMessage } from "./MarkdownMessage";

interface RowCommonProps {
  compactMode?: boolean;
  /** Layout for narrow side panels (the coding workspace): no avatar gutter, full-width
   *  bubbles, sender shown as a small label. Chat bubbles with a 32px avatar and a 90%
   *  max-width leave almost no room for code in a 400px column. */
  dense?: boolean;
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

  // Support both old format (direct tokens) and new format (nested)
  const llmTokens = msg.eventData?.llmTokens as
    | { input?: number; output?: number; total?: number; estimated?: boolean }
    | undefined;
  const tokensEstimated = llmTokens?.estimated === true;
  const inputTokens = (llmTokens?.input ?? msg.eventData?.inputTokens) as number | undefined;
  const outputTokens = (llmTokens?.output ?? msg.eventData?.outputTokens) as number | undefined;
  const totalTokens = (llmTokens?.total ?? msg.eventData?.totalTokens) as number | undefined;

  const agentTokens = msg.eventData?.agentTokens as { system?: number; tools?: number; skills?: number; total?: number } | undefined;
  const combinedTokens = msg.eventData?.combinedTokens as { input?: number; output?: number; total?: number } | undefined;

  if (msg.eventType === "browser_preview") {
    // Browser preview is rendered as a full component without additional props
    // All interactivity is handled within the BrowserPreview component
    return (
      <div className={`${ANIMATE_IN} space-y-2`}>
        <BrowserPreview msg={msg} />
      </div>
    );
  }

  const toolName = typeof msg.eventData?.["toolName"] === "string" ? (msg.eventData["toolName"] as string) : undefined;

  return (
    <details
      open={expanded}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className={`${ANIMATE_IN} rounded-lg border px-2.5 py-1.5 text-xs ${eventTone(msg.eventType, msg.eventData)}`}
    >
      <summary className="list-none cursor-pointer select-none flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="self-center shrink-0">{eventIcon(msg.eventType, msg.eventData)}</span>
          {/* The tool name is the label that matters for tool events; the generic
              "Tool Call"/"Tool Result" wording adds nothing next to it. */}
          <span className="font-medium whitespace-nowrap opacity-90">
            {toolName ?? eventLabel(t, msg.eventType)}
          </span>
          <span className="truncate opacity-80">{msg.content}</span>
        </span>
        <span className="flex items-center gap-2 text-[10px] opacity-60 whitespace-nowrap shrink-0">
          {totalTokens && (
            <span title={tokensEstimated ? "Geschaetzt - der Provider hat keine Token-Zahlen geliefert" : undefined}>
              ⚡ {tokensEstimated ? "~" : ""}
              {totalTokens}
            </span>
          )}
          <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
        </span>
      </summary>
      <div className="mt-2 pl-6 space-y-2">
        <div className="whitespace-pre-wrap opacity-90">{msg.content}</div>
        {(inputTokens || outputTokens || totalTokens || agentTokens || combinedTokens) && (
          <div className="space-y-2">
            {(agentTokens || combinedTokens) && (
              <div className="rounded border border-purple-400/30 bg-purple-500/10 p-2">
                <div className="text-[10px] uppercase tracking-wide text-purple-200/80 mb-1">
                  🤖 Agent Context Tokens
                </div>
                <div className="grid grid-cols-2 gap-2 text-purple-50/90 text-[11px]">
                  {agentTokens?.system && <div>System: <span className="font-semibold">{agentTokens.system}</span></div>}
                  {agentTokens?.tools && <div>Tools: <span className="font-semibold">{agentTokens.tools}</span></div>}
                  {agentTokens?.skills && agentTokens.skills > 0 && <div>Skills: <span className="font-semibold">{agentTokens.skills}</span></div>}
                  {agentTokens?.total && <div>Subtotal: <span className="font-semibold">{agentTokens.total}</span></div>}
                </div>
              </div>
            )}
            {(inputTokens || outputTokens || totalTokens) && (
              <div className="rounded border border-amber-400/30 bg-amber-500/10 p-2">
                <div className="text-[10px] uppercase tracking-wide text-amber-200/80 mb-1">
                  🧠 LLM Response Tokens{tokensEstimated ? " (geschaetzt)" : ""}
                </div>
                <div className="grid grid-cols-3 gap-2 text-amber-50/90 text-[11px]">
                  {inputTokens && <div>Input: <span className="font-semibold">{inputTokens}</span></div>}
                  {outputTokens && <div>Output: <span className="font-semibold">{outputTokens}</span></div>}
                  {totalTokens && <div>Total: <span className="font-semibold">{totalTokens}</span></div>}
                </div>
              </div>
            )}
            {combinedTokens && (
              <div className="rounded border border-green-400/30 bg-green-500/10 p-2">
                <div className="text-[10px] uppercase tracking-wide text-green-200/80 mb-1">
                  ⚡ Combined Total Tokens
                </div>
                <div className="grid grid-cols-3 gap-2 text-green-50/90 text-[11px]">
                  {combinedTokens.input && <div>Input: <span className="font-semibold">{combinedTokens.input}</span></div>}
                  {combinedTokens.output && <div>Output: <span className="font-semibold">{combinedTokens.output}</span></div>}
                  {combinedTokens.total && <div>Total: <span className="font-semibold">{combinedTokens.total}</span></div>}
                </div>
              </div>
            )}
          </div>
        )}
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

export function MessageRow({
  msg,
  compactMode,
  dense,
  t,
}: RowCommonProps & { msg: RenderedChatMessage; t: (key: string) => string }) {
  const metadata = msg.metadata as
    | {
        portal?: string;
        mode?: string;
        agentEmoji?: string;
        attachments?: Array<Record<string, unknown>>;
        voice?: { transcript?: string };
      }
    | undefined;

  if (dense) {
    return (
      <div className={`${ANIMATE_IN} min-w-0`}>
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500">
          {msg.role === "user" ? <User className="h-3 w-3" /> : <DuckyMascot working={false} size={14} />}
          <span>{msg.role === "user" ? t("chat.roleYou") : t("chat.roleAgent")}</span>
        </div>
        <div
          className={`rounded-lg border px-3 py-2 text-[13px] ${
            msg.role === "user"
              ? "whitespace-pre-wrap border-blue-500/40 bg-blue-500/10 text-blue-50"
              : "border-gray-700 bg-gray-800/70 text-gray-100"
          }`}
        >
          {msg.role === "user" ? msg.content : <MarkdownMessage content={msg.content} />}
        </div>
      </div>
    );
  }

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
        } ${msg.role === "user" ? "whitespace-pre-wrap bg-blue-600 text-white" : "bg-gray-800 text-gray-100"}`}
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
        {/* Agent replies are markdown (code fences, lists, headings); the user's own text
            is not, and reinterpreting it would mangle whatever they typed. */}
        {msg.role === "user" ? msg.content : <MarkdownMessage content={msg.content} />}
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
        } bg-gray-800 text-gray-100`}
      >
        {streamingContent ? (
          <MarkdownMessage content={streamingContent} />
        ) : (
          <span className="text-gray-400 animate-pulse">{t("chat.workingLabel")}</span>
        )}
      </div>
    </div>
  );
}

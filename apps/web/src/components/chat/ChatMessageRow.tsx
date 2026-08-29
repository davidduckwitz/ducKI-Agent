import { useState } from "react";
import { Check, Copy, FileText, GitCompare, RotateCcw, User } from "lucide-react";
import { DuckyMascot } from "./DuckyMascot";
import { eventDataWithoutInternalText, eventIcon, eventLabel, eventTone, extractInternalLlmText } from "./eventMeta";
import type { RenderedChatMessage } from "./chatTypes";
import { api } from "../../lib/api";
import { BrowserPreview } from "./BrowserPreview";
import { ChecklistView, type ChecklistItemView } from "./ChecklistView";
import { MarkdownMessage } from "./MarkdownMessage";
import { ReasoningDisplay } from "./ReasoningDisplay";
import { ThinkBlockDisplay } from "./ThinkBlockDisplay";
import { VoicePlayback } from "./VoicePlayback";
import { useSmoothedText } from "../../hooks/useSmoothedText";
import { useStreamingSpeech } from "../../hooks/useStreamingSpeech";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";
import { useAgentTurnEndSignal } from "../../hooks/useAgentTurnEndSignal";

/** Parsed think block with metadata */
interface ThinkBlock {
  id: string;
  content: string;
  startTime: Date;
  endTime?: Date;
  toolCalls: Array<{
    position: number;
    toolName: string;
    purpose: string;
    status: "planned" | "executing" | "completed" | "failed";
    confidence: number;
  }>;
  thinkingDepth: "shallow" | "medium" | "deep";
  tokenEstimate?: number;
  status: "streaming" | "complete";
}

interface RowCommonProps {
  compactMode?: boolean;
  /** Layout for narrow side panels (the coding workspace): no avatar gutter, full-width
   *  bubbles, sender shown as a small label. Chat bubbles with a 32px avatar and a 90%
   *  max-width leave almost no room for code in a 400px column. */
  dense?: boolean;
  /**
   * Present only in the coding workspace (CodingAgentPanel), where a filesystem-edit tool
   * result can carry a `checkpointSha` (see withPerEditCheckpoints). Lets EventRow offer a
   * "Diff ansehen" link straight from the activity feed instead of the user hunting for the
   * matching checkpoint by label/time in the separate Changes tab. Absent in normal chat,
   * where tool results never carry a checkpointSha - the link simply never renders there.
   */
  onOpenCheckpoint?: (sha: string) => void;
}

const ANIMATE_IN = "animate-in fade-in slide-in-from-bottom-1 duration-300";
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

type Attachment = Record<string, unknown>;

function isImageAttachment(attachment: Attachment): boolean {
  const mimeType = attachment["mimeType"];
  if (typeof mimeType === "string") return mimeType.startsWith("image/");
  const name = attachment["name"] ?? attachment["path"] ?? attachment["url"];
  return typeof name === "string" && IMAGE_EXTENSIONS.test(name);
}

function isVideoAttachment(attachment: Attachment): boolean {
  const mimeType = attachment["mimeType"];
  if (typeof mimeType === "string") return mimeType.startsWith("video/");
  const name = attachment["name"] ?? attachment["path"] ?? attachment["url"];
  return typeof name === "string" && VIDEO_EXTENSIONS.test(name);
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
  onOpenCheckpoint,
}: RowCommonProps & {
  msg: RenderedChatMessage;
  t: (key: string) => string;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const internalText = extractInternalLlmText(msg.eventData);
  const resolvedPath = typeof msg.eventData?.["path"] === "string" ? (msg.eventData["path"] as string) : undefined;
  const checkpointSha = typeof msg.eventData?.["checkpointSha"] === "string" ? (msg.eventData["checkpointSha"] as string) : undefined;
  const restDataRaw = eventDataWithoutInternalText(msg.eventData);
  // reflection/diagnosticErrors/path/checkpointSha get their own dedicated rendering below -
  // drop them from the generic JSON dump so the same information isn't shown twice.
  const restData = restDataRaw && ["reflection", "diagnosticErrors", "path", "checkpointSha"].some((key) => key in restDataRaw)
    ? (() => {
        const { reflection: _reflection, diagnosticErrors: _diagnosticErrors, path: _path, checkpointSha: _checkpointSha, ...rest } =
          restDataRaw as Record<string, unknown>;
        return Object.keys(rest).length > 0 ? rest : undefined;
      })()
    : restDataRaw;

  // Support both old format (direct tokens) and new format (nested)
  const llmTokens = msg.eventData?.llmTokens as
    | { input?: number; output?: number; total?: number; estimated?: boolean }
    | undefined;
  const tokensEstimated = llmTokens?.estimated === true;
  const inputTokens = (llmTokens?.input ?? msg.eventData?.inputTokens) as number | undefined;
  const outputTokens = (llmTokens?.output ?? msg.eventData?.outputTokens) as number | undefined;
  const totalTokens = (llmTokens?.total ?? msg.eventData?.totalTokens) as number | undefined;

  const agentTokens = msg.eventData?.agentTokens as { system?: number; tools?: number; skills?: number; total?: number } | undefined;

  if (msg.eventType === "browser_preview") {
    // Browser preview is rendered as a full component without additional props
    // All interactivity is handled within the BrowserPreview component
    return (
      <div className={`${ANIMATE_IN} space-y-2`}>
        <BrowserPreview msg={msg} />
      </div>
    );
  }

  // Handle think block events with modern streaming UI
  if (msg.eventType === "thinking") {
    const thinkBlocks = msg.eventData?.["thinkBlocks"] as ThinkBlock[] | undefined;
    const isStreaming = msg.eventData?.["isStreaming"] as boolean | undefined;

    if (thinkBlocks && thinkBlocks.length > 0) {
      return (
        <div className={`${ANIMATE_IN} space-y-3`}>
          {thinkBlocks.map((block, idx) => (
            <ThinkBlockDisplay
              key={block.id}
              thinkBlock={block}
              isStreaming={isStreaming}
              showStats={true}
              compact={false}
            />
          ))}
        </div>
      );
    }
  }

  // Session checklist: render the step list from the event's `items` snapshot. Every
  // checklist event (created/progress/done) carries the full current snapshot, so this
  // renders correctly both live and when a conversation is replayed from persisted events.
  if (msg.eventType === "checklist") {
    const items = msg.eventData?.["items"] as ChecklistItemView[] | undefined;
    if (Array.isArray(items) && items.length > 0) {
      const phase = msg.eventData?.["phase"];
      const isDone = phase === "done";
      return (
        <details
          open={!isDone}
          onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
          className={`${ANIMATE_IN} rounded-lg border px-2.5 py-1.5 text-xs ${eventTone("checklist")}`}
        >
          <summary className="list-none cursor-pointer select-none flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-1.5 min-w-0">
              <span className="self-center shrink-0">{eventIcon("checklist")}</span>
              <span className="font-medium whitespace-nowrap opacity-90">{eventLabel(t, "checklist")}</span>
              <span className="truncate opacity-80">{msg.content}</span>
            </span>
            <span className="text-[10px] opacity-60 whitespace-nowrap shrink-0">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
          </summary>
          <div className="mt-2">
            <ChecklistView items={items} />
          </div>
        </details>
      );
    }
  }

  const toolName = typeof msg.eventData?.["toolName"] === "string" ? (msg.eventData["toolName"] as string) : undefined;
  const selectedSkills = msg.eventData?.["selectedSkills"] as Array<{ name: string; score?: number }> | undefined;
  const retryCount = msg.eventData?.["retryCount"] as number | undefined;
  const originalError = msg.eventData?.["originalError"] as string | undefined;
  // Failure reflection (FailureAwareCodingAgent): why the agent changed strategy after a
  // repeated verify failure, previously visible only in the next attempt's prompt.
  const reflection = msg.eventData?.["reflection"] as
    | { diagnosis?: string; avoid?: string[]; nextActions?: string[] }
    | undefined;
  // Live diagnostic errors (tsc etc.) surfaced right after the edit that introduced them,
  // instead of only on demand via the `status` tool.
  const diagnosticErrors = msg.eventData?.["diagnosticErrors"] as
    | Array<{ file?: string; count?: number; errors?: string[] }>
    | undefined;

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
          {resolvedPath && (
            <span
              className="truncate font-mono text-[10px] opacity-50"
              title={`Aufgeloester Pfad: ${resolvedPath}`}
            >
              {resolvedPath}
            </span>
          )}
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
        {checkpointSha && onOpenCheckpoint && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onOpenCheckpoint(checkpointSha);
            }}
            className="flex items-center gap-1.5 rounded border border-emerald-400/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/20"
          >
            <GitCompare className="h-3 w-3" />
            Diff ansehen
          </button>
        )}
        {(inputTokens || outputTokens || totalTokens || agentTokens) && (
          <div className="space-y-2">
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
            {agentTokens && (
              <div className="rounded border border-purple-400/30 bg-purple-500/10 p-2">
                <div className="text-[10px] uppercase tracking-wide text-purple-200/80 mb-1">
                  🤖 Davon System-Prompt/Tools/Skills (bereits in "Input" oben enthalten)
                </div>
                <div className="grid grid-cols-2 gap-2 text-purple-50/90 text-[11px]">
                  {agentTokens?.system && <div>System: <span className="font-semibold">{agentTokens.system}</span></div>}
                  {agentTokens?.tools && <div>Tools: <span className="font-semibold">{agentTokens.tools}</span></div>}
                  {agentTokens?.skills && agentTokens.skills > 0 && <div>Skills: <span className="font-semibold">{agentTokens.skills}</span></div>}
                  {agentTokens?.total && <div>Subtotal: <span className="font-semibold">{agentTokens.total}</span></div>}
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
        {reflection && (
          <div className="rounded border border-orange-400/30 bg-orange-500/10 p-2">
            <div className="text-[10px] uppercase tracking-wide text-orange-200/80 mb-1">
              Strategiewechsel nach wiederholtem Fehlschlag
            </div>
            {reflection.diagnosis && (
              <div className="text-orange-50/90 text-[11px]">{reflection.diagnosis}</div>
            )}
            {reflection.avoid && reflection.avoid.length > 0 && (
              <div className="mt-1 text-[11px]">
                <span className="text-orange-200/70">Vermeiden: </span>
                <span className="text-orange-50/90">{reflection.avoid.join(" · ")}</span>
              </div>
            )}
            {reflection.nextActions && reflection.nextActions.length > 0 && (
              <div className="mt-1 text-[11px]">
                <span className="text-orange-200/70">Nächste Schritte: </span>
                <span className="text-orange-50/90">{reflection.nextActions.join(" · ")}</span>
              </div>
            )}
          </div>
        )}
        {diagnosticErrors && diagnosticErrors.length > 0 && (
          <div className="rounded border border-red-400/30 bg-red-500/10 p-2">
            <div className="text-[10px] uppercase tracking-wide text-red-200/80 mb-1">
              Offene Diagnosefehler
            </div>
            <div className="space-y-1">
              {diagnosticErrors.map((entry, index) => (
                <div key={`${entry.file ?? "unknown"}-${index}`} className="text-[11px]">
                  <span className="font-medium text-red-50/90">{entry.file ?? "unbekannte Datei"}</span>
                  <span className="text-red-200/70"> ({entry.count ?? entry.errors?.length ?? "?"} Fehler)</span>
                  {entry.errors && entry.errors.length > 0 && (
                    <div className="pl-2 text-red-50/70 whitespace-pre-wrap">{entry.errors.slice(0, 3).join("\n")}</div>
                  )}
                </div>
              ))}
            </div>
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

/** Copy / resend actions that fade in on hover, the way chat agents surface them. */
function MessageActions({
  content,
  onResend,
  t,
  align,
}: {
  content: string;
  onResend?: () => void;
  t: (key: string) => string;
  align: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable in insecure contexts - nothing useful to show here.
    }
  };

  return (
    <div
      className={`flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
        align === "end" ? "justify-end" : ""
      }`}
    >
      <button
        onClick={() => void copy()}
        title={copied ? t("chat.copied") : t("chat.copy")}
        className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onResend && (
        <button
          onClick={onResend}
          title={t("chat.resend")}
          className="rounded p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function MessageRow({
  msg,
  compactMode,
  dense,
  onResend,
  t,
  autoPlayVoice,
}: RowCommonProps & {
  msg: RenderedChatMessage;
  onResend?: () => void;
  t: (key: string) => string;
  /** True only for a message that arrived live during this viewing session - never for
   *  history loaded when a conversation is opened, which would otherwise auto-speak every
   *  past agent message back-to-back. See ChatContainer's conversationOpenedAtRef. */
  autoPlayVoice?: boolean;
}) {
  const metadata = msg.metadata as
    | {
        portal?: string;
        mode?: string;
        agentEmoji?: string;
        attachments?: Array<Record<string, unknown>>;
        voice?: { transcript?: string };
      }
    | undefined;

  const isUser = msg.role === "user";

  const badges = metadata && (metadata.portal || metadata.mode || metadata.agentEmoji) && (
    <div className="mb-2 flex flex-wrap gap-1">
      {typeof metadata.portal === "string" && <span className="chip uppercase tracking-wide">{metadata.portal}</span>}
      {typeof metadata.mode === "string" && <span className="chip capitalize">{metadata.mode}</span>}
      {typeof metadata.agentEmoji === "string" && <span className="chip">{metadata.agentEmoji}</span>}
    </div>
  );

  const extras = (
    <>
      {metadata?.attachments && metadata.attachments.length > 0 && (() => {
        const images = metadata.attachments.filter(isImageAttachment);
        const videos = metadata.attachments.filter(isVideoAttachment);
        const documents = metadata.attachments.filter((a) => !isImageAttachment(a) && !isVideoAttachment(a));
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
                        className="max-h-[220px] max-w-[220px] rounded-lg border border-border object-cover"
                      />
                    </a>
                  );
                })}
              </div>
            )}
            {videos.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {videos.map((attachment, index) => {
                  const src = attachmentViewSrc(attachment);
                  if (!src) return null;
                  return (
                    <video
                      key={index}
                      src={src}
                      controls
                      className="max-h-[260px] max-w-[320px] rounded-lg border border-border"
                    />
                  );
                })}
              </div>
            )}
            {documents.length > 0 && (
              <div className="space-y-1 text-[11px]">
                {documents.map((attachment, index) => {
                  const name = String(attachment.name ?? `${t("chat.fileLabel")} ${index + 1}`);
                  const href = attachmentDownloadHref(attachment);
                  return (
                    <div key={index} className="rounded border border-border bg-background/50 px-2 py-1">
                      {href ? (
                        <a
                          href={href}
                          className="inline-flex items-center gap-1 font-medium underline decoration-dotted hover:text-primary"
                        >
                          <FileText className="h-3 w-3" />
                          {name}
                        </a>
                      ) : (
                        <div className="font-medium">{name}</div>
                      )}
                      <div className="break-all text-muted-foreground">
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
        <div className="mt-2 rounded border border-border bg-background/50 px-2 py-1 text-[11px]">
          <div className="font-medium">{t("chat.voiceInput")}</div>
          <div className="text-muted-foreground">{String(metadata.voice.transcript ?? "")}</div>
        </div>
      )}
    </>
  );

  if (dense) {
    return (
      <div className={`${ANIMATE_IN} min-w-0`}>
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {isUser ? <User className="h-3 w-3" /> : <DuckyMascot working={false} size={14} />}
          <span>{isUser ? t("chat.roleYou") : t("chat.roleAgent")}</span>
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-[13px] ${
            isUser ? "whitespace-pre-wrap bg-muted text-foreground" : "border border-border bg-card text-foreground"
          }`}
        >
          {isUser ? msg.content : <MarkdownMessage content={msg.content} />}
        </div>
      </div>
    );
  }

  // The user's own turn stays a compact bubble; the agent's answer runs full width with
  // no container, so long markdown (code fences, tables) is not squeezed into 72%.
  if (isUser) {
    return (
      <div className={`${ANIMATE_IN} group flex flex-col items-end gap-1`}>
        <div
          className={`max-w-[85%] rounded-2xl bg-muted text-foreground ${
            compactMode ? "px-3.5 py-2 text-[13px]" : "px-4 py-2.5 text-sm"
          }`}
        >
          {badges}
          {/* The user's text is not markdown - reinterpreting it would mangle what they typed. */}
          <div className="whitespace-pre-wrap break-words leading-relaxed">{msg.content}</div>
          {extras}
        </div>
        <MessageActions content={msg.content} onResend={onResend} t={t} align="end" />
      </div>
    );
  }

  const thinking = msg.eventData?.thinking as string | undefined;

  return (
    <div className={`${ANIMATE_IN} group`}>
      <div className="mb-1.5 flex items-center gap-2">
        <DuckyMascot working={false} size={20} />
        <span className="text-xs font-semibold text-muted-foreground">{t("chat.roleAgent")}</span>
      </div>
      <div className={`min-w-0 text-foreground ${compactMode ? "text-[13px]" : "text-sm"} leading-relaxed`}>
        {badges}
        <MarkdownMessage content={msg.content} />
        {extras}
        <ReasoningDisplay thinking={thinking} compact={compactMode} />
      </div>
      <div className="mt-2 flex items-center gap-4">
        <div className="flex-1">
          <MessageActions content={msg.content} t={t} align="start" />
        </div>
        <VoicePlayback text={msg.content} autoPlay={autoPlayVoice} />
      </div>
    </div>
  );
}

export function StreamingRow({
  compactMode,
  streamingContent,
  t,
}: RowCommonProps & { streamingContent: string; t: (key: string) => string }) {
  // Only this live-preview box animates - once text lands as a permanent message (see
  // store.ts's assistant_text handling) it renders as plain MarkdownMessage, no smoothing.
  const smoothed = useSmoothedText(streamingContent);
  const { enableTTS, autoPlayTTS, ttsStreamingMode } = useVoiceSettings();
  const streamingSpeechActive = enableTTS && autoPlayTTS && ttsStreamingMode;
  const { isPlaying: isSpeakingStream } = useStreamingSpeech(streamingContent, streamingSpeechActive);
  useAgentTurnEndSignal(isSpeakingStream, streamingSpeechActive);
  return (
    <div className={ANIMATE_IN}>
      <div className="mb-1.5 flex items-center gap-2">
        <DuckyMascot working size={20} title={t("chat.duckyWorkingTitle")} />
        <span className="text-xs font-semibold text-muted-foreground">{t("chat.roleAgent")}</span>
      </div>
      <div className={`min-w-0 text-foreground ${compactMode ? "text-[13px]" : "text-sm"} leading-relaxed`}>
        {smoothed ? (
          <>
            <MarkdownMessage content={smoothed} />
            <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-primary align-text-bottom" />
          </>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
            <span className="ml-1.5">{t("chat.workingLabel")}</span>
          </span>
        )}
      </div>
    </div>
  );
}

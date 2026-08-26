import { useEffect, useRef, useState } from "react";
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Sparkles, Square, Wrench, X, Zap, Mic } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { ToolSkillSelector, type SelectorMode } from "./ToolSkillSelector";
import { ProviderModelSelector } from "./ProviderModelSelector";

const MAX_TEXTAREA_HEIGHT = 220;

export function ChatComposer({
  draftRequest,
  onSend,
  onStop,
  isLoading,
  uploading,
  attachedFiles,
  onAttachFiles,
  onRemoveFile,
  analyzeImages,
  onToggleAnalyzeImages,
  planKind,
  onSelectPlanKind,
  conversationId,
  onInsertSkill,
  onToolExecuted,
  totalTokens,
}: {
  draftRequest?: { value: string; revision: number };
  onSend: (value: string) => Promise<boolean>;
  onStop: () => void;
  isLoading: boolean;
  uploading: boolean;
  attachedFiles: File[];
  onAttachFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  analyzeImages: boolean;
  onToggleAnalyzeImages: () => void;
  planKind: "code" | "cowork" | null;
  onSelectPlanKind: (kind: "code" | "cowork") => void;
  conversationId?: number;
  onInsertSkill: (slug: string) => void;
  onToolExecuted: (result: { toolName: string; success: boolean; data: unknown; error?: string }) => void;
  totalTokens: number;
}) {
  const { t } = useI18n();
  const chatProvider = useAppStore((state) => state.chatProvider);
  const chatModel = useAppStore((state) => state.chatModel);
  const setChatProvider = useAppStore((state) => state.setChatProvider);
  const setChatModel = useAppStore((state) => state.setChatModel);
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const [selector, setSelector] = useState<{ mode: SelectorMode; query: string } | null>(null);
  const [focused, setFocused] = useState(false);
  const [showLLMSelector, setShowLLMSelector] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const shouldSendAfterTranscribeRef = useRef(false);

  useEffect(() => {
    if (!draftRequest) return;
    setValue(draftRequest.value);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draftRequest]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    // Measuring scrollHeight forces layout. Defer it to the next animation frame so the
    // keystroke itself can paint immediately, and collapse multiple rapid input events into
    // one measurement per frame.
    const frame = requestAnimationFrame(() => {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  // Separate effect for auto-send to avoid double-sends
  useEffect(() => {
    if (shouldSendAfterTranscribeRef.current && value.trim().length > 0 && !isLoading) {
      shouldSendAfterTranscribeRef.current = false;
      void submit();
    }
  }, [value, isLoading]);

  const focusInput = () => textareaRef.current?.focus();

  const handleVoiceToggle = async () => {
    if (isListening) {
      if (recognitionRef.current) {
        const recorder = recognitionRef.current as MediaRecorder;
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
      }
      setIsListening(false);
      return;
    }

    try {
      setVoiceError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Find supported MIME types
      let mimeType = "audio/webm";
      const supportedTypes = [
        "audio/webm",
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/wav",
        "audio/ogg",
      ];
      for (const type of supportedTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          mimeType = type;
          console.log("Using MIME type:", mimeType);
          break;
        }
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      let hasData = false;

      mediaRecorder.ondataavailable = (e) => {
        console.log("Data available:", e.data.size, "bytes");
        if (e.data.size > 0) {
          hasData = true;
          chunks.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());

        try {
          setIsListening(false);
          console.log("Recording stopped. Total chunks:", chunks.length, "Has data:", hasData);

          if (!hasData || chunks.length === 0) {
            setVoiceError("Keine Sprache erkannt - bitte versuchen Sie es erneut");
            return;
          }

          const audioBlob = new Blob(chunks, { type: mimeType });
          console.log("Audio blob size:", audioBlob.size);

          if (audioBlob.size < 100) {
            setVoiceError("Zu kurze Aufnahme - bitte versuchen Sie es erneut");
            return;
          }

          setVoiceError("Transkribiere...");
          const arrayBuffer = await audioBlob.arrayBuffer();
          console.log("Sending to server, buffer size:", arrayBuffer.byteLength);

          // Convert to base64 for reliable transmission
          const base64Audio = btoa(
            String.fromCharCode.apply(null, Array.from(new Uint8Array(arrayBuffer)))
          );
          console.log("Base64 encoded size:", base64Audio.length);

          const response = await fetch("/api/chat/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audio: base64Audio, mimeType }),
          });

          if (!response.ok) {
            const error = await response.json();
            setVoiceError(error.error || "Transkription fehlgeschlagen");
            return;
          }

          const result = await response.json();
          const text = result.data?.text?.trim();
          if (text) {
            const newMessage = value + (value.trim() ? " " : "") + text;
            setValue(newMessage);
            setVoiceError(null);
            // Set flag to auto-send when value updates
            shouldSendAfterTranscribeRef.current = true;
          } else {
            setVoiceError("Keine Sprache erkannt");
          }
        } catch (err) {
          console.error("Transcription error:", err);
          setVoiceError("Transkription fehlgeschlagen");
        }
      };

      mediaRecorder.onerror = (e) => {
        stream.getTracks().forEach((track) => track.stop());
        console.error("MediaRecorder error:", e.error);
        setVoiceError(`Aufnahmefehler: ${e.error}`);
        setIsListening(false);
      };

      recognitionRef.current = mediaRecorder;
      setIsListening(true);
      console.log("Starting recording with MIME type:", mimeType);
      mediaRecorder.start();

      setTimeout(() => {
        if (recognitionRef.current === mediaRecorder && mediaRecorder.state === "recording") {
          mediaRecorder.stop();
        }
      }, 30000);
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "NotAllowedError") {
          setVoiceError("Mikrofon-Berechtigung erforderlich. Bitte Zugriff erlauben.");
        } else if (err.name === "NotFoundError") {
          setVoiceError("Kein Mikrofon verfügbar");
        } else {
          setVoiceError(err.message);
        }
      } else {
        setVoiceError("Fehler beim Starten der Sprachaufnahme");
      }
      setIsListening(false);
    }
  };

  const handleChange = (next: string) => {
    setValue(next);
    // A leading "/" is how the agent itself detects a skill request
    // (extractRequestedSkillSlugs in agent.ts) - mirror that trigger here.
    if (next.trimStart().startsWith("/") && !selector) {
      setSelector({ mode: "all", query: next.trimStart().slice(1) });
    }
  };

  const canSend = (value.trim().length > 0 || attachedFiles.length > 0) && !isLoading && !uploading;
  const submit = async () => {
    if (!canSend) return;
    if (await onSend(value)) setValue("");
  };

  return (
    <div className="relative">
      {selector && (
        <ToolSkillSelector
          query={selector.query}
          mode={selector.mode}
          conversationId={conversationId}
          onInsertSkill={(slug) => {
            onInsertSkill(slug);
            setSelector(null);
            focusInput();
          }}
          onToolExecuted={(result) => {
            onToolExecuted(result);
            setValue("");
            setSelector(null);
          }}
          onClose={() => {
            setSelector(null);
            focusInput();
          }}
        />
      )}

      {showLLMSelector && (
        <div className="mb-2 rounded-lg bg-accent/20 border border-border p-3 space-y-2">
          <p className="text-xs text-muted-foreground mb-2">
            Defaults from Settings are used if nothing is selected
          </p>

          <ProviderModelSelector
            selectedProvider={chatProvider}
            selectedModel={chatModel}
            onProviderChange={setChatProvider}
            onModelChange={setChatModel}
          />

          <div className="flex gap-2">
            <button
              onClick={() => {
                setChatProvider(undefined);
                setChatModel(undefined);
              }}
              className="flex-1 px-3 py-1.5 text-xs rounded bg-muted hover:bg-muted/80 transition-colors"
            >
              Reset
            </button>
            <button
              onClick={() => setShowLLMSelector(false)}
              className="flex-1 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {voiceError && (
        <div className="mb-2 rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive flex items-center justify-between">
          <span>{voiceError}</span>
          <button
            onClick={() => setVoiceError(null)}
            className="text-destructive/70 hover:text-destructive transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div
        onClick={focusInput}
        className={`cursor-text rounded-2xl border bg-card shadow-sm transition-colors ${
          focused ? "border-primary/60 ring-1 ring-primary/30" : "border-border hover:border-foreground/25"
        }`}
      >
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
            {attachedFiles.map((file, index) => (
              <span key={`${file.name}-${index}`} className="chip max-w-[220px] text-foreground">
                <span className="truncate">{file.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFile(index);
                  }}
                  className="shrink-0 text-muted-foreground transition hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleAnalyzeImages();
              }}
              className={`chip transition-colors ${
                analyzeImages ? "border-primary/50 bg-primary/10 text-primary" : "hover:text-foreground"
              }`}
            >
              <ImageIcon className="h-3 w-3" />
              {analyzeImages ? t("chat.imageAnalysisOn") : t("chat.imageAnalysisOff")}
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) void submit();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length > 0) {
              e.preventDefault();
              onAttachFiles(files);
            }
          }}
          placeholder={t("chat.inputPlaceholder")}
          rows={1}
          className="max-h-[220px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />

        <div className="flex items-center gap-1 px-2 pb-2 pt-1">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onAttachFiles(files);
              e.currentTarget.value = "";
            }}
          />

          <ComposerButton
            icon={<Paperclip className="h-4 w-4" />}
            label={t("chat.attachFile")}
            onClick={() => fileInputRef.current?.click()}
          />
          <ComposerButton
            icon={<Mic className="h-4 w-4" />}
            label="Spracheingabe"
            title={isListening ? "Aufnahme läuft..." : "Spracheingabe starten"}
            active={isListening}
            onClick={() => !isLoading && !uploading && handleVoiceToggle()}
          />
          <ComposerButton
            icon={<Sparkles className="h-4 w-4" />}
            label={t("chat.skills")}
            showLabel
            active={selector?.mode === "skills"}
            onClick={() => setSelector((prev) => (prev?.mode === "skills" ? null : { mode: "skills", query: "" }))}
          />
          <ComposerButton
            icon={<Wrench className="h-4 w-4" />}
            label={t("chat.tools")}
            showLabel
            active={selector?.mode === "tools"}
            onClick={() => setSelector((prev) => (prev?.mode === "tools" ? null : { mode: "tools", query: "" }))}
          />
          <ComposerButton
            icon={<span className="text-xs font-bold leading-none">◇</span>}
            label={t("chat.codePlan")}
            title={t("chat.codePlanHint")}
            showLabel
            active={planKind === "code"}
            onClick={() => onSelectPlanKind("code")}
          />
          <ComposerButton
            icon={<span className="text-xs font-bold leading-none">◈</span>}
            label={t("chat.coworkPlan")}
            title={t("chat.coworkPlanHint")}
            showLabel
            active={planKind === "cowork"}
            onClick={() => onSelectPlanKind("cowork")}
          />
          <ComposerButton
            icon={<Zap className="h-4 w-4" />}
            label="LLM"
            title="LLM Provider und Model auswählen"
            showLabel
            active={showLLMSelector}
            onClick={() => setShowLLMSelector(!showLLMSelector)}
          />

          <div className="ml-auto flex items-center gap-2 pr-1">
            {totalTokens > 0 && (
              <span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline" title={t("chat.tokensUsed")}>
                ⚡ {totalTokens.toLocaleString()}
              </span>
            )}
            {isLoading ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onStop();
                }}
                title={t("chat.stop")}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-80"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void submit();
                }}
                disabled={!canSend}
                title={t("chat.send")}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="mt-1.5 text-center text-[10px] text-muted-foreground/70">{t("chat.composerHint")}</p>
    </div>
  );
}

function ComposerButton({
  icon,
  label,
  title,
  showLabel = false,
  active = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  showLabel?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-primary/15 text-primary ring-1 ring-primary/40"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {icon}
      {showLabel && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}

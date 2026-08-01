import { useEffect, useRef, useState } from "react";
import { ArrowUp, Image as ImageIcon, Loader2, Paperclip, Sparkles, Square, Wrench, X, Zap } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { useAppStore } from "../../lib/store";
import { ToolSkillSelector, type SelectorMode } from "./ToolSkillSelector";

const MAX_TEXTAREA_HEIGHT = 220;

export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  uploading,
  attachedFiles,
  onAttachFiles,
  onRemoveFile,
  analyzeImages,
  onToggleAnalyzeImages,
  planMode,
  onTogglePlanMode,
  conversationId,
  onInsertSkill,
  onToolExecuted,
  totalTokens,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isLoading: boolean;
  uploading: boolean;
  attachedFiles: File[];
  onAttachFiles: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  analyzeImages: boolean;
  onToggleAnalyzeImages: () => void;
  planMode: boolean;
  onTogglePlanMode: () => void;
  conversationId?: number;
  onInsertSkill: (slug: string) => void;
  onToolExecuted: (result: { toolName: string; success: boolean; data: unknown; error?: string }) => void;
  totalTokens: number;
}) {
  const { t } = useI18n();
  const { chatProvider, chatModel, setChatProvider, setChatModel } = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selector, setSelector] = useState<{ mode: SelectorMode; query: string } | null>(null);
  const [focused, setFocused] = useState(false);
  const [showLLMSelector, setShowLLMSelector] = useState(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const focusInput = () => textareaRef.current?.focus();

  const handleChange = (next: string) => {
    onChange(next);
    // A leading "/" is how the agent itself detects a skill request
    // (extractRequestedSkillSlugs in agent.ts) - mirror that trigger here.
    if (next.trimStart().startsWith("/") && !selector) {
      setSelector({ mode: "all", query: next.trimStart().slice(1) });
    }
  };

  const canSend = (value.trim().length > 0 || attachedFiles.length > 0) && !isLoading && !uploading;

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
            Standardwerte aus Settings werden genutzt wenn nichts gewählt ist
          </p>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Provider {!chatProvider && "(Standard aus Settings)"}
            </label>
            <select
              value={chatProvider || ""}
              onChange={(e) => setChatProvider(e.target.value || undefined)}
              className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Standard aus Settings</option>
              <option value="lmstudio">LM Studio (lokal)</option>
              <option value="openai">OpenAI</option>
              <option value="openrouter">OpenRouter</option>
              <option value="claude">Claude (Anthropic)</option>
              <option value="ollama">Ollama (lokal)</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Model {!chatModel && "(Standard aus Settings)"}
            </label>
            <select
              value={chatModel || ""}
              onChange={(e) => setChatModel(e.target.value || undefined)}
              className="w-full px-3 py-1.5 rounded border border-border bg-background text-sm hover:border-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Standard aus Settings</option>
              {chatProvider === "lmstudio" && (
                <option value="custom">Von LM Studio API</option>
              )}
              {chatProvider === "openai" && (
                <>
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4-turbo">GPT-4 Turbo</option>
                  <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                </>
              )}
              {chatProvider === "claude" && (
                <>
                  <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                  <option value="claude-3-opus-20250219">Claude 3 Opus</option>
                  <option value="claude-3-haiku-20250307">Claude 3 Haiku</option>
                </>
              )}
              {chatProvider === "openrouter" && (
                <option value="auto">Auto (OpenRouter)</option>
              )}
            </select>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => {
                setChatProvider(undefined);
                setChatModel(undefined);
              }}
              className="flex-1 px-3 py-1.5 text-xs rounded bg-muted hover:bg-muted/80 transition-colors"
            >
              Zurücksetzen
            </button>
            <button
              onClick={() => setShowLLMSelector(false)}
              className="flex-1 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Fertig
            </button>
          </div>
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
              if (canSend) onSend();
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
            label={t("chat.planMode")}
            title={t("chat.planModeHint")}
            showLabel
            active={planMode}
            onClick={onTogglePlanMode}
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
                  onSend();
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

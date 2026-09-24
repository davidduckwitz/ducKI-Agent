import { Volume2 } from "lucide-react";
import { useAppStore } from "../../lib/store";
import { stripMarkdownForSpeech } from "../../lib/stripMarkdownForSpeech";
import { useSpeechSynthesis } from "../../hooks/useSpeechSynthesis";
import { useVoiceSettings } from "../../hooks/useVoiceSettings";

/**
 * Shows the agent's current/last reply as a floating bubble under the orb - a visible fallback
 * and companion to the spoken TTS output, reading the same global store ChatContainer's
 * MessageRow/StreamingRow already use (no separate data path, so it can never drift out of
 * sync with what's actually happening in the hidden transcript).
 *
 * Clickable to replay: useful both for "I missed that" and because it's the same manual-replay
 * mechanism as the Chat page's per-message play button (VoicePlayback.tsx) - see
 * useSpeechSynthesis's speak(), which now pre-splits long text (splitForSpeech.ts) so replaying
 * a long reply doesn't hit a TTS provider's per-request size limit in one oversized call.
 */
export function ReplyBubble() {
  const streamingContent = useAppStore((s) => s.streamingContent);
  const messages = useAppStore((s) => s.messages);
  const isLoading = useAppStore((s) => s.isLoading);
  const { speak } = useSpeechSynthesis();
  const { ttsStripMarkdown } = useVoiceSettings();

  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const liveText = streamingContent.trim();
  const text = liveText || lastAssistantMessage?.content?.trim() || "";

  if (!text && !isLoading) return null;

  return (
    <button
      type="button"
      onClick={() => text && speak(ttsStripMarkdown ? stripMarkdownForSpeech(text) : text)}
      disabled={!text}
      title={text ? "Erneut vorlesen" : undefined}
      className="group max-w-md rounded-2xl border border-white/10 bg-slate-900/70 px-4 py-3 text-left text-sm leading-relaxed text-slate-100 shadow-2xl backdrop-blur-md transition hover:border-indigo-400/40 disabled:cursor-default"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 max-h-32 overflow-y-auto">{text ? stripMarkdownForSpeech(text) : <span className="text-slate-400">…</span>}</span>
        {text && (
          <Volume2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500 opacity-0 transition group-hover:opacity-100" />
        )}
      </span>
    </button>
  );
}

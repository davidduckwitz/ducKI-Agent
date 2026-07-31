import { BookOpen, Code2, ListChecks, Search } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import { DynamicCharacter } from "./characters/DynamicCharacter";

/** Prompts are translated; the icon/accent stays fixed per slot. */
const SUGGESTIONS = [
  { key: "plan", icon: ListChecks, tone: "text-primary" },
  { key: "code", icon: Code2, tone: "text-emerald-500" },
  { key: "research", icon: Search, tone: "text-amber-500" },
  { key: "skills", icon: BookOpen, tone: "text-violet-500" },
] as const;

export function ChatWelcome({
  characterId,
  characterCustomizations,
  onPick,
}: {
  characterId: string;
  characterCustomizations: Record<string, unknown>;
  onPick: (prompt: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-10">
      <DynamicCharacter isWorking={false} size={64} characterId={characterId} customConfig={characterCustomizations} />
      <h2 className="mt-4 text-center text-xl font-semibold md:text-2xl">{t("chat.welcomeTitle")}</h2>
      <p className="mt-1 max-w-md text-center text-sm text-muted-foreground">{t("chat.welcomeHint")}</p>

      <div className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(({ key, icon: Icon, tone }) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(t(`chat.suggestions.${key}.prompt`))}
            className="group flex items-start gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left transition hover:border-foreground/25 hover:bg-accent"
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{t(`chat.suggestions.${key}.title`)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {t(`chat.suggestions.${key}.prompt`)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

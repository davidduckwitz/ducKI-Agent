import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";
import { Zap, Minimize2, Grid3x3 } from "lucide-react";
import { MatrixDuck } from "../chat/MatrixDuck";

export function AnimationSettings() {
  const { t } = useI18n();
  const { animationStyle, setAnimationStyle } = useAppStore();
  const animationOptions = [
    {
      id: "matrix" as const,
      label: "Matrix",
      description: "Green falling characters with laptop animation",
      icon: Grid3x3,
    },
    {
      id: "neon" as const,
      label: "Neon",
      description: "Glowing neon border effect",
      icon: Zap,
    },
    {
      id: "minimal" as const,
      label: "Minimal",
      description: "Simple and clean design",
      icon: Minimize2,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-background/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Working-State Darstellung</h3>
            <p className="mt-1 text-xs text-muted-foreground">So erscheint DucKI während der Arbeit im Chat. Die Pet-Gallery oben steuert den Desk Pet unabhängig davon.</p>
          </div>
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-2"><MatrixDuck isWorking size={76} /></div>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          ✨ {t("settings.duckaAnimation") || "Animation Style"}
        </h3>
        <p className="text-xs text-gray-400 mb-3">
          {t("settings.chooseAnimationStyle") || "Choose your preferred animation style for the working duck"}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {animationOptions.map(({ id, label, description, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setAnimationStyle(id)}
              className={`p-3 rounded-lg border-2 transition text-left ${
                animationStyle === id
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4" />
                <span className="text-sm font-medium">{label}</span>
              </div>
              <p className="text-xs text-gray-400">{description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <p className="text-xs text-muted-foreground">{t("settings.preview") || "Preview"}</p>
        <p className="mt-1 text-sm">{animationOptions.find((option) => option.id === animationStyle)?.description}</p>
      </div>
    </div>
  );
}

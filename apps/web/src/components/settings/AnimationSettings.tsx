import { useState } from "react";
import { useAppStore } from "../../lib/store";
import { useI18n } from "../../lib/i18n";
import { Zap, Minimize2, Grid3x3, Palette } from "lucide-react";
import { CharacterSelector } from "../chat/characters/CharacterSelector";
import { CharacterCustomizer } from "../chat/characters/CharacterCustomizer";
import { characterRegistry } from "../chat/characters/CharacterRegistry";
import { PetSettingsPanel } from "./PetSettingsPanel";

export function AnimationSettings() {
  const { t } = useI18n();
  const { animationStyle, setAnimationStyle, selectedCharacterId, setSelectedCharacterId, characterCustomizations, updateCharacterCustomization } = useAppStore();
  const [showCharacterSelector, setShowCharacterSelector] = useState(false);
  const [showCustomizer, setShowCustomizer] = useState(false);

  const currentCharacter = characterRegistry.getCharacter(selectedCharacterId);

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
      {/* Desk Pet */}
      <PetSettingsPanel />

      {/* Character Selection */}
      <div className="bg-gray-900/30 rounded-lg border border-gray-800 p-4">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          🎨 {t("settings.character") || "Character"}
        </h3>

        <div className="space-y-3">
          {/* Current Character Display */}
          <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700/50">
            <p className="text-xs text-gray-400 mb-2">Current Character:</p>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{currentCharacter?.name || "Unknown"}</p>
                <p className="text-xs text-gray-400">{currentCharacter?.description}</p>
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setShowCharacterSelector(true)}
              className="btn-secondary text-sm py-2"
            >
              🖼️ Gallery
            </button>
            <button
              onClick={() => setShowCustomizer(!showCustomizer)}
              className={`btn-secondary text-sm py-2 ${showCustomizer ? "bg-purple-500/20 border-purple-500/50" : ""}`}
            >
              <Palette className="w-3 h-3 inline mr-1" />
              Customize
            </button>
          </div>
        </div>

        {/* Customizer (if expanded) */}
        {showCustomizer && (
          <div className="mt-4 pt-4 border-t border-gray-700">
            <CharacterCustomizer
              characterId={selectedCharacterId}
              customizations={characterCustomizations}
              onCustomizationChange={updateCharacterCustomization}
            />
          </div>
        )}
      </div>

      {/* Classic Animation Styles */}
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

      {/* Preview of current animation */}
      <div className="mt-4 p-3 rounded-lg bg-gray-800/30 border border-gray-700">
        <p className="text-xs text-gray-400 mb-2">{t("settings.preview") || "Preview"}:</p>
        <div className="flex justify-center p-4">
          <div className="text-4xl animate-bounce">🦆</div>
        </div>
        <p className="text-xs text-gray-400 text-center">
          {animationOptions.find(o => o.id === animationStyle)?.description}
        </p>
      </div>

      {/* Character Selector Modal */}
      {showCharacterSelector && (
        <CharacterSelector
          selectedId={selectedCharacterId}
          onSelect={setSelectedCharacterId}
          onClose={() => setShowCharacterSelector(false)}
        />
      )}
    </div>
  );
}

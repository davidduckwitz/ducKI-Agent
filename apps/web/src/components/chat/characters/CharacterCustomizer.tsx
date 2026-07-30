/**
 * Character Customizer
 * Customize character appearance and behavior (size, color, speed, opacity)
 */

import React, { useMemo } from "react";
import { Palette, Sliders } from "lucide-react";
import { characterRegistry } from "./CharacterRegistry";
import { DynamicCharacter } from "./DynamicCharacter";
import type { CharacterDefinition } from "./types";

interface CharacterCustomizerProps {
  characterId: string;
  customizations: Record<string, unknown>;
  onCustomizationChange: (key: string, value: unknown) => void;
}

export function CharacterCustomizer({
  characterId,
  customizations,
  onCustomizationChange,
}: CharacterCustomizerProps) {
  const character = characterRegistry.getCharacter(characterId);
  const customizable = character?.metadata?.customizable || [];

  const previewCustomizations = useMemo(
    () => ({
      ...customizations,
    }),
    [customizations]
  );

  if (!character || customizable.length === 0) {
    return null;
  }

  const size = (customizations.size as number) ?? character.metadata?.size ?? 80;
  const speed = (customizations.speed as number) ?? 1;
  const opacity = (customizations.opacity as number) ?? 1;
  const color = (customizations.color as string) ?? character.metadata?.color ?? "#00ff00";

  return (
    <div className="space-y-4">
      <div className="bg-gray-900/50 rounded-lg border border-gray-800 p-4">
        <h3 className="flex items-center gap-2 font-semibold mb-4 text-sm">
          <Sliders className="w-4 h-4" />
          Customization
        </h3>

        <div className="space-y-4">
          {/* Size Slider */}
          {customizable.includes("size") && (
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-2">
                Size: {size}px
              </label>
              <input
                type="range"
                min="40"
                max="200"
                step="10"
                value={size}
                onChange={(e) => onCustomizationChange("size", Number(e.target.value))}
                className="w-full h-2 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>Small</span>
                <span>Large</span>
              </div>
            </div>
          )}

          {/* Speed Slider */}
          {customizable.includes("speed") && (
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-2">
                Speed: {speed.toFixed(1)}x
              </label>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={speed}
                onChange={(e) => onCustomizationChange("speed", Number(e.target.value))}
                className="w-full h-2 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-green-500"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>Slow</span>
                <span>Fast</span>
              </div>
            </div>
          )}

          {/* Opacity Slider */}
          {customizable.includes("opacity") && (
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-2">
                Opacity: {Math.round(opacity * 100)}%
              </label>
              <input
                type="range"
                min="0.2"
                max="1"
                step="0.05"
                value={opacity}
                onChange={(e) => onCustomizationChange("opacity", Number(e.target.value))}
                className="w-full h-2 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>Transparent</span>
                <span>Opaque</span>
              </div>
            </div>
          )}

          {/* Color Picker */}
          {customizable.includes("color") && (
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-2">
                <Palette className="w-3 h-3 inline mr-1" />
                Color
              </label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => onCustomizationChange("color", e.target.value)}
                  className="w-12 h-10 rounded-lg cursor-pointer border border-gray-700"
                />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => onCustomizationChange("color", e.target.value)}
                  className="input flex-1 text-xs font-mono"
                  placeholder="#00ff00"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live Preview */}
      <div className="bg-gray-900/50 rounded-lg border border-gray-800 p-4">
        <h3 className="font-semibold mb-3 text-sm">Live Preview</h3>
        <div className="flex items-center justify-center bg-black/50 rounded-lg p-6 min-h-[140px]">
          <div style={{ opacity: opacity }}>
            <DynamicCharacter
              characterId={characterId}
              isWorking={true}
              size={size}
              customConfig={previewCustomizations}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 text-center mt-2">Updates in real-time as you customize</p>
      </div>

      {/* Reset Button */}
      <button
        onClick={() => {
          // Reset to defaults
          customizable.forEach((key) => {
            onCustomizationChange(key, undefined);
          });
        }}
        className="w-full btn-secondary text-sm py-2"
      >
        Reset to Defaults
      </button>
    </div>
  );
}

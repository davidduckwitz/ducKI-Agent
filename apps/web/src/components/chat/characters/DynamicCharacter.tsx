/**
 * Dynamic Character Renderer
 * Loads and renders the selected character with customizations
 * Falls back to Matrix Duck if character not found
 */

import React, { useMemo } from "react";
import { characterRegistry } from "./CharacterRegistry";
import { MatrixDuck } from "../MatrixDuck";
import type { CharacterProps } from "./types";

interface DynamicCharacterProps extends CharacterProps {
  characterId?: string;
}

export function DynamicCharacter({
  characterId = "duck-matrix",
  isWorking,
  size = 80,
  theme = "dark",
  speed,
  customConfig,
}: DynamicCharacterProps): React.ReactElement {
  // Get character definition and component
  const character = characterRegistry.getCharacter(characterId);
  const Component = characterRegistry.getComponent(characterId);

  // Fallback to Matrix Duck if character not found
  const renderedComponent = useMemo(() => {
    if (Component) {
      return (
        <Component
          isWorking={isWorking}
          size={size}
          theme={theme}
          speed={speed}
          customConfig={customConfig}
        />
      );
    }

    // Fallback to Matrix Duck
    console.warn(`Character not found: ${characterId}, falling back to Matrix Duck`);
    return <MatrixDuck isWorking={isWorking} size={size} />;
  }, [Component, characterId, isWorking, size, theme, speed, customConfig]);

  return renderedComponent;
}

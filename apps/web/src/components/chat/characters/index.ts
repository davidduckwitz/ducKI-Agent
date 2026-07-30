/**
 * Character System Initialization
 * Registers built-in characters on app startup
 */

import { characterRegistry } from "./CharacterRegistry";
import { MatrixDuck } from "../MatrixDuck";
import type { CharacterPackage } from "./types";

// Built-in Matrix Duck package
const matrixDuckPackage: CharacterPackage = {
  id: "built-in-matrix-duck",
  name: "Matrix Duck",
  version: "1.0.0",
  author: "DucKI",
  description: "Animated Matrix-style duck with falling characters",
  characters: [
    {
      id: "duck-matrix",
      name: "Matrix Duck",
      description: "Green falling characters animation",
      type: "component",
      author: "DucKI",
      version: "1.0.0",
      animations: [
        {
          id: "working",
          name: "Working",
          description: "Shows activity with animated falling characters",
          isWorking: true,
        },
        {
          id: "idle",
          name: "Idle",
          description: "Calm waiting state",
          isIdle: true,
        },
      ],
      metadata: {
        size: 80,
        color: "#00ff00",
        supportsDarkMode: true,
        customizable: ["size", "speed"],
      },
    },
  ],
  metadata: {
    tags: ["builtin", "matrix", "animated"],
    license: "MIT",
  },
};

/**
 * Initialize the character system
 * Call this once on app startup
 */
export function initializeCharacterSystem(): void {
  characterRegistry.registerPackage(matrixDuckPackage, {
    "duck-matrix": MatrixDuck,
  });
}

export { characterRegistry } from "./CharacterRegistry";
export { DynamicCharacter } from "./DynamicCharacter";
export { CharacterSelector } from "./CharacterSelector";
export { CharacterCustomizer } from "./CharacterCustomizer";
export type { CharacterProps, CharacterDefinition, CharacterPackage, CharacterSettings } from "./types";

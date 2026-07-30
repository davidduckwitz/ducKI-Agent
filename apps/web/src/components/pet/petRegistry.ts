/**
 * Pet Registry
 *
 * Holds the pets that ship with the app and merges in the sprite-sheet pets the
 * user imported (those live in the persisted pet store, not here).
 */

import type { PetDefinition, PetStateId, SpriteStateConfig, SpriteSheetConfig } from "./petTypes";
import { PET_STATE_FALLBACK } from "./petTypes";

export const BUILT_IN_PETS: PetDefinition[] = [
  {
    id: "ducki",
    name: "Ducki",
    description: "Die Haus-Ente - watschelt am Boden und flattert wenn der Agent arbeitet",
    emoji: "🦆",
    locomotion: "ground",
    kind: "vector",
    species: "duck",
    palette: { primary: "#FFCE31", secondary: "#F2B705", accent: "#FF8A1E", eye: "#22303C" },
    builtIn: true,
    author: "DucKI",
  },
  {
    id: "cat",
    name: "Pixel Cat",
    description: "Laeuft an der Fensterkante entlang, schlaeft ein wenn nichts passiert",
    emoji: "🐱",
    locomotion: "ground",
    kind: "vector",
    species: "cat",
    palette: { primary: "#F59E4B", secondary: "#E07C2C", accent: "#FFF3E0", eye: "#1F2937" },
    builtIn: true,
    author: "DucKI",
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Schwebt frei durch das Fenster und folgt dem Mauszeiger",
    emoji: "👻",
    locomotion: "air",
    kind: "vector",
    species: "ghost",
    palette: { primary: "#E5E7FF", secondary: "#B8BEE8", accent: "#8B93D6", eye: "#2A2E4A" },
    builtIn: true,
    author: "DucKI",
  },
  {
    id: "drone",
    name: "Helper Bot",
    description: "Kleine Drohne mit Rotor - schwebt und blinkt im Takt der Agent-Events",
    emoji: "🤖",
    locomotion: "air",
    kind: "vector",
    species: "drone",
    palette: { primary: "#8FA3BF", secondary: "#5A6B84", accent: "#38BDF8", eye: "#0F172A" },
    builtIn: true,
    author: "DucKI",
  },
];

export const DEFAULT_PET_ID = "ducki";

export function getPetById(id: string, customPets: PetDefinition[] = []): PetDefinition {
  return (
    BUILT_IN_PETS.find((p) => p.id === id) ??
    customPets.find((p) => p.id === id) ??
    (BUILT_IN_PETS[0] as PetDefinition)
  );
}

export function getAllPets(customPets: PetDefinition[] = []): PetDefinition[] {
  return [...BUILT_IN_PETS, ...customPets];
}

/**
 * Resolves the sheet row to play for a state, following the fallback chain so a
 * sheet that only maps "idle" and "walk" still renders every engine state.
 */
export function resolveSpriteState(
  sheet: SpriteSheetConfig,
  state: PetStateId
): SpriteStateConfig | undefined {
  const direct = sheet.states[state];
  if (direct) return direct;

  for (const fallback of PET_STATE_FALLBACK[state]) {
    const candidate = sheet.states[fallback];
    if (candidate) return candidate;
  }

  // Last resort: whatever the sheet does define, so the pet is never invisible.
  const first = Object.values(sheet.states).find(Boolean);
  return first;
}

/**
 * Default row mapping suggested when importing a new sheet. It matches the common
 * "one state per row" layout (idle, run right, run left, wave, jump, ...).
 */
export const SPRITE_IMPORT_DEFAULT_ORDER: PetStateId[] = [
  "idle",
  "walk",
  "run",
  "wave",
  "jump",
  "fail",
  "sleep",
  "work",
  "fly",
];

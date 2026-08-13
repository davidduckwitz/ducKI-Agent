/**
 * Pet System Types
 *
 * A "pet" is a small creature that lives on top of the whole app window: it walks
 * (or flies) around, reacts to the agent's activity and to the mouse, and can be
 * dragged anywhere. Pets are either drawn as vector (SVG + CSS) creatures that ship
 * with the app, or rendered from a user-imported sprite sheet.
 */

/** Every visual state the engine can ask a pet to show. */
export const PET_STATES = [
  "idle",
  "walk",
  "run",
  "fly",
  "drag",
  "fall",
  "sleep",
  "wave",
  "jump",
  "work",
  "fail",
] as const;

export type PetStateId = (typeof PET_STATES)[number];

/**
 * When a sprite sheet has no row for a state, the renderer walks down this chain
 * until it finds one that is mapped, so partially mapped sheets still animate.
 */
export const PET_STATE_FALLBACK: Record<PetStateId, PetStateId[]> = {
  idle: [],
  walk: ["idle"],
  run: ["walk", "idle"],
  fly: ["run", "walk", "idle"],
  drag: ["jump", "idle"],
  fall: ["jump", "idle"],
  sleep: ["idle"],
  wave: ["idle"],
  jump: ["idle"],
  work: ["walk", "idle"],
  fail: ["idle"],
};

export interface SpriteStateConfig {
  /** Zero-based row of the sheet holding this state's frames. */
  row: number;
  /** Number of frames in that row (starting at column 0). */
  frames: number;
  /** Frames per second; falls back to the sheet's fps. */
  fps?: number;
  /** false = play once and hold the last frame (used for jump/wave). */
  loop?: boolean;
  /** Optional dedicated row for the left-facing variant; otherwise the sprite is mirrored. */
  rowLeft?: number;
}

export interface SpriteSheetConfig {
  /** Image source - a data URL for imported sheets, or a path for bundled ones. */
  src: string;
  frameWidth: number;
  frameHeight: number;
  /** Default playback speed for states without their own fps. */
  fps: number;
  /** Natural sheet size, kept so the settings UI can show the grid without reloading. */
  sheetWidth?: number;
  sheetHeight?: number;
  states: Partial<Record<PetStateId, SpriteStateConfig>>;
}

/** Ground pets obey gravity and walk on the floor; air pets hover freely. */
export type PetLocomotion = "ground" | "air";

export type VectorSpecies = "duck" | "cat" | "ghost" | "drone";

export interface PetPalette {
  primary: string;
  secondary: string;
  accent: string;
  eye: string;
}

export interface PetDefinition {
  id: string;
  name: string;
  description?: string;
  /** Small glyph used in compact lists and menus. */
  emoji: string;
  locomotion: PetLocomotion;
  kind: "vector" | "sprite" | "svg" | "matrix";
  /** Which built-in SVG creature to draw (kind === "vector"). */
  species?: VectorSpecies;
  palette?: PetPalette;
  /** Sheet definition (kind === "sprite"). */
  sheet?: SpriteSheetConfig;
  /** Inline SVG inner markup for kind === "svg" (plugin-provided pets), drawn in a 0 0 64 64 box. */
  art?: string;
  builtIn?: boolean;
  author?: string;
  /** Where the pet came from - "plugin" pets are contributed by an enabled plugin. */
  source?: "builtin" | "plugin" | "custom";
}

/** A one-shot instruction from the settings UI to the running pet (e.g. "wave now"). */
export interface PetCommand {
  /** Incremented on every trigger so the layer can react to repeats of the same action. */
  nonce: number;
  action: PetStateId | "reset";
}

export interface PetPosition {
  x: number;
  y: number;
}

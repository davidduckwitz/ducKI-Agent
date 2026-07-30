/**
 * Pet renderer
 *
 * Turns a pet definition + engine state into pixels: either one of the built-in
 * SVG creatures or a frame out of an imported sprite sheet. Used both by the live
 * overlay and by the previews in the settings panel.
 */

import { useEffect, useMemo, useState } from "react";
import { resolveSpriteState } from "./petRegistry";
import { VectorPet } from "./VectorPet";
import type { PetDefinition, PetStateId, SpriteSheetConfig } from "./petTypes";

interface SpritePetProps {
  sheet: SpriteSheetConfig;
  state: PetStateId;
  facing?: 1 | -1;
  /** Rendered height in px; the width follows the sheet's aspect ratio. */
  size: number;
  /** false freezes on the first frame (used for static thumbnails). */
  animate?: boolean;
}

export function SpritePet({ sheet, state, facing = 1, size, animate = true }: SpritePetProps) {
  const config = resolveSpriteState(sheet, state);
  const [frame, setFrame] = useState(0);

  const frames = config?.frames ?? 1;
  const fps = config?.fps ?? sheet.fps ?? 8;
  const loop = config?.loop !== false;

  // Restart the animation whenever the state (and therefore the row) changes.
  useEffect(() => {
    setFrame(0);
  }, [config?.row, frames]);

  useEffect(() => {
    if (!animate || frames <= 1) return;
    const interval = window.setInterval(() => {
      setFrame((current) => {
        const next = current + 1;
        if (next >= frames) return loop ? 0 : frames - 1;
        return next;
      });
    }, Math.max(40, 1000 / Math.max(1, fps)));
    return () => window.clearInterval(interval);
  }, [animate, frames, fps, loop]);

  if (!config) return null;

  // A sheet may carry a dedicated left-facing row; otherwise the frame is mirrored.
  const mirrored = facing === -1 && config.rowLeft === undefined;
  const row = facing === -1 && config.rowLeft !== undefined ? config.rowLeft : config.row;
  const scale = size / sheet.frameHeight;
  const safeFrame = Math.min(frame, Math.max(0, frames - 1));

  return (
    <div
      className="pet-sprite-frame"
      data-facing={mirrored ? -1 : 1}
      style={{ width: sheet.frameWidth * scale, height: sheet.frameHeight * scale }}
    >
      <div
        className="pet-sprite"
        style={{
          width: sheet.frameWidth,
          height: sheet.frameHeight,
          backgroundImage: `url(${sheet.src})`,
          backgroundPosition: `${-safeFrame * sheet.frameWidth}px ${-row * sheet.frameHeight}px`,
          transform: `scale(${scale})`,
        }}
      />
    </div>
  );
}

interface PetViewProps {
  pet: PetDefinition;
  state: PetStateId;
  facing?: 1 | -1;
  size: number;
  animate?: boolean;
}

export function PetView({ pet, state, facing = 1, size, animate = true }: PetViewProps) {
  const palette = useMemo(
    () =>
      pet.palette ?? {
        primary: "#FFCE31",
        secondary: "#F2B705",
        accent: "#FF8A1E",
        eye: "#22303C",
      },
    [pet.palette]
  );

  if (pet.kind === "sprite" && pet.sheet) {
    return <SpritePet sheet={pet.sheet} state={state} facing={facing} size={size} animate={animate} />;
  }

  return (
    <VectorPet
      species={pet.species ?? "duck"}
      palette={palette}
      state={animate ? state : "idle"}
      facing={facing}
      size={size}
    />
  );
}

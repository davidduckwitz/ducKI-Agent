/**
 * Vector pets
 *
 * The built-in creatures, drawn as SVG in a 64x64 box with the floor at y=58.
 * Motion comes entirely from pet.css via the `data-state` attribute, so a species
 * only has to name its parts (.pet-body, .pet-leg-front, .pet-wing, ...).
 */

import type { PetPalette, PetStateId, VectorSpecies } from "./petTypes";

interface VectorPetProps {
  species: VectorSpecies;
  palette: PetPalette;
  state: PetStateId;
  facing: 1 | -1;
  size: number;
}

const FALLBACK_PALETTE: PetPalette = {
  primary: "#FFCE31",
  secondary: "#F2B705",
  accent: "#FF8A1E",
  eye: "#22303C",
};

export function VectorPet({ species, palette, state, facing, size }: VectorPetProps) {
  const colors = palette ?? FALLBACK_PALETTE;

  return (
    <svg
      className="pet-svg"
      data-state={state}
      data-facing={facing}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      {species === "duck" && <DuckArt c={colors} />}
      {species === "cat" && <CatArt c={colors} />}
      {species === "ghost" && <GhostArt c={colors} />}
      {species === "drone" && <DroneArt c={colors} />}
    </svg>
  );
}

interface ArtProps {
  c: PetPalette;
}

function Zzz({ x, y }: { x: number; y: number }) {
  return (
    <g className="pet-zzz">
      <text x={x} y={y} fontSize="10" fontWeight="700" fill="#9CA3AF" fontFamily="sans-serif">
        z
      </text>
    </g>
  );
}

function DuckArt({ c }: ArtProps) {
  return (
    <>
      <ellipse className="pet-shadow" cx="31" cy="59" rx="15" ry="2.6" fill="#000" />

      <g className="pet-leg-back">
        <path d="M25 45 L24 56" stroke={c.accent} strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path d="M20 57 L28 57" stroke={c.accent} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>
      <g className="pet-leg-front">
        <path d="M35 45 L36 56" stroke={c.accent} strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <path d="M32 57 L40 57" stroke={c.accent} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      </g>

      <g className="pet-body">
        <path d="M12 36 Q3 33 5 43 Q10 45 16 40 Z" fill={c.secondary} />
        <ellipse cx="29" cy="38" rx="17" ry="12.5" fill={c.primary} />
        <g className="pet-wing">
          <path d="M25 29 Q39 26 38 41 Q29 43 22 37 Z" fill={c.secondary} />
        </g>
        <circle cx="43" cy="21" r="10.5" fill={c.primary} />
        <path d="M51 18 L62 22 L51 26 Z" fill={c.accent} />
        <g className="pet-eye-open">
          <circle cx="46" cy="18" r="2.2" fill={c.eye} />
          <circle cx="46.8" cy="17.2" r="0.8" fill="#fff" />
        </g>
        <path className="pet-eye-closed" d="M43 18 Q46 21 49 18" stroke={c.eye} strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <Zzz x={52} y={10} />
      </g>
    </>
  );
}

function CatArt({ c }: ArtProps) {
  return (
    <>
      <ellipse className="pet-shadow" cx="31" cy="59" rx="16" ry="2.6" fill="#000" />

      <path
        className="pet-tail"
        d="M14 42 Q3 42 5 30 Q6 25 10 25"
        stroke={c.secondary}
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />

      <g className="pet-leg-back">
        <path d="M22 47 L21 56" stroke={c.secondary} strokeWidth="4.5" strokeLinecap="round" fill="none" />
      </g>
      <g className="pet-leg-front">
        <path d="M37 47 L38 56" stroke={c.primary} strokeWidth="4.5" strokeLinecap="round" fill="none" />
      </g>

      <g className="pet-body">
        <ellipse cx="28" cy="41" rx="16" ry="11" fill={c.primary} />
        <path d="M18 34 Q24 31 30 34" stroke={c.secondary} strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M20 39 Q26 36 32 39" stroke={c.secondary} strokeWidth="2" fill="none" strokeLinecap="round" />

        <g className="pet-arm">
          <ellipse cx="41" cy="47" rx="4.5" ry="3.5" fill={c.accent} />
        </g>

        <path d="M36 20 L34 10 L43 15 Z" fill={c.primary} />
        <path d="M37 19 L36 13 L41.5 16 Z" fill={c.accent} />
        <path d="M50 19 L54 10 L56 20 Z" fill={c.primary} />
        <path d="M51 18 L53.5 13 L54.5 19 Z" fill={c.accent} />
        <circle cx="45" cy="26" r="11" fill={c.primary} />

        <g className="pet-eye-open">
          <ellipse cx="41.5" cy="24.5" rx="2" ry="2.6" fill={c.eye} />
          <ellipse cx="50.5" cy="24.5" rx="2" ry="2.6" fill={c.eye} />
          <circle cx="42.2" cy="23.6" r="0.7" fill="#fff" />
          <circle cx="51.2" cy="23.6" r="0.7" fill="#fff" />
        </g>
        <g className="pet-eye-closed">
          <path d="M39 25 Q41.5 27.5 44 25" stroke={c.eye} strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M48 25 Q50.5 27.5 53 25" stroke={c.eye} strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </g>

        <ellipse cx="46" cy="30.5" rx="5" ry="3.5" fill={c.accent} />
        <path d="M46 29 L44.5 30.5 L47.5 30.5 Z" fill={c.eye} />
        <path d="M46 31 L46 33" stroke={c.eye} strokeWidth="1" strokeLinecap="round" />
        <path d="M52 28 L58 27 M52 30 L58 31" stroke={c.eye} strokeWidth="0.8" strokeLinecap="round" opacity="0.6" />

        <Zzz x={56} y={12} />
      </g>
    </>
  );
}

function GhostArt({ c }: ArtProps) {
  return (
    <>
      <ellipse className="pet-shadow" cx="32" cy="59" rx="12" ry="2.2" fill="#000" />

      <g className="pet-body">
        <path
          d="M32 6 C18 6 12 17 12 28 L12 48 Q16 44 20 48 Q24 52 28 48 Q32 44 36 48 Q40 52 44 48 Q48 44 52 48 L52 28 C52 17 46 6 32 6 Z"
          fill={c.primary}
          opacity="0.94"
        />
        <path
          d="M32 6 C18 6 12 17 12 28 L12 40 Q22 34 32 34 Q42 34 52 40 L52 28 C52 17 46 6 32 6 Z"
          fill={c.secondary}
          opacity="0.35"
        />

        <g className="pet-arm">
          <ellipse cx="12" cy="32" rx="5" ry="4" fill={c.primary} />
        </g>
        <g className="pet-wing">
          <ellipse cx="52" cy="32" rx="5" ry="4" fill={c.primary} />
        </g>

        <g className="pet-eye-open">
          <ellipse cx="25" cy="26" rx="3.2" ry="4" fill={c.eye} />
          <ellipse cx="39" cy="26" rx="3.2" ry="4" fill={c.eye} />
          <circle cx="26.2" cy="24.6" r="1.1" fill="#fff" />
          <circle cx="40.2" cy="24.6" r="1.1" fill="#fff" />
        </g>
        <g className="pet-eye-closed">
          <path d="M22 27 Q25 30 28 27" stroke={c.eye} strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M36 27 Q39 30 42 27" stroke={c.eye} strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </g>

        <ellipse cx="32" cy="35" rx="3.5" ry="4" fill={c.accent} opacity="0.8" />
        <Zzz x={52} y={14} />
      </g>
    </>
  );
}

function DroneArt({ c }: ArtProps) {
  return (
    <>
      <ellipse className="pet-shadow" cx="32" cy="59" rx="11" ry="2.2" fill="#000" />

      <g className="pet-body">
        <path d="M32 12 L32 18" stroke={c.secondary} strokeWidth="2" strokeLinecap="round" />
        <g className="pet-rotor">
          <ellipse cx="32" cy="11" rx="16" ry="2.4" fill={c.accent} opacity="0.75" />
          <ellipse cx="32" cy="11" rx="3" ry="2.4" fill={c.secondary} />
        </g>

        <rect x="16" y="18" width="32" height="26" rx="11" fill={c.primary} />
        <rect x="19" y="22" width="26" height="13" rx="6.5" fill={c.eye} />

        <g className="pet-eye-open">
          <circle cx="27" cy="28.5" r="3" fill={c.accent} />
          <circle cx="37" cy="28.5" r="3" fill={c.accent} />
          <circle cx="28" cy="27.5" r="1" fill="#fff" />
          <circle cx="38" cy="27.5" r="1" fill="#fff" />
        </g>
        <g className="pet-eye-closed">
          <path d="M24 29 L30 29" stroke={c.accent} strokeWidth="2" strokeLinecap="round" />
          <path d="M34 29 L40 29" stroke={c.accent} strokeWidth="2" strokeLinecap="round" />
        </g>

        <circle className="pet-led" cx="32" cy="40" r="2.4" fill={c.accent} />

        <g className="pet-arm">
          <path d="M17 42 L12 50" stroke={c.secondary} strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
        <g className="pet-wing">
          <path d="M47 42 L52 50" stroke={c.secondary} strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>

        <Zzz x={52} y={16} />
      </g>
    </>
  );
}

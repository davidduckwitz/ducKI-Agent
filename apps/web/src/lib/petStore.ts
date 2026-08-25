/**
 * Pet settings store
 *
 * Kept separate from the main app store because it is purely client-side state
 * that has to survive reloads (localStorage): which pet is out, how it behaves,
 * where it was last dropped, and any sprite sheets the user imported.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_PET_ID } from "../components/pet/petRegistry";
import type { PetCommand, PetDefinition, PetPosition, PetStateId } from "../components/pet/petTypes";

export type LocomotionMode = "auto" | "ground" | "air";

export interface PetSettings {
  enabled: boolean;
  petId: string;
  /** Rendered pet height in px. */
  size: number;
  /** Movement speed multiplier. */
  speed: number;
  opacity: number;
  /** Pet runs after the mouse pointer when it moves. */
  followCursor: boolean;
  /** Pet mirrors agent activity (working / done / error / offline). */
  reactToEvents: boolean;
  /** Show the little speech bubble on reactions. */
  showBubbles: boolean;
  /** Also surface the pet's speech as an app notification (toast). */
  notifications: boolean;
  /** Override the pet's natural locomotion ("auto" = use the pet's own). */
  locomotion: LocomotionMode;
  /** Distance from the window bottom the ground pets stand on (status bar height). */
  groundOffset: number;
}

interface PetStoreState extends PetSettings {
  position: PetPosition | null;
  customPets: PetDefinition[];
  /** Not persisted: one-shot instruction from the settings UI to the live pet. */
  command: PetCommand;

  setEnabled: (enabled: boolean) => void;
  setPetId: (id: string) => void;
  patchSettings: (patch: Partial<PetSettings>) => void;
  setPosition: (position: PetPosition) => void;
  addCustomPet: (pet: PetDefinition) => void;
  removeCustomPet: (id: string) => void;
  /** Ask the live pet to perform an action right now (preview button in settings). */
  trigger: (action: PetStateId | "reset") => void;
  resetSettings: () => void;
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  enabled: true,
  petId: DEFAULT_PET_ID,
  size: 64,
  speed: 1,
  opacity: 1,
  // Off by default: the pet should mind its own business until asked to follow.
  followCursor: false,
  reactToEvents: true,
  showBubbles: true,
  notifications: false,
  locomotion: "auto",
  groundOffset: 28,
};

function syncPetWithAgent(petId: string): void {
  void fetch(`/api/settings/ERPEL_PET_ID`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: petId }),
  }).catch(() => undefined);
}

export const usePetStore = create<PetStoreState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PET_SETTINGS,
      position: null,
      customPets: [],
      command: { nonce: 0, action: "idle" },

      setEnabled: (enabled) => set({ enabled }),
      setPetId: (petId) => {
        set({ petId });
        syncPetWithAgent(petId);
      },
      patchSettings: (patch) => set(patch),
      setPosition: (position) => set({ position }),

      addCustomPet: (pet) =>
        set((s) => ({
          customPets: [...s.customPets.filter((p) => p.id !== pet.id), pet],
        })),

      removeCustomPet: (id) =>
        set((s) => ({
          customPets: s.customPets.filter((p) => p.id !== id),
          // Fall back to the default pet if the one being deleted is currently out.
          petId: s.petId === id ? DEFAULT_PET_ID : s.petId,
        })),

      trigger: (action) => set({ command: { nonce: get().command.nonce + 1, action } }),

      resetSettings: () => set({ ...DEFAULT_PET_SETTINGS, position: null }),
    }),
    {
      name: "ducki.pet",
      version: 2,
      // v1 shipped with cursor following on; v2 turns it off once for everyone
      // who still carries the old value. Re-enable it in the settings if wanted.
      migrate: (persisted, fromVersion) => {
        const state = (persisted ?? {}) as Partial<PetSettings>;
        if (fromVersion < 2) return { ...state, followCursor: false };
        return state;
      },
      partialize: (state) => ({
        enabled: state.enabled,
        petId: state.petId,
        size: state.size,
        speed: state.speed,
        opacity: state.opacity,
        followCursor: state.followCursor,
        reactToEvents: state.reactToEvents,
        showBubbles: state.showBubbles,
        notifications: state.notifications,
        locomotion: state.locomotion,
        groundOffset: state.groundOffset,
        position: state.position,
        customPets: state.customPets,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.petId) syncPetWithAgent(state.petId);
      },
    }
  )
);

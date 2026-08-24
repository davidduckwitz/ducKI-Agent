/**
 * Bot avatar renderer.
 *
 * A bot's `avatar` field is a plain string that can point at three different things,
 * resolved in this order:
 *  1. An uploaded image URL (starts with "http" or "/") -> rendered as <img>.
 *  2. A built-in/plugin/custom desk-pet id (see components/pet/petRegistry) -> PetView.
 *  3. A character-gallery id (see components/chat/characters) -> DynamicCharacter.
 * Anything else (including the built-in bots' legacy "duck-matrix"/"coding-agent" values)
 * falls back to the generic Bot icon so nothing ever renders blank.
 */

import { Bot as BotIcon } from "lucide-react";
import { PetView } from "../pet/PetView";
import { getPetById, BUILT_IN_PETS } from "../pet/petRegistry";
import { usePluginPets } from "../pet/usePluginPets";
import { usePetStore } from "../../lib/petStore";
import { characterRegistry, DynamicCharacter } from "../chat/characters";
import "../pet/pet.css";

function isImageRef(avatar: string): boolean {
  return avatar.startsWith("http://") || avatar.startsWith("https://") || avatar.startsWith("/");
}

export function BotAvatar({ avatar, size = 32, className }: { avatar?: string | null; size?: number; className?: string }) {
  const pluginPets = usePluginPets();
  const customPets = usePetStore((s) => s.customPets);

  if (avatar && isImageRef(avatar)) {
    return (
      <img
        src={avatar}
        alt=""
        className={className}
        style={{ width: size, height: size, borderRadius: "9999px", objectFit: "cover" }}
      />
    );
  }

  if (avatar) {
    const allPets = [...BUILT_IN_PETS, ...pluginPets, ...customPets];
    const pet = allPets.find((p) => p.id === avatar);
    if (pet) {
      return (
        <div className={className} style={{ width: size, height: size }}>
          <PetView pet={getPetById(avatar, [...pluginPets, ...customPets])} state="idle" size={size} animate={false} />
        </div>
      );
    }

    const character = characterRegistry.getCharacter(avatar);
    if (character) {
      return (
        <div className={className} style={{ width: size, height: size }}>
          <DynamicCharacter characterId={avatar} isWorking={false} size={size} />
        </div>
      );
    }
  }

  return <BotIcon className={className} style={{ width: size * 0.6, height: size * 0.6 }} />;
}

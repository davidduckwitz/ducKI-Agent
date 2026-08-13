/**
 * Pets contributed by enabled plugins (provides.pets).
 *
 * The host owns the pet runtime; plugins only ship declarative definitions (id, name, emoji,
 * locomotion, kind "svg"|"matrix", inline SVG art). This hook turns the plugin list into
 * PetDefinitions the built-in gallery + engine can render directly - no iframe. Disabling a
 * plugin drops its pets automatically because usePlugins only returns enabled ones' data.
 */

import { useMemo } from "react";
import { usePlugins } from "../../lib/usePlugins";
import type { PetDefinition, PetPalette } from "./petTypes";

export function usePluginPets(): PetDefinition[] {
  const { data: plugins } = usePlugins();
  return useMemo(() => {
    const out: PetDefinition[] = [];
    for (const plugin of plugins ?? []) {
      if (!plugin.enabled || plugin.error || !Array.isArray(plugin.pets)) continue;
      for (const pet of plugin.pets) {
        if (!pet || !pet.id || !pet.name) continue;
        out.push({
          id: pet.id,
          name: pet.name,
          description: pet.description,
          emoji: pet.emoji,
          locomotion: pet.locomotion === "ground" ? "ground" : "air",
          kind: pet.kind === "matrix" ? "matrix" : "svg",
          art: pet.art,
          palette: pet.palette as unknown as PetPalette | undefined,
          builtIn: false,
          source: "plugin",
          author: plugin.name,
        });
      }
    }
    return out;
  }, [plugins]);
}

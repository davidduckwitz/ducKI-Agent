/**
 * Character Registry
 * Manages all available characters and animations
 * Supports built-in and user-installed packages
 */

import type { CharacterDefinition, CharacterPackage, CharacterComponent } from "./types";

class CharacterRegistry {
  private characters: Map<string, CharacterDefinition> = new Map();
  private packages: Map<string, CharacterPackage> = new Map();
  private components: Map<string, CharacterComponent> = new Map();
  private listeners: Set<() => void> = new Set();

  /**
   * Register a character package
   */
  registerPackage(pkg: CharacterPackage, components: Record<string, CharacterComponent>): void {
    this.packages.set(pkg.id, pkg);

    for (const character of pkg.characters) {
      this.characters.set(character.id, character);

      // Store the component if provided
      if (components[character.id]) {
        this.components.set(character.id, components[character.id]!);
      }
    }

    this.notifyListeners();
  }

  /**
   * Get a character by ID
   */
  getCharacter(id: string): CharacterDefinition | undefined {
    return this.characters.get(id);
  }

  /**
   * Get component for a character
   */
  getComponent(id: string): CharacterComponent | undefined {
    return this.components.get(id);
  }

  /**
   * Get all available characters
   */
  getAllCharacters(): CharacterDefinition[] {
    return Array.from(this.characters.values());
  }

  /**
   * Get all installed packages
   */
  getInstalledPackages(): CharacterPackage[] {
    return Array.from(this.packages.values());
  }

  /**
   * Check if character exists
   */
  hasCharacter(id: string): boolean {
    return this.characters.has(id);
  }

  /**
   * Get package containing a character
   */
  getPackageForCharacter(characterId: string): CharacterPackage | undefined {
    const character = this.characters.get(characterId);
    if (!character) return undefined;

    for (const pkg of this.packages.values()) {
      if (pkg.characters.some((c) => c.id === characterId)) {
        return pkg;
      }
    }
    return undefined;
  }

  /**
   * Listen for registry changes
   */
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(): void {
    this.listeners.forEach((callback) => callback());
  }
}

// Export singleton instance
export const characterRegistry = new CharacterRegistry();

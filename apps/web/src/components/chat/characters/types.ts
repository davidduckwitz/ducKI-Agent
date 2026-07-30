/**
 * Character & Animation System Types
 * Defines the structure for custom animation packages and characters
 */

export interface CharacterProps {
  isWorking: boolean;
  size?: number;
  theme?: "light" | "dark";
  speed?: number;
  customConfig?: Record<string, unknown>;
}

export interface AnimationDefinition {
  id: string;
  name: string;
  description?: string;
  isIdle?: boolean;
  isWorking?: boolean;
  config?: Record<string, unknown>;
}

export interface CharacterDefinition {
  id: string;
  name: string;
  description?: string;
  type: "canvas" | "svg" | "html" | "gif" | "component";
  author?: string;
  version?: string;
  animations: AnimationDefinition[];
  metadata?: {
    size?: number;
    color?: string;
    supportsDarkMode?: boolean;
    customizable?: string[]; // ["size", "color", "speed"]
    [key: string]: unknown;
  };
}

export interface CharacterPackage {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  characters: CharacterDefinition[];
  metadata?: {
    tags?: string[];
    license?: string;
    repository?: string;
    [key: string]: unknown;
  };
}

export interface CharacterSettings {
  selectedCharacterId: string;
  selectedAnimationId: string;
  customizations: {
    size?: number;
    color?: string;
    speed?: number;
    opacity?: number;
    [key: string]: unknown;
  };
  installedPackages: string[];
}

export type CharacterComponent = React.ComponentType<CharacterProps>;

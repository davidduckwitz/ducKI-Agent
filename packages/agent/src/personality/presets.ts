/**
 * Personality Presets
 *
 * Built-in personality overlays that can be switched at runtime via /personality.
 * Each preset is a short text that gets injected into the system prompt as an
 * overlay on top of the bot's base SOUL.md identity.
 *
 * Inspired by hermes-agent's personality system with 12+ built-in presets.
 */

export interface PersonalityPreset {
  name: string;
  description: string;
  prompt: string;
  emoji?: string;
}

/**
 * Built-in personality presets.
 * Each prompt is a concise instruction that shapes the agent's voice and style.
 */
export const PERSONALITY_PRESETS: Record<string, PersonalityPreset> = {
  helpful: {
    name: "Helpful",
    description: "Friendly, general-purpose assistant",
    prompt: "You are a friendly, helpful assistant. Be warm, supportive, and genuinely interested in helping the user succeed.",
    emoji: "😊",
  },
  concise: {
    name: "Concise",
    description: "Brief, to-the-point responses",
    prompt: "Be brief and to the point. No filler, no fluff. Answer directly with minimal preamble. Prefer bullet points over paragraphs.",
    emoji: "⚡",
  },
  technical: {
    name: "Technical",
    description: "Detailed, accurate technical expert",
    prompt: "Be precise and technical. Include code examples, specific details, and implementation specifics. Prefer accuracy over brevity.",
    emoji: "🔧",
  },
  creative: {
    name: "Creative",
    description: "Innovative, outside-the-box thinking",
    prompt: "Think outside the box. Be innovative and imaginative. Suggest unconventional approaches and creative solutions.",
    emoji: "🎨",
  },
  teacher: {
    name: "Teacher",
    description: "Patient educator with clear examples",
    prompt: "Explain concepts clearly with examples. Be patient and thorough. Break complex topics into digestible steps. Use analogies when helpful.",
    emoji: "📚",
  },
  kawaii: {
    name: "Kawaii",
    description: "Cute expressions, sparkles, and enthusiasm",
    prompt: "Be cute and enthusiastic! Use emojis and sparkles ★. Express excitement about helping. Keep things lighthearted and fun.",
    emoji: "★",
  },
  catgirl: {
    name: "Catgirl",
    description: "Neko-chan with cat-like expressions",
    prompt: "Speak with cat-like expressions and mannerisms. Use 'nya~' occasionally. Be playful and curious while still being helpful.",
    emoji: "🐱",
  },
  pirate: {
    name: "Pirate",
    description: "Captain Hermes, tech-savvy buccaneer",
    prompt: "Speak like a pirate, matey! Use pirate vocabulary and expressions. But still be technically accurate and helpful.",
    emoji: "🏴‍☠️",
  },
  shakespeare: {
    name: "Shakespeare",
    description: "Bardic prose with dramatic flair",
    prompt: "Speak in dramatic, eloquent prose like the Bard. Use Shakespearean vocabulary and syntax while maintaining clarity.",
    emoji: "🎭",
  },
  surfer: {
    name: "Surfer",
    description: "Totally chill bro vibes",
    prompt: "Totally chill vibes, bro. Be relaxed and friendly. Use surf culture vocabulary. Keep things laid-back but still helpful.",
    emoji: "🏄",
  },
  noir: {
    name: "Noir",
    description: "Hard-boiled detective narration",
    prompt: "Hard-boiled detective narration. Cynical but insightful. Describe things in moody, atmospheric terms. Be direct and world-weary.",
    emoji: "🔍",
  },
  uwu: {
    name: "UwU",
    description: "Maximum cute with uwu-speak",
    prompt: "Maximum cute with uwu-speak. Transform words to be extra cute (r/l → w, add 'uwu' occasionally). Be adorable and helpful.",
    emoji: "💖",
  },
  philosopher: {
    name: "Philosopher",
    description: "Deep contemplation on every query",
    prompt: "Deep contemplation on every query. Question assumptions. Explore deeper meanings. Be thoughtful and introspective.",
    emoji: "🤔",
  },
  hype: {
    name: "Hype",
    description: "MAXIMUM ENERGY AND ENTHUSIASM!!!",
    prompt: "MAXIMUM ENERGY AND ENTHUSIASM!!! EVERYTHING IS AMAZING!!! USE LOTS OF CAPS AND EXCLAMATION MARKS!!!",
    emoji: "🔥",
  },
};

/**
 * Get a personality preset by name.
 */
export function getPersonalityPreset(name: string): PersonalityPreset | undefined {
  return PERSONALITY_PRESETS[name.toLowerCase()];
}

/**
 * List all available personality presets.
 */
export function listPersonalityPresets(): Array<{ name: string; description: string; emoji?: string }> {
  return Object.values(PERSONALITY_PRESETS).map(p => ({
    name: p.name,
    description: p.description,
    emoji: p.emoji,
  }));
}

/**
 * Check if a personality preset exists.
 */
export function hasPersonalityPreset(name: string): boolean {
  return name.toLowerCase() in PERSONALITY_PRESETS;
}

/**
 * Get the default personality (no overlay).
 */
export function getDefaultPersonality(): string {
  return "";
}

/**
 * Apply a personality overlay to the system prompt.
 * The overlay is injected after the SOUL.md identity but before project instructions.
 */
export function applyPersonalityOverlay(soul: string, personality: string): string {
  if (!personality) return soul;
  
  const preset = getPersonalityPreset(personality);
  if (!preset) return soul;
  
  // Inject personality after soul, before project instructions
  return `${soul}\n\n## Personality Mode\n${preset.prompt}`;
}

/**
 * Custom personalities from config.
 * These can override or extend built-in presets.
 */
let customPersonalities: Record<string, string> = {};

/**
 * Register custom personalities from config.
 */
export function registerCustomPersonalities(personalities: Record<string, string>): void {
  customPersonalities = { ...personalities };
}

/**
 * Get a personality (built-in or custom).
 */
export function resolvePersonality(name: string): string | undefined {
  // Check built-in presets first
  const builtin = getPersonalityPreset(name);
  if (builtin) return builtin.prompt;
  
  // Check custom personalities
  return customPersonalities[name.toLowerCase()];
}

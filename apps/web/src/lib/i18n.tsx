import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { translations, type Language, type TranslationTree } from "./translations";
import deFlag from "../assets/flags/de.svg";
import gbFlag from "../assets/flags/gb.svg";

const STORAGE_KEY = "ducki.language";

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: string) => string;
  languages: Array<{ code: Language; label: string; flagSrc: string }>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getNestedValue(tree: TranslationTree, key: string): string | undefined {
  const segments = key.split(".");
  let current: unknown = tree;

  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" ? current : undefined;
}

function detectInitialLanguage(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "de" || saved === "en") return saved;

  const browser = navigator.language.toLowerCase();
  if (browser.startsWith("de")) return "de";
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => detectInitialLanguage());

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  const t = useMemo(() => {
    return (key: string): string => {
      const selected = getNestedValue(translations[language], key);
      if (selected) return selected;

      const fallback = getNestedValue(translations.de, key);
      return fallback ?? key;
    };
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t,
      languages: [
        { code: "de", label: "Deutsch", flagSrc: deFlag },
        { code: "en", label: "English", flagSrc: gbFlag },
      ],
    }),
    [language, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}

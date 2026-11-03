/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "component" (desktop build): Monaco's TS worker comes from the "monaco-ts" component pack. */
  readonly VITE_MONACO_TS_WORKER?: string;
}

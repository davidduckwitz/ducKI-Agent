/**
 * Bundles Monaco locally instead of letting @monaco-editor/react fetch it from cdn.jsdelivr.net
 * at runtime. That keeps the code editor working offline (desktop app, air-gapped installs) and
 * lets the desktop CSP stay at script-src 'self'.
 *
 * Imported for its side effect by CodingWorkspace, which is itself lazy-loaded - so Monaco and
 * its workers only land in the coding route's chunks, not the main bundle.
 */
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { getApiBaseUrl } from "./backendUrl";

/**
 * The TypeScript worker alone is ~7 MB. The desktop build (`vite build --mode desktop`, see
 * .env.desktop) leaves it out; the "monaco-ts" component pack installs it on demand and the
 * local server serves it from /api/components/monaco-ts/file. The constant is replaced at build
 * time, so in desktop mode the dynamic import below is dropped from the bundle entirely.
 */
const TS_WORKER_FROM_COMPONENT = import.meta.env.VITE_MONACO_TS_WORKER === "component";

type WorkerFactory = () => Worker;

let tsWorkerFactory: Promise<WorkerFactory | null> | undefined;
function loadTsWorkerFactory(): Promise<WorkerFactory | null> {
  tsWorkerFactory ??= TS_WORKER_FROM_COMPONENT
    ? fetch(`${getApiBaseUrl()}/components/monaco-ts/file`)
        .then(async (res) => {
          if (!res.ok) return null;
          const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
          return () => new Worker(url);
        })
        .catch(() => null)
    : import("monaco-editor/esm/vs/language/typescript/ts.worker?worker").then((m) => () => new m.default());
  return tsWorkerFactory;
}

if (TS_WORKER_FROM_COMPONENT) {
  // The TS language features read this once, when the first TS/JS model appears. Keep them off
  // (syntax highlighting still works) unless the component turns out to be installed - the
  // check is a local request and normally finishes before any file is opened.
  const defaults = [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults];
  const full = defaults.map((d) => d.modeConfiguration);
  const off = Object.fromEntries(Object.keys(full[0] ?? {}).map((key) => [key, false]));
  defaults.forEach((d) => d.setModeConfiguration(off));
  void loadTsWorkerFactory().then((factory) => {
    if (factory) defaults.forEach((d, i) => d.setModeConfiguration(full[i]!));
  });
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker | Promise<Worker> {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return loadTsWorkerFactory().then((factory) => (factory ? factory() : new EditorWorker()));
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });

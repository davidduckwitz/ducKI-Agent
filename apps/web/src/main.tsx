import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { I18nProvider } from "./lib/i18n";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { Toaster } from "./components/ui/sonner";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

const hideInitialLoader = () => {
  const loader = document.getElementById("initial-loader");
  if (!loader) return;

  loader.classList.add("is-hidden");
  window.setTimeout(() => {
    loader.remove();
  }, 300);
};

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <App />
          <Toaster position="bottom-right" />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

window.requestAnimationFrame(hideInitialLoader);

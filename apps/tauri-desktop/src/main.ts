import { invoke } from "@tauri-apps/api/core";

console.log("DucKI Node Desktop App - Connecting to backend...");

async function connectToBackend(): Promise<void> {
  try {
    const url = (await invoke("get_backend_url")) as string;
    console.log("Backend URL:", url);
    // Redirect to the backend or web app
    window.location.href = url;
  } catch (error) {
    console.error("Failed to get backend URL:", error);
    // Show error message
    const app = document.getElementById("app");
    if (app) {
      app.innerHTML = `
        <div class="loading">
          <h1>🦆 DucKI Node</h1>
          <p style="color: #ff6b6b;">Failed to connect to backend</p>
          <p style="font-size: 0.9em; opacity: 0.7;">Check the logs or configure a remote backend</p>
        </div>
      `;
    }
  }
}

connectToBackend();

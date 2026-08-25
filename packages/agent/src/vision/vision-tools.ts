import type { LLMProvider } from "@ducki/providers";
import type { LLMContent, LLMMessage, ToolExecutor, ToolResult } from "@ducki/shared";
import type { Logger } from "@ducki/logger";

/**
 * Phase 4 "Observer": visual reasoning over a screenshot.
 *
 * `analyze_ui_layout` sends an image plus a question (and optional visual
 * constraints) to the active multimodal model and returns the analysis. When
 * constraints are supplied it returns a per-constraint pass/fail checklist —
 * the same shape as the Phase 1 verifier, so a visual expectation ("the primary
 * button is blue and centered") plugs into the same review flow as a text one.
 *
 * Requires a vision-capable model to be loaded in the active provider (e.g. a
 * multimodal GGUF in LM Studio, or a multimodal Ollama model). If the model
 * cannot see images, the provider surfaces that error and it is returned as-is.
 */

function ok(data: unknown): ToolResult {
  return { success: true, data };
}
function fail(error: string): ToolResult {
  return { success: false, data: null, error };
}

interface VisualCheck {
  description: string;
  status: "passed" | "failed" | "unclear";
  detail?: string;
}

function looksLikeRawBase64(value: string): boolean {
  return value.length > 128 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function looksLikeDirectImageUrl(value: string): boolean {
  if (value.startsWith("data:image/")) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return /\.(?:png|jpe?g|webp|gif|bmp|avif)(?:$|[?#])/i.test(url.pathname)
      || /\/(?:screenshots?|images?|thumbnails?)\//i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Build the image content block from either a URL or raw/data-URL base64. */
function buildImageContent(
  input: Record<string, unknown>,
  fallbackImage?: LLMContent
): LLMContent | { error: string } {
  const imageUrl = typeof input["imageUrl"] === "string" ? input["imageUrl"].trim() : "";
  const imageBase64 = typeof input["imageBase64"] === "string" ? input["imageBase64"].trim() : "";
  const mimeType = typeof input["mimeType"] === "string" && input["mimeType"] ? input["mimeType"] : "image/png";

  if (imageUrl) {
    // Smaller models frequently put the browser page URL or raw screenshot base64 into
    // imageUrl. Normalize raw bytes, and use the actual current browser frame when the
    // value is not recognizably a direct image resource.
    if (looksLikeRawBase64(imageUrl)) {
      return { type: "image_data", image_data: { url: `data:${mimeType};base64,${imageUrl}`, mime_type: mimeType } };
    }
    if (looksLikeDirectImageUrl(imageUrl)) {
      return { type: "image_url", image_url: { url: imageUrl, detail: "high" } };
    }
    if (fallbackImage) return fallbackImage;
    return { error: "imageUrl is not a direct image URL; provide imageBase64 or capture a browser screenshot first" };
  }
  if (imageBase64) {
    const url = imageBase64.startsWith("data:") ? imageBase64 : `data:${mimeType};base64,${imageBase64}`;
    return { type: "image_data", image_data: { url, mime_type: mimeType } };
  }
  return { error: "provide either 'imageUrl' or 'imageBase64'" };
}

function parseJSON<T>(content: string): T | null {
  try {
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export function createVisionTools(
  getProvider: () => LLMProvider,
  logger: Logger,
  isEnabled: () => boolean = () => true,
  getFallbackImage: () => LLMContent | undefined = () => undefined
): ToolExecutor[] {
  const analyzeUiLayout: ToolExecutor = {
    name: "analyze_ui_layout",
    description:
      "Analyze a screenshot with a vision model: describe the layout, or check it against visual expectations (e.g. 'the CTA button is blue and centered', 'no overlapping text'). Use for UI/design verification that goes beyond reading the DOM. Requires a vision-capable model to be loaded.",
    definition: {
      name: "analyze_ui_layout",
      description: "Visual reasoning over a screenshot. Returns a description and, if constraints are given, a per-constraint pass/fail checklist.",
      parameters: {
        type: "object",
        properties: {
          imageUrl: { type: "string", description: "URL of the screenshot (served URL or a data: URL). Provide this OR imageBase64." },
          imageBase64: { type: "string", description: "Base64 image data (raw or a full data: URL). Provide this OR imageUrl." },
          mimeType: { type: "string", description: "MIME type for imageBase64 (default image/png)." },
          question: { type: "string", description: "What to look for / describe (optional if constraints given)." },
          constraints: {
            type: "array",
            items: { type: "string" },
            description: "Visual expectations to check individually (each returns passed/failed/unclear).",
          },
        },
        required: [],
      },
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      if (!isEnabled()) {
        return fail("Vision analysis is disabled in settings (AGENT_ENABLE_VISION).");
      }
      const image = buildImageContent(input, getFallbackImage());
      if ("error" in image) return fail(image.error);

      const question = typeof input["question"] === "string" ? input["question"].trim() : "";
      const constraints = Array.isArray(input["constraints"])
        ? (input["constraints"] as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
        : [];

      const provider = getProvider();

      try {
        if (constraints.length > 0) {
          // Structured visual verification (Phase 1 "visual-check" shape).
          const checklist = constraints.map((c, i) => `${i + 1}. ${c}`).join("\n");
          const prompt = `Look at the image and check each visual expectation. Be strict — mark "failed" if it is not clearly met, "unclear" if the image does not show enough to decide.
Return ONLY JSON: {"description":"one-line summary","checks":[{"description":"...","status":"passed|failed|unclear","detail":"short reason"}]}

Expectations:
${checklist}`;
          const messages: LLMMessage[] = [
            { role: "user", content: [image, { type: "text", text: prompt }] },
          ];
          const response = await provider.generate(messages, { temperature: 0.1, maxTokens: 1200 });
          const parsed = parseJSON<{ description?: string; checks?: VisualCheck[] }>(response.content);
          if (!parsed || !Array.isArray(parsed.checks)) {
            // Fall back to returning the raw model text rather than failing hard.
            return ok({ description: response.content, checks: [], raw: true });
          }
          const checks = parsed.checks.slice(0, constraints.length);
          const passed = checks.every((c) => c.status !== "failed");
          return ok({
            description: parsed.description ?? "",
            checks,
            passed,
            failures: checks.filter((c) => c.status === "failed").map((c) => c.description),
          });
        }

        const prompt = question || "Describe this UI screenshot: layout, key elements, colors, and anything that looks broken or misaligned.";
        const messages: LLMMessage[] = [
          { role: "user", content: [image, { type: "text", text: prompt }] },
        ];
        const response = await provider.generate(messages, { temperature: 0.2, maxTokens: 1500 });
        return ok({ analysis: response.content });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("analyze_ui_layout failed", { error: message });
        const lacksVision = /vision|image (?:input|support)|multimodal|does not support images/i.test(message);
        return fail(lacksVision
          ? `Vision analysis failed because the active model rejected image input: ${message}`
          : `Vision analysis request failed: ${message}`);
      }
    },
  };

  return [analyzeUiLayout];
}

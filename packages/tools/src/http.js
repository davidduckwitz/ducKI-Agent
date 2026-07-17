import { z } from "zod";
const HttpInputSchema = z.object({
    action: z.enum(["get", "post", "put", "patch", "delete", "head"]),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    timeout: z.number().default(30000),
});
function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    catch {
        return false;
    }
}
export const httpTool = {
    name: "http",
    description: "Make HTTP requests (GET, POST, PUT, PATCH, DELETE)",
    definition: {
        name: "http",
        description: "HTTP client for making web requests",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["get", "post", "put", "patch", "delete", "head"] },
                url: { type: "string", description: "Target URL" },
                headers: { type: "object", description: "Request headers" },
                body: { description: "Request body (for POST/PUT/PATCH)" },
                timeout: { type: "number", description: "Timeout in ms", default: 30000 },
            },
            required: ["action", "url"],
        },
    },
    async execute(input) {
        const parsed = HttpInputSchema.safeParse(input);
        if (!parsed.success) {
            return { success: false, data: null, error: parsed.error.message };
        }
        const { action, url, headers = {}, body, timeout } = parsed.data;
        if (!isValidUrl(url)) {
            return { success: false, data: null, error: `Invalid URL: ${url}` };
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const fetchOptions = {
                method: action.toUpperCase(),
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
                signal: controller.signal,
            };
            if (body && ["post", "put", "patch"].includes(action)) {
                fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
            }
            const response = await fetch(url, fetchOptions);
            const responseText = await response.text();
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            }
            catch {
                responseData = responseText;
            }
            return {
                success: response.ok,
                data: {
                    status: response.status,
                    statusText: response.statusText,
                    headers: Object.fromEntries(response.headers.entries()),
                    body: responseData,
                },
                error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
            };
        }
        catch (error) {
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            clearTimeout(timeoutId);
        }
    },
};
//# sourceMappingURL=http.js.map
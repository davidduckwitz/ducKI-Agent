import { z } from "zod";
const HttpInputSchema = z.object({
    action: z.enum(["get", "post", "put", "patch", "delete", "head"]),
    url: z.string().url().optional(),
    baseUrl: z.string().url().optional(),
    path: z.string().optional(),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    timeout: z.number().default(30000),
    allowedHosts: z.array(z.string()).optional(),
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
                url: { type: "string", description: "Target URL (optional when using baseUrl + path)" },
                baseUrl: { type: "string", description: "Base URL, e.g. http://localhost:3001" },
                path: { type: "string", description: "Relative API path, e.g. /api/shared/files" },
                query: { type: "object", description: "Optional query parameters" },
                headers: { type: "object", description: "Request headers" },
                body: { description: "Request body (for POST/PUT/PATCH)" },
                timeout: { type: "number", description: "Timeout in ms", default: 30000 },
                allowedHosts: { type: "array", description: "Optional host allowlist", items: { type: "string" } },
            },
            required: ["action"],
        },
    },
    async execute(input) {
        const parsed = HttpInputSchema.safeParse(input);
        if (!parsed.success) {
            return { success: false, data: null, error: parsed.error.message };
        }
        const { action, headers = {}, body, timeout, allowedHosts } = parsed.data;
        const buildUrl = () => {
            if (parsed.data.url)
                return parsed.data.url;
            if (!parsed.data.baseUrl || !parsed.data.path) {
                throw new Error("Either 'url' or both 'baseUrl' and 'path' are required");
            }
            const base = parsed.data.baseUrl.endsWith("/") ? parsed.data.baseUrl.slice(0, -1) : parsed.data.baseUrl;
            const path = parsed.data.path.startsWith("/") ? parsed.data.path : `/${parsed.data.path}`;
            const assembled = `${base}${path}`;
            if (!parsed.data.query)
                return assembled;
            const urlObj = new URL(assembled);
            for (const [key, value] of Object.entries(parsed.data.query)) {
                urlObj.searchParams.set(key, String(value));
            }
            return urlObj.toString();
        };
        let url;
        try {
            url = buildUrl();
        }
        catch (error) {
            return {
                success: false,
                data: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        if (!isValidUrl(url)) {
            return { success: false, data: null, error: `Invalid URL: ${url}` };
        }
        if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
            const hostname = new URL(url).hostname.toLowerCase();
            const hostAllowed = allowedHosts.map((host) => host.toLowerCase()).includes(hostname);
            if (!hostAllowed) {
                return { success: false, data: null, error: `Host '${hostname}' not allowed` };
            }
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
                    url,
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
/**
 * Typed provider failures.
 *
 * Callers used to distinguish failure kinds by matching on error message text, which is
 * why a dead endpoint surfaced as the generic "Connection error." with no indication of
 * *which* endpoint was dead. The provider is the only layer that knows its own base URL,
 * so it is the layer that has to say so.
 */

/** The provider's endpoint could not be reached at all. Retrying the same call - in any
 *  mode, streaming or not - cannot succeed until the endpoint is back. */
export class ProviderConnectionError extends Error {
  readonly providerName: string;
  readonly endpoint: string;

  constructor(providerName: string, endpoint: string, cause?: unknown) {
    const detail = extractCauseCode(cause);
    super(
      `${providerName} ist unter ${endpoint} nicht erreichbar${detail ? ` (${detail})` : ""}. ` +
        `Laeuft der Server, und stimmt die konfigurierte Base-URL?`
    );
    this.name = "ProviderConnectionError";
    this.providerName = providerName;
    this.endpoint = endpoint;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isProviderConnectionError(error: unknown): error is ProviderConnectionError {
  return error instanceof ProviderConnectionError;
}

function extractCauseCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const nested = (cause as { cause?: unknown }).cause;
  if (nested && nested !== cause) return extractCauseCode(nested);
  return undefined;
}

/** Node/undici connection failure codes. A DNS or TCP-level failure never depends on how
 *  the request body was framed, so none of them are worth a second attempt. */
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Recognizes a transport-level failure. Checks the OpenAI SDK's error name/status first
 * (an APIConnectionError has no HTTP status because no response ever arrived), then walks
 * the cause chain for a socket-level code.
 */
export function looksLikeConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && /^API(Connection|ConnectionTimeout)Error$/.test(name)) return true;

  const code = extractCauseCode(error);
  if (code && CONNECTION_ERROR_CODES.has(code)) return true;

  const message = (error as { message?: unknown }).message;
  const status = (error as { status?: unknown }).status;
  // "Connection error." is what the OpenAI SDK reports when the request never reached a
  // server; it carries no status, which is what separates it from an HTTP-level error.
  if (typeof message === "string" && status === undefined && /connection error/i.test(message)) {
    return true;
  }

  return false;
}

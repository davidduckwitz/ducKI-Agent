import type { Logger } from "@ducki/logger";
import type { ErrorClassifierConfig } from "../config/provider-settings.js";

/**
 * Comprehensive error classification system (9-step pipeline).
 *
 * Classifies LLM API errors into actionable categories with recovery flags.
 * Priority order: Provider-specific → HTTP → Error codes → Patterns → Fallbacks
 *
 * Settings-aware: Follows AgentRuntimeControls configuration
 */

export enum ErrorCategory {
  // Tier 1: Provider-Specific Patterns
  ThinkingBlock = "ThinkingBlock",
  TierGate = "TierGate",
  OAuthLimitExceeded = "OAuthLimitExceeded",

  // Tier 2: HTTP Status
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  PaymentRequired = "PaymentRequired",
  NotFound = "NotFound",
  Conflict = "Conflict",
  TooManyRequests = "TooManyRequests",
  RequestTimeout = "RequestTimeout",
  BadRequest = "BadRequest",

  // Tier 3: Error Codes
  BillingExhausted = "BillingExhausted",
  RateLimited = "RateLimited",
  ContextWindowExceeded = "ContextWindowExceeded",
  TokenLimitExceeded = "TokenLimitExceeded",
  ContentPolicyViolation = "ContentPolicyViolation",
  ModelNotAvailable = "ModelNotAvailable",

  // Tier 4: Pattern Matching
  InvalidSchema = "InvalidSchema",
  MalformedResponse = "MalformedResponse",
  ProviderDown = "ProviderDown",

  // Tier 5-9: Fallback Categories
  SSLCertificateError = "SSLCertificateError",
  NetworkError = "NetworkError",
  TimeoutError = "TimeoutError",
  TransientError = "TransientError",
  UnknownError = "UnknownError",
}

export interface ErrorClassification {
  category: ErrorCategory;
  retryable: boolean;
  shouldCompress: boolean;
  shouldRotateCredential: boolean;
  shouldFallback: boolean;
  severity: "critical" | "warning" | "transient";
  recommendation: string;
  statusCode?: number;
  originalMessage: string;
}

export class ErrorClassifier {
  private config: ErrorClassifierConfig;

  constructor(private readonly logger?: Logger, config?: Partial<ErrorClassifierConfig>) {
    // Default config
    const defaults: ErrorClassifierConfig = {
      retryableErrorCategories: [
        "RateLimited",
        "TimeoutError",
        "NetworkError",
        "ProviderDown",
        "TransientError",
        "ContextWindowExceeded",
        "Timeout",
        // Unclassified errors are transient by default: a single bounded retry is the safer
        // bet than failing the run outright on an error we couldn't categorize.
        "UnknownError",
      ],
      maxRetryAttempts: 3,
      retryBackoffMs: 1000,
      retryBackoffMultiplier: 2,
      shouldCompressionThreshold: 80,
      autoCompressOnError: true,
      compressionMinChars: 50000,
      rotationStrategy: "auto",
      maxErrorsBeforeRotation: 5,
      enableFallback: true,
      fallbackStrategy: "primary-first",
      logClassifications: false,
      logRetries: true,
    };

    this.config = { ...defaults, ...config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<ErrorClassifierConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.logger) {
      this.logger.info("ErrorClassifier config updated", { config: this.config });
    }
  }

  /**
   * Classify an error (9-step pipeline)
   */
  classify(error: unknown, context?: any): ErrorClassification {
    // Lowercase for matching: every classify* step tests against lowercase literals
    // (e.g. message.includes("thinking block")), so a capitalized provider message like
    // "Thinking block budget exceeded" or "OAuth rate limit exceeded" would otherwise fall
    // through to UnknownError. Status-code regexes match digits and are unaffected.
    const message = this.extractMessage(error).toLowerCase();
    const statusCode = this.extractStatusCode(error);

    // Log classification for debugging
    if (this.logger && this.config.logClassifications) {
      this.logger.debug("Classifying error", {
        message,
        statusCode,
        provider: context?.lastProvider,
        attempt: context?.retryAttempt,
      });
    }

    // STEP 1: Provider-Specific Patterns
    const step1 = this.classifyProviderPatterns(message, statusCode);
    if (step1) return step1;

    // STEP 2: HTTP Status Codes
    const step2 = this.classifyHttpStatus(statusCode);
    if (step2) return step2;

    // STEP 3: Error Codes from Response Bodies
    const step3 = this.classifyErrorCodes(message);
    if (step3) return step3;

    // STEP 4: Pattern Matching (billing, rate limits, context)
    const step4 = this.classifyPatterns(message);
    if (step4) return step4;

    // STEP 5: SSL/Certificate Errors (Fail-Fast)
    const step5 = this.classifySSLErrors(message);
    if (step5) return step5;

    // STEP 6: Transport/Timeout Heuristics
    const step6 = this.classifyTransport(message);
    if (step6) return step6;

    // STEP 7: Server Disconnects (Context Overflow Detection)
    const step7 = this.classifyServerDisconnect(message);
    if (step7) return step7;

    // STEP 8: Network Issues
    const step8 = this.classifyNetworkErrors(message);
    if (step8) return step8;

    // STEP 9: Unknown (Default Retry)
    return this.classifyUnknown(message);
  }

  /**
   * STEP 1: Provider-Specific Patterns
   */
  private classifyProviderPatterns(message: string, _statusCode?: number): ErrorClassification | null {
    // Anthropic thinking blocks
    if (message.includes("thinking block") || message.includes("budget_tokens")) {
      return {
        category: ErrorCategory.ThinkingBlock,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Reduce thinking block budget or compress context",
        originalMessage: message,
      };
    }

    // Anthropic tier gates
    if (message.includes("tier") && message.includes("gate")) {
      return {
        category: ErrorCategory.TierGate,
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        severity: "critical",
        recommendation: "Request access to higher tier or use different provider",
        originalMessage: message,
      };
    }

    // OAuth limits
    if (message.includes("oauth") && (message.includes("limit") || message.includes("exceeded"))) {
      return {
        category: ErrorCategory.OAuthLimitExceeded,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        severity: "warning",
        recommendation: "Rotate credentials or wait for rate limit reset",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 2: HTTP Status Codes
   */
  private classifyHttpStatus(statusCode?: number): ErrorClassification | null {
    if (!statusCode) return null;

    switch (statusCode) {
      case 400:
        return {
          category: ErrorCategory.BadRequest,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: false,
          severity: "critical",
          recommendation: "Fix request format or parameters",
          statusCode,
          originalMessage: "Bad Request (400)",
        };

      case 401:
        return {
          category: ErrorCategory.Unauthorized,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: true,
          shouldFallback: true,
          severity: "critical",
          recommendation: "Check API key validity or rotate credentials",
          statusCode,
          originalMessage: "Unauthorized (401)",
        };

      case 403:
        return {
          category: ErrorCategory.Forbidden,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "critical",
          recommendation: "Check account permissions or use different provider",
          statusCode,
          originalMessage: "Forbidden (403)",
        };

      case 402:
        return {
          category: ErrorCategory.PaymentRequired,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: true,
          shouldFallback: true,
          severity: "critical",
          recommendation: "Check billing or rotate to different credential",
          statusCode,
          originalMessage: "Payment Required (402)",
        };

      case 404:
        return {
          category: ErrorCategory.NotFound,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: false,
          severity: "critical",
          recommendation: "Check model name or endpoint URL",
          statusCode,
          originalMessage: "Not Found (404)",
        };

      case 409:
        return {
          category: ErrorCategory.Conflict,
          retryable: true,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "transient",
          recommendation: "Retry after short delay",
          statusCode,
          originalMessage: "Conflict (409)",
        };

      case 429:
        return {
          category: ErrorCategory.TooManyRequests,
          retryable: true,
          shouldCompress: false,
          shouldRotateCredential: true,
          shouldFallback: true,
          severity: "warning",
          recommendation: "Rotate credentials or wait for rate limit reset",
          statusCode,
          originalMessage: "Too Many Requests (429)",
        };

      case 408:
        return {
          category: ErrorCategory.RequestTimeout,
          retryable: true,
          shouldCompress: true,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "transient",
          recommendation: "Compress context or try again",
          statusCode,
          originalMessage: "Request Timeout (408)",
        };

      case 500:
      case 502:
      case 503:
      case 504:
        return {
          category: ErrorCategory.ProviderDown,
          retryable: true,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "transient",
          recommendation: "Wait and retry or try fallback provider",
          statusCode,
          originalMessage: `Provider Error (${statusCode})`,
        };

      default:
        return null;
    }
  }

  /**
   * STEP 3: Error Codes from Response Bodies
   */
  private classifyErrorCodes(message: string): ErrorClassification | null {
    // Billing exhausted
    if (message.includes("billing") || message.includes("credit") || message.includes("exhausted")) {
      return {
        category: ErrorCategory.BillingExhausted,
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        severity: "critical",
        recommendation: "Check billing or switch to different API key",
        originalMessage: message,
      };
    }

    // Rate limiting
    if (message.includes("rate") && message.includes("limit")) {
      return {
        category: ErrorCategory.RateLimited,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: true,
        shouldFallback: true,
        severity: "warning",
        recommendation: "Rotate credentials or implement backoff",
        originalMessage: message,
      };
    }

    // Context overflow
    if (
      message.includes("context") ||
      message.includes("window") ||
      message.includes("too long") ||
      message.includes("max tokens")
    ) {
      return {
        category: ErrorCategory.ContextWindowExceeded,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "warning",
        recommendation: "Compress conversation history",
        originalMessage: message,
      };
    }

    // Token limit
    if (message.includes("token") && message.includes("limit")) {
      return {
        category: ErrorCategory.TokenLimitExceeded,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: false,
        severity: "warning",
        recommendation: "Reduce output tokens or compress context",
        originalMessage: message,
      };
    }

    // Content policy
    if (message.includes("content") && (message.includes("policy") || message.includes("blocked"))) {
      return {
        category: ErrorCategory.ContentPolicyViolation,
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "critical",
        recommendation: "Modify request content or use different provider",
        originalMessage: message,
      };
    }

    // Model not available
    if (message.includes("model") && (message.includes("not found") || message.includes("invalid"))) {
      return {
        category: ErrorCategory.ModelNotAvailable,
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        severity: "critical",
        recommendation: "Check model name or use different model",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 4: Pattern Matching
   */
  private classifyPatterns(message: string): ErrorClassification | null {
    // Invalid schema/JSON
    if (message.includes("json") || message.includes("schema") || message.includes("parse")) {
      return {
        category: ErrorCategory.InvalidSchema,
        retryable: false,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: false,
        severity: "critical",
        recommendation: "Fix request schema or tool definitions",
        originalMessage: message,
      };
    }

    // Malformed response
    if (message.includes("response") && (message.includes("malformed") || message.includes("invalid"))) {
      return {
        category: ErrorCategory.MalformedResponse,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Retry with simplified context",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 5: SSL/Certificate Errors (Fail-Fast)
   */
  private classifySSLErrors(message: string): ErrorClassification | null {
    if (message.includes("ssl") || message.includes("certificate") || message.includes("cert") || message.includes("tls") || message.includes("handshake")) {
      if (message.includes("verify") || message.includes("self-signed")) {
        return {
          category: ErrorCategory.SSLCertificateError,
          retryable: false,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "critical",
          recommendation: "Check SSL certificate or use different endpoint",
          originalMessage: message,
        };
      }

      // TLS handshake errors (retry)
      if (message.includes("handshake") || message.includes("tls")) {
        return {
          category: ErrorCategory.TransientError,
          retryable: true,
          shouldCompress: false,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "transient",
          recommendation: "Retry connection",
          originalMessage: message,
        };
      }
    }

    return null;
  }

  /**
   * STEP 6: Transport/Timeout Heuristics
   */
  private classifyTransport(message: string): ErrorClassification | null {
    if (message.includes("timeout") || message.includes("timed out")) {
      return {
        category: ErrorCategory.TimeoutError,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Retry with compression or increased timeout",
        originalMessage: message,
      };
    }

    if (message.includes("deadline")) {
      return {
        category: ErrorCategory.TimeoutError,
        retryable: true,
        shouldCompress: true,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Retry with increased deadline",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 7: Server Disconnects (Context Overflow Detection)
   */
  private classifyServerDisconnect(message: string): ErrorClassification | null {
    if (message.includes("disconnect") || message.includes("connection reset") || message.includes("econnreset")) {
      // If it looks like context overflow
      if (message.includes("context") || message.includes("large")) {
        return {
          category: ErrorCategory.ContextWindowExceeded,
          retryable: true,
          shouldCompress: true,
          shouldRotateCredential: false,
          shouldFallback: true,
          severity: "warning",
          recommendation: "Compress context and retry",
          originalMessage: message,
        };
      }

      return {
        category: ErrorCategory.NetworkError,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Retry connection",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 8: Network Errors
   */
  private classifyNetworkErrors(message: string): ErrorClassification | null {
    if (
      message.includes("econnrefused") ||
      message.includes("refused") ||
      message.includes("connect") ||
      message.includes("network")
    ) {
      return {
        category: ErrorCategory.NetworkError,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Check network connectivity or try fallback provider",
        originalMessage: message,
      };
    }

    if (
      message.includes("enotfound") ||
      message.includes("getaddrinfo") ||
      message.includes("dns")
    ) {
      return {
        category: ErrorCategory.NetworkError,
        retryable: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        shouldFallback: true,
        severity: "transient",
        recommendation: "Check DNS or network connectivity",
        originalMessage: message,
      };
    }

    return null;
  }

  /**
   * STEP 9: Unknown (Default Retry)
   */
  private classifyUnknown(message: string): ErrorClassification {
    const classification: ErrorClassification = {
      category: ErrorCategory.UnknownError,
      retryable: this.config.retryableErrorCategories.includes(ErrorCategory.UnknownError),
      shouldCompress: false,
      shouldRotateCredential: false,
      shouldFallback: this.config.enableFallback,
      severity: "transient",
      recommendation: "Retry or check logs for more information",
      originalMessage: message,
    };

    if (this.logger && this.config.logRetries && classification.retryable) {
      this.logger.info("Error is retryable", { category: classification.category });
    }

    return classification;
  }

  /**
   * Utility: Extract error message
   */
  private extractMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Utility: Extract HTTP status code
   */
  private extractStatusCode(error: unknown): number | undefined {
    if (error instanceof Error) {
      const match = error.message.match(/\b([1-5]\d{2})\b/);
      if (match && match[1]) return parseInt(match[1]);
    }
    return undefined;
  }
}

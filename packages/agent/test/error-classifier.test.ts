import { describe, it, expect } from "vitest";
import { ErrorClassifier, ErrorCategory } from "../src/executor/error-classifier.js";

describe("ErrorClassifier", () => {
  const classifier = new ErrorClassifier();

  describe("Tier 1: Provider-Specific Patterns", () => {
    it("classifies thinking block errors", () => {
      const error = new Error("Thinking block budget exceeded");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ThinkingBlock);
      expect(result.retryable).toBe(true);
      expect(result.shouldCompress).toBe(true);
      expect(result.shouldFallback).toBe(true);
    });

    it("classifies tier gate errors", () => {
      const error = new Error("Access denied: tier gate limit exceeded");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.TierGate);
      expect(result.retryable).toBe(false);
      expect(result.shouldRotateCredential).toBe(true);
    });

    it("classifies OAuth limit errors", () => {
      const error = new Error("OAuth rate limit exceeded");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.OAuthLimitExceeded);
      expect(result.retryable).toBe(true);
      expect(result.shouldRotateCredential).toBe(true);
    });
  });

  describe("Tier 2: HTTP Status Codes", () => {
    it("classifies 401 Unauthorized", () => {
      const error = new Error("HTTP 401: Unauthorized");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.Unauthorized);
      expect(result.retryable).toBe(false);
      expect(result.shouldRotateCredential).toBe(true);
      expect(result.statusCode).toBe(401);
    });

    it("classifies 429 Rate Limited", () => {
      const error = new Error("HTTP 429: Too Many Requests");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.TooManyRequests);
      expect(result.retryable).toBe(true);
      expect(result.shouldRotateCredential).toBe(true);
      expect(result.statusCode).toBe(429);
    });

    it("classifies 402 Payment Required", () => {
      const error = new Error("HTTP 402: Payment Required");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.PaymentRequired);
      expect(result.retryable).toBe(false);
      expect(result.shouldRotateCredential).toBe(true);
    });

    it("classifies 503 Service Unavailable", () => {
      const error = new Error("HTTP 503: Service Unavailable");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ProviderDown);
      expect(result.retryable).toBe(true);
      expect(result.shouldFallback).toBe(true);
    });
  });

  describe("Tier 3: Error Codes", () => {
    it("classifies billing exhausted errors", () => {
      const error = new Error("Your billing account has no credits left");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.BillingExhausted);
      expect(result.retryable).toBe(false);
      expect(result.shouldRotateCredential).toBe(true);
    });

    it("classifies context window exceeded errors", () => {
      const error = new Error("Context window (128k tokens) exceeded");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ContextWindowExceeded);
      expect(result.retryable).toBe(true);
      expect(result.shouldCompress).toBe(true);
    });

    it("classifies content policy violation errors", () => {
      const error = new Error("Request blocked by content policy filter");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ContentPolicyViolation);
      expect(result.retryable).toBe(false);
      expect(result.shouldFallback).toBe(true);
    });

    it("classifies model not available errors", () => {
      const error = new Error("Model claude-99 not found");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ModelNotAvailable);
      expect(result.retryable).toBe(false);
    });
  });

  describe("Tier 4: Pattern Matching", () => {
    it("classifies JSON parse errors", () => {
      const error = new Error("Failed to parse JSON schema");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.InvalidSchema);
      expect(result.retryable).toBe(false);
    });

    it("classifies malformed response errors", () => {
      const error = new Error("Provider returned malformed response");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.MalformedResponse);
      expect(result.retryable).toBe(true);
      expect(result.shouldCompress).toBe(true);
    });
  });

  describe("Tier 5: SSL/Certificate Errors", () => {
    it("classifies SSL verification errors (fail-fast)", () => {
      const error = new Error("SSL certificate verify failed");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.SSLCertificateError);
      expect(result.retryable).toBe(false);
    });

    it("classifies TLS handshake errors (retryable)", () => {
      const error = new Error("TLS handshake timeout");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.TransientError);
      expect(result.retryable).toBe(true);
    });
  });

  describe("Tier 6: Transport/Timeout", () => {
    it("classifies timeout errors", () => {
      const error = new Error("Request timeout after 30s");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.TimeoutError);
      expect(result.retryable).toBe(true);
      expect(result.shouldCompress).toBe(true);
    });

    it("classifies deadline exceeded errors", () => {
      const error = new Error("Deadline exceeded");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.TimeoutError);
      expect(result.retryable).toBe(true);
    });
  });

  describe("Tier 7: Server Disconnects", () => {
    it("classifies connection reset errors", () => {
      const error = new Error("Connection reset by peer");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.NetworkError);
      expect(result.retryable).toBe(true);
      expect(result.shouldFallback).toBe(true);
    });

    it("classifies context-related disconnects as context overflow", () => {
      const error = new Error("Connection reset: context too large");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.ContextWindowExceeded);
      expect(result.shouldCompress).toBe(true);
    });
  });

  describe("Tier 8: Network Errors", () => {
    it("classifies connection refused errors", () => {
      const error = new Error("ECONNREFUSED: Connection refused");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.NetworkError);
      expect(result.retryable).toBe(true);
    });

    it("classifies DNS errors", () => {
      const error = new Error("ENOTFOUND: getaddrinfo ENOTFOUND api.example.com");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.NetworkError);
      expect(result.retryable).toBe(true);
    });
  });

  describe("Tier 9: Unknown Errors", () => {
    it("classifies unknown errors as retryable by default", () => {
      const error = new Error("Some obscure error that wasn't classified");
      const result = classifier.classify(error);

      expect(result.category).toBe(ErrorCategory.UnknownError);
      expect(result.retryable).toBe(true);
      expect(result.severity).toBe("transient");
    });

    it("handles non-Error objects", () => {
      const result = classifier.classify("string error");

      expect(result.category).toBe(ErrorCategory.UnknownError);
      expect(result.originalMessage).toBe("string error");
    });
  });

  describe("Severity Levels", () => {
    it("marks auth errors as critical", () => {
      const error = new Error("HTTP 401: Invalid API key");
      const result = classifier.classify(error);

      expect(result.severity).toBe("critical");
    });

    it("marks transient errors as transient", () => {
      const error = new Error("Timeout");
      const result = classifier.classify(error);

      expect(result.severity).toBe("transient");
    });

    it("marks rate limits as warning", () => {
      const error = new Error("HTTP 429: Rate limited");
      const result = classifier.classify(error);

      expect(result.severity).toBe("warning");
    });
  });

  describe("Recovery Recommendations", () => {
    it("provides context compression recommendation", () => {
      const error = new Error("Context window exceeded");
      const result = classifier.classify(error);

      expect(result.recommendation).toContain("Compress");
    });

    it("provides credential rotation recommendation", () => {
      const error = new Error("HTTP 401");
      const result = classifier.classify(error);

      expect(result.recommendation).toContain("API key");
    });

    it("provides fallback recommendation", () => {
      const error = new Error("HTTP 503: Provider down");
      const result = classifier.classify(error);

      expect(result.recommendation).toContain("fallback");
    });
  });
});

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Spike Test - Tests Exponential Backoff Under Sudden Load
 * Simulates sudden traffic spikes to validate backoff behavior
 *
 * Run: k6 run spike-test.js --vus 100 --duration 60s
 */

const API_URL = __ENV.API_URL || "http://localhost:3001";

const spikeSuccessRate = new Rate("spike_success");
const spikeResponseTime = new Trend("spike_response_time");
const backoffDetected = new Counter("backoff_observed");
const timeoutErrors = new Counter("timeout_errors");

export const options = {
  stages: [
    { duration: "5s", target: 10 },   // Baseline
    { duration: "10s", target: 100 }, // SPIKE
    { duration: "15s", target: 100 }, // Sustained spike
    { duration: "10s", target: 50 },  // Recover
    { duration: "20s", target: 0 },   // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(99)<3000"],
    spike_success: ["rate>0.80"],
  },
};

export default function () {
  group("Spike Test - Exponential Backoff Validation", () => {
    const timestamp = Date.now();
    const requestPayload = {
      input: `Spike test request at ${timestamp} - ${Math.random()}`,
    };

    const startTime = Date.now();
    const response = http.post(
      `${API_URL}/api/chat/send`,
      JSON.stringify(requestPayload),
      {
        headers: { "Content-Type": "application/json" },
        timeout: "15s", // Longer timeout to see backoff behavior
      }
    );
    const endTime = Date.now();

    const duration = endTime - startTime;

    // Check for backoff indicators
    // If response takes longer than expected, backoff is working
    if (duration > 2000) {
      backoffDetected.add(1);
    }

    if (response.status === 408 || response.status === 504) {
      timeoutErrors.add(1);
    }

    const success = check(response, {
      "responded (even if slow)": (r) => r.status !== 0,
      "no client timeout": (r) => r.status !== 408,
      "no gateway timeout": (r) => r.status !== 504,
      "successful response": (r) => r.status === 200,
    });

    spikeSuccessRate.add(success);
    spikeResponseTime.add(duration);

    // No sleep - we want to hit the spike hard
  });

  group("Validation - Health Metrics During Spike", () => {
    const healthCheck = http.get(`${API_URL}/api/agent-health`);

    check(healthCheck, {
      "health endpoint available under load": (r) => r.status === 200,
    });
  });
}

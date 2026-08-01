import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

/**
 * Stress Test - Tests Backoff & Circuit Breaker
 * Simulates high concurrency and tool failures
 *
 * Run: k6 run stress-test.js --vus 50 --duration 120s
 */

const API_URL = __ENV.API_URL || "http://localhost:3001";

const stressSuccessRate = new Rate("stress_success");
const stressResponseTime = new Trend("stress_response_time");
const circuitBreakerTrips = new Rate("circuit_breaker_trips");

export const options = {
  stages: [
    { duration: "10s", target: 20 },  // Ramp up quickly
    { duration: "30s", target: 50 },  // Spike to 50 VUs
    { duration: "30s", target: 50 },  // Sustained high load
    { duration: "20s", target: 20 },  // Ramp down
    { duration: "10s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    stress_success: ["rate>0.85"], // Slightly lower threshold for stress
  },
};

export default function () {
  group("Stress Test - High Concurrency", () => {
    // Test 1: Basic chat request
    const basicPayload = {
      input: `Generate random number between 1 and 100 - request ${Math.floor(Math.random() * 1000)}`,
    };

    const response = http.post(
      `${API_URL}/api/chat/send`,
      JSON.stringify(basicPayload),
      {
        headers: { "Content-Type": "application/json" },
        timeout: "10s",
      }
    );

    const success = check(response, {
      "status is 200": (r) => r.status === 200,
      "has content": (r) => r.body.length > 10,
      "no timeout": (r) => r.status !== 408,
      "no server error": (r) => r.status < 500,
    });

    if (response.status === 503) {
      circuitBreakerTrips.add(1); // Service Unavailable = Circuit Breaker?
    }

    stressSuccessRate.add(success);
    stressResponseTime.add(response.timings.duration);

    sleep(0.5);
  });

  group("Health Check - Monitor Circuit Breaker", () => {
    const healthResponse = http.get(`${API_URL}/api/agent-health`);

    check(healthResponse, {
      "health endpoint responds": (r) => r.status === 200,
      "has tool metrics": (r) => r.body.includes("toolHealth"),
      "has circuit status": (r) => r.body.includes("circuitBreaker"),
    });

    // Parse and log circuit breaker state if open
    if (healthResponse.status === 200) {
      try {
        const data = JSON.parse(healthResponse.body);
        if (data.circuitBreaker?.summary?.openCircuits > 0) {
          console.log(
            `⚠️  Circuit Breaker Alert: ${data.circuitBreaker.summary.openCircuits} open circuits`
          );
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  });
}

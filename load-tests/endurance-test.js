import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Endurance Test - Long-running stability test
 * Tests circuit breaker recovery and health monitoring over extended period
 *
 * Run: k6 run endurance-test.js --vus 5 --duration 300s
 */

const API_URL = __ENV.API_URL || "http://localhost:3001";

const enduranceSuccessRate = new Rate("endurance_success");
const enduranceResponseTime = new Trend("endurance_response_time");
const circuitBreakerHealing = new Counter("circuit_healing_detected");
const healthCheckSuccess = new Counter("health_check_ok");

export const options = {
  stages: [
    { duration: "30s", target: 5 },   // Warm up
    { duration: "240s", target: 5 },  // Sustained load
    { duration: "30s", target: 0 },   // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(90)<1000"],
    endurance_success: ["rate>0.95"],
  },
};

let lastCircuitStatus = {};

export default function () {
  group("Endurance Test - Long Running Stability", () => {
    const payload = {
      input: `Endurance test - timestamp ${Date.now()}`,
    };

    const response = http.post(
      `${API_URL}/api/chat/send`,
      JSON.stringify(payload),
      {
        headers: { "Content-Type": "application/json" },
      }
    );

    const success = check(response, {
      "status 200": (r) => r.status === 200,
      "has content": (r) => r.body.length > 0,
    });

    enduranceSuccessRate.add(success);
    enduranceResponseTime.add(response.timings.duration);

    sleep(2);
  });

  group("Health Monitoring During Endurance", () => {
    const healthResponse = http.get(`${API_URL}/api/agent-health`);

    const healthOk = check(healthResponse, {
      "health endpoint ok": (r) => r.status === 200,
    });

    if (healthOk) {
      healthCheckSuccess.add(1);
    }

    // Monitor circuit breaker recovery
    if (healthResponse.status === 200) {
      try {
        const data = JSON.parse(healthResponse.body);
        const currentCircuitStatus = data.circuitBreaker?.summary || {};

        // Detect if circuits are healing (going from open to closed)
        for (const toolName in currentCircuitStatus) {
          if (
            lastCircuitStatus[toolName]?.openCircuits > 0 &&
            currentCircuitStatus.openCircuits === 0
          ) {
            circuitBreakerHealing.add(1);
            console.log(`✅ Circuit breaker recovered for ${toolName}`);
          }
        }

        lastCircuitStatus = currentCircuitStatus;
      } catch (e) {
        // Ignore parse errors
      }
    }

    sleep(5);
  });
}

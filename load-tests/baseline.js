import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

/**
 * Baseline Load Test
 * Tests normal agent operation under sustained load
 *
 * Run: k6 run baseline.js
 * With options: k6 run baseline.js --vus 10 --duration 60s
 */

const API_URL = __ENV.API_URL || "http://localhost:3001";

// Custom metrics
const successRate = new Rate("chat_success");
const responseTime = new Trend("chat_response_time");
const chatRequests = new Counter("chat_requests");

export const options = {
  stages: [
    { duration: "10s", target: 5 },   // Ramp up to 5 users
    { duration: "30s", target: 10 },  // Ramp up to 10 users
    { duration: "20s", target: 5 },   // Ramp down to 5 users
    { duration: "10s", target: 0 },   // Ramp down to 0 users
  ],
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"],
    chat_success: ["rate>0.95"],
  },
};

export default function () {
  group("Agent Chat - Baseline", () => {
    const payload = {
      input: "What is the current time? Please check using shell.",
    };

    const params = {
      headers: {
        "Content-Type": "application/json",
      },
    };

    const response = http.post(`${API_URL}/api/chat/send`, JSON.stringify(payload), params);

    const success = check(response, {
      "status is 200": (r) => r.status === 200,
      "has response text": (r) => r.body.length > 0,
      "response time < 5s": (r) => r.timings.duration < 5000,
    });

    successRate.add(success);
    responseTime.add(response.timings.duration);
    chatRequests.add(1);

    sleep(1);
  });
}

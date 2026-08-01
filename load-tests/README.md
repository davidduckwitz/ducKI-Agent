# Load Testing Suite

Comprehensive load testing suite to validate agent resilience, circuit breaker behavior, and exponential backoff strategies.

## Setup

### Install k6

```bash
# macOS
brew install k6

# Linux
sudo apt-get install k6

# Windows
choco install k6

# Or download from https://k6.io/docs/getting-started/installation/
```

## Test Scenarios

### 1. Baseline Test
Normal load testing - validates basic functionality under sustained load.

```bash
k6 run baseline.js --vus 10 --duration 60s
```

**What it tests:**
- Normal chat requests under steady load
- Response times
- Success rates
- No tool failures

**Expected results:**
- Success rate > 95%
- p(95) response time < 500ms
- All requests complete without timeout

---

### 2. Stress Test
High concurrency and sustained load - validates circuit breaker activation.

```bash
k6 run stress-test.js --vus 50 --duration 120s
```

**What it tests:**
- Circuit breaker behavior under high load
- Health endpoint availability during stress
- Tool failure handling
- Recovery mechanisms

**Expected results:**
- Success rate > 85%
- Circuit breaker opens when tools fail
- Health endpoint responds even under stress
- Recovery after load decreases

---

### 3. Spike Test
Sudden traffic spike - validates exponential backoff strategy.

```bash
k6 run spike-test.js --vus 100 --duration 60s
```

**What it tests:**
- Exponential backoff when hammered with requests
- Response times increase due to backoff (not a bug!)
- No timeouts despite spike
- Graceful degradation

**Expected results:**
- Response times increase (backoff working)
- Success rate > 80% despite spike
- No unexpected timeouts
- "backoff_observed" counter > 0

---

### 4. Endurance Test
Long-running test - validates circuit breaker recovery and stability.

```bash
k6 run endurance-test.js --vus 5 --duration 300s
```

**What it tests:**
- Sustained operation over 5 minutes
- Circuit breaker healing (recovery)
- Health metrics stability
- Memory/resource leaks

**Expected results:**
- Consistent success rate > 95%
- Circuit breaker recovers from open state
- No degradation over time
- Health endpoint always available

---

## Running All Tests

Sequential execution:

```bash
echo "Running baseline test..."
k6 run baseline.js --vus 10 --duration 60s

echo "Running stress test..."
k6 run stress-test.js --vus 50 --duration 120s

echo "Running spike test..."
k6 run spike-test.js --vus 100 --duration 60s

echo "Running endurance test..."
k6 run endurance-test.js --vus 5 --duration 300s
```

Or create a shell script:

```bash
#!/bin/bash
cd load-tests
for test in baseline spike-test stress-test endurance-test; do
  echo "=========================================="
  echo "Running $test..."
  echo "=========================================="
  k6 run $test.js
  echo ""
done
```

## Custom Configuration

### Environment Variables

```bash
# Custom API URL
k6 run baseline.js --env API_URL=http://custom-server:3001

# Custom VU and duration
k6 run stress-test.js --vus 75 --duration 180s
```

### Performance Thresholds

Modify thresholds in test files to match your SLOs:

```javascript
thresholds: {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],  // Response time
  chat_success: ['rate>0.95'],                      // Success rate
}
```

## Monitoring Results

### Real-time Metrics

While tests run, k6 outputs:

```
data_received..................: 0 B
data_sent.......................: 0 B
http_req_blocked................: 0
http_req_connecting.............: 0
http_req_duration...............: avg=120ms, min=100ms, max=140ms, p(90)=125ms, p(95)=130ms
http_req_failed.................: 0.00%
http_req_receiving..............: 0
http_req_sending................: 0
http_req_tls_handshaking........: 0
http_req_waiting................: 120ms
http_reqs........................: 500
iteration_duration..............: 1.12s
iterations........................: 500
```

### Interpreting Results

**Success Metrics:**
- `chat_success: rate>0.95` = 95%+ requests succeeded
- `http_req_duration: p(95)<500` = 95th percentile response < 500ms
- `spike_success: rate>0.80` = Degraded but still 80%+ success under spike

**Circuit Breaker Indicators:**
- `circuit_breaker_trips: rate>0` = Circuit opened (expected under stress)
- `backoff_observed: counter>0` = Exponential backoff detected (good!)
- `circuit_healing_detected: counter>0` = Circuit recovered (stability confirmed)

## Health Dashboard During Tests

Monitor real-time health while tests run:

```
http://localhost:3001/dashboard
```

Watch:
- Tool health scores dropping under stress
- Circuit breaker states changing
- Recovery after tests complete

## CI/CD Integration

### GitHub Actions

```yaml
- name: Load Test
  run: |
    npm run load-test
    k6 run load-tests/baseline.js
    k6 run load-tests/stress-test.js
```

### Threshold Failures

Tests exit with non-zero code if thresholds not met:

```bash
$ k6 run baseline.js
# ... test runs ...
# ✗ chat_success.....: 90% > 95% — FAILED
# Exit code: 1 (failed)
```

## Troubleshooting

### "Connection refused"

Ensure server is running:

```bash
npm run dev  # Start server first
```

### "High p(95) response times"

This is expected! Exponential backoff adds delays:
- First request: immediate
- Retry 1: 500ms backoff
- Retry 2: 1000ms backoff
- Retry 3: 2000ms backoff

### Circuit breaker never opens

Either:
1. Tools aren't actually failing (good!)
2. Load isn't high enough to trigger failures
3. Circuit breaker thresholds are too high

Adjust test VUs or thresholds in code.

## Performance Targets

### Green Zone (All Good)
- Success rate: > 95%
- p(95) response time: < 500ms
- Circuit breaker heals: Yes
- Timeout errors: 0

### Yellow Zone (Caution)
- Success rate: 85-95%
- p(95) response time: 500ms-1s
- Circuit breaker heals: Sometimes
- Timeout errors: < 5%

### Red Zone (Action Required)
- Success rate: < 85%
- p(95) response time: > 1s
- Circuit breaker heals: No
- Timeout errors: > 5%
- Server crashes

## Next Steps

1. Run baseline test to establish baseline
2. Run stress test to trigger failures
3. Monitor circuit breaker behavior
4. Run spike test to validate backoff
5. Run endurance test to confirm stability
6. If all pass: System is resilient! ✅

## References

- [k6 Documentation](https://k6.io/docs/)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Exponential Backoff](https://aws.amazon.com/de/blogs/architecture/exponential-backoff-and-jitter/)

# Security Checklist

Use this short checklist as a mandatory procedure for all risky changes.

## 1. Scope
- What exactly is in scope?
- Which systems/files are explicitly out of scope?

## 2. Secrets
- Are tokens, keys, passwords, or sensitive contents being processed?
- Ensure: no output in logs, chat responses, or commits.

## 3. Input/Trust
- Does data come from an external or untrusted source?
- Is validation/sanitizing present and strict enough?

## 4. Auth/Policy
- Does the task change auth, roles, signatures, sessions, or CORS?
- Is there a possible privilege escalation?

## 5. Execution Risk
- Do shell/tool steps contain destructive or far-reaching commands?
- Is there a safe dry-run or a smaller test step before the full run?

## 6. Data Safety
- Could data be lost, overwritten, or exfiltrated?
- Is backup/rollback clearly defined?

## 7. Gateway/Discord
- For outbound: check the gateway configuration first (`list_configs`).
- Do not send sensitive data when the destination is unclear.

## 8. Verification
- Which concrete checks prove the security fix (typecheck/tests/repro)?
- Were only the necessary changes made?

## 9. Incident Mode
- On suspicion of a security problem: stop immediately.
- Report the risk, impact, urgency, and the next safe step.

## 10. Conclusion
- Name the residual risk.
- Document the recommended next step.

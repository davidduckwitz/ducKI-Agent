# News-Digest Workflow - Node Implementierunge

n---

## Node 1: Daily Trigger - Cronjob Setup

### Cronjob Tool Calln```javascriptn[TOOL:cronjob({
  "action": "create",
  "schedule": "0 6 * * *",
  "timezone": "Europe/Berlin",
  "targetType": "workflow",
  "targetRef": "wf_f1w6kcc2_1785468154727",
  "payload": {
    "workflowName": "News-Digest-Automation",
    "description": "Daily news digest at 06:00 CEST"
  }

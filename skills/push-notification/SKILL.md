---
name: push-notification
description: Send the user a browser push notification via the Cloud Voice-App when a long-running task finishes or something needs their attention while they're not looking at the page. Use for "notify me when done" style requests.
---

# Skill: Push Notification

## Summary
Sends a browser push notification to the user's Cloud Voice-App (delivered even if that page
isn't open/focused). The tool name is `push_notification` (underscore) - do not call it
`push-notification` or `notify`, those are not valid tool names.

## Usage
```
[TOOL:push_notification({
  "title": "Task finished",
  "body": "The report you asked for is ready.",
  "url": "/voice"
})]
```

- `title` and `body` are required, short (a few words / 1-2 sentences).
- `url` is optional, defaults to `/voice` - the path opened when the notification is clicked.

## When to use
- A long-running task (research, coding, video processing) just finished while the user likely
  isn't watching.
- Something needs the user's attention now (an error that needs a decision, a reminder they set).

## When NOT to use
- For every routine reply - this interrupts the user, reserve it for things worth interrupting for.
- Right after the user just sent a message (they're already looking at the chat).

## Failure handling
This fails gracefully, not as a hard error, if:
- The user has no Cloud API key connected, or
- The user hasn't enabled notifications in the Voice-App (bell icon).

In both cases, just tell the user in plain text that the notification couldn't be sent and why -
don't retry the tool call.

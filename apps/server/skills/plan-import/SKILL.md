---
name: plan-import
slug: plan-import
description: Parse and import markdown-formatted plans into the system
icon: 📋
version: 1.0.0
category: planning
---

# Plan Import Skill

Import markdown-formatted plans directly into the chat. The system will parse the markdown, validate the structure, and display the plan with action buttons.

## Usage

```
/plan-import
[paste your markdown plan here]
```

## Markdown Format

Plans must follow this structure:

```markdown
## Plan: [Your Plan Title]

**Komplexität:** [Niedrig|Mittel|Hoch]

1. **First Step Title**
   Description of what needs to be done
   _Benötigte Tools: tool1, tool2_

2. **Second Step Title**
   Another step description
   _Benötigte Tools: tool3_
```

## Example

```markdown
## Plan: Website Redesign

**Komplexität:** Mittel

1. **Design Phase**
   Create wireframes and design system components
   _Benötigte Tools: design, figma_

2. **Frontend Development**
   Build React components and integrate designs
   _Benötigte Tools: coding, frontend_

3. **Backend API**
   Create REST endpoints for new features
   _Benötigte Tools: coding, backend_
```

## Features

- ✅ Automatic markdown parsing
- ✅ Complexity level extraction (1-5 scale)
- ✅ Tool identification per step
- ✅ Plan validation
- ✅ Auto-save to database
- ✅ Ready-to-execute with plan buttons

## Plan Buttons

After import, your plan appears with three action buttons:

- **Verbessern** - Refine the plan with AI suggestions
- **Verwerfen** - Close and discard the plan
- **Umsetzen** - Execute the plan immediately

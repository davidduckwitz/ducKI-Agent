---
name: agent-questions
description: "Enables structured question dialogs for agent-user interactions with multiple choice, text, and combined input modes"
version: 1.0.0
---

# Agent Question System Skill

## Purpose
Lets the agent ask the user follow-up questions with different answer types (multiple choice, text, combined). These questions are shown in specially formatted boxes.

## Usage

### Simple text question
When you want to ask an open question:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "What is your name?",
    "description": "Enter your name for personalization",
    "type": "text",
    "placeholder": "e.g. Jane Doe",
    "required": true
  }
}
```

### Multiple choice question
When the user should choose between predefined options:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "Which programming language do you prefer?",
    "type": "multiple-choice",
    "options": [
      {
        "id": "js",
        "label": "JavaScript/TypeScript",
        "description": "Web development and Node.js"
      },
      {
        "id": "py",
        "label": "Python",
        "description": "Data science and automation"
      },
      {
        "id": "go",
        "label": "Go",
        "description": "Backend and system tools"
      }
    ]
  }
}
```

### Combined question (choices + custom input)
When users can pick from options OR provide their own input:

```json
{
  "type": "question",
  "question": {
    "id": "unique-id",
    "question": "What improvements would you like to the plan?",
    "description": "Choose an option or enter your own idea",
    "type": "combined",
    "options": [
      {
        "id": "more-details",
        "label": "More detail",
        "description": "Add detailed steps"
      },
      {
        "id": "simplify",
        "label": "Simplify",
        "description": "Reduce complexity"
      },
      {
        "id": "add-error-handling",
        "label": "Error handling",
        "description": "Add error handling"
      }
    ],
    "placeholder": "Or enter your own idea...",
    "required": true
  }
}
```

## Answer processing

The user answers the question, and the answer is returned to you. You can then use the answer to shape your next steps.

### Example workflow for plan improvement:

1. **You ask a question:**
```json
{
  "type": "question",
  "question": {
    "id": "plan-improvement",
    "question": "Which aspects of the plan should be improved?",
    "type": "combined",
    "options": [
      { "id": "clarity", "label": "Clarity", "description": "Make the plan easier to understand" },
      { "id": "efficiency", "label": "Efficiency", "description": "Reduce the number of steps" },
      { "id": "robustness", "label": "Robustness", "description": "Add error handling" }
    ],
    "placeholder": "Or another improvement suggestion...",
    "required": true
  }
}
```

2. **The user answers** (either a choice or custom text)

3. **You receive the answer** and process it:
   - If option: `{ "option": "clarity", "custom": "" }`
   - If custom: `{ "option": "", "custom": "Make the plan shorter" }`
   - If both: `{ "option": "clarity", "custom": "and even more specific" }`

4. **You revise the plan** based on the answer

5. **You ask again** whether further improvements are wanted

## Best Practices

### ✅ Good questions
- Precise and unambiguous wording
- With helpful options that reflect real decisions
- With a fallback (custom input) for the user's ideas
- With meaningful descriptions for each option

### ❌ Bad questions
- Too open or ambiguous
- Too many options (max. 4-5 recommended)
- No option for user input in multiple choice
- Missing descriptions for options

## Integration with other components

These questions are seamlessly integrated into the chat flow:
- They appear as formatted boxes with a blue tint
- The user can answer directly in the box
- After the answer, the box turns green
- Your follow-up action is written directly into the chat

## Example: iterative plan-improvement process

```
1. Agent shows the current plan
2. Agent asks: "What should be improved?"
   [Multiple choice box with options + custom input]
3. User answers
4. Agent: "Understood! I'll revise the plan with a focus on [answer]..."
5. Agent shows the improved plan
6. Agent asks: "Would you like further improvements?"
   [Yes / No / Own idea]
7. If yes: back to step 2
8. If no: "Perfect! The plan is ready to implement."
```

## Technical details

- The question ID must be unique (for tracking)
- `required: true` means at least one field must be filled
- Combined questions allow a choice OR custom input, or BOTH
- Questions are asynchronous - the agent waits for the user's answer

## Usage examples

### Plan improvement (already implemented)
The agent asks for improvements and revises the plan iteratively.

### Feature clarification
The agent asks which features should be prioritized.

### Configuration
The agent asks for user preferences (e.g. programming language, framework).

### Error handling
The agent asks how errors should be handled.

### Code-review decisions
The agent asks for code-style preferences.

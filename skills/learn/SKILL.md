---
name: learn
description: Create reusable knowledge-base skills from documents, URLs, directories, or past conversation content
version: 1.0.0
category: meta
tags: [skills, learning, knowledge, documentation]
---

# Learn: Knowledge-Base Skill Authoring

## When to Use
- The user says "/learn <source>" or asks you to remember/learn from something
- A document, URL, codebase directory, or past conversation needs to become a reusable skill
- Large sources (books, spec documents, large docs folders) should become knowledge-base skills with per-chapter reference files

## Procedure

### 1. Identify and gather the source

Parse the user's request to identify WHAT to learn from:

- **URL**: Use `http` tool or `web_extract` to fetch page content
- **Local directory**: Use `filesystem` tool to list files, then `read_file` to read them
- **Local file** (PDF, .md, .txt): Use `read_file` to read it
- **"What we just did"**: Use the current conversation history directly - the user wants to capture the workflow just performed
- **"The last task"**: Same as above

### 2. Analyze and structure

After gathering the source material, structure it into a SKILL.md:

```
---
name: kebab-case-name
description: One sentence summary (max 60 chars, what AND when to use)
version: 1.0.0
category: appropriate-category
tags: [tag1, tag2]
---

# Skill Title

## When to Use
Specific trigger conditions that should load this skill.

## Core Concepts
Key mental models, frameworks, definitions the agent needs to know.

## Procedure
Step-by-step procedure for the workflow.

## Pitfalls
Known failure modes and fixes.

## Verification
How to confirm the work was done correctly.
```

### 3. For LARGE sources (books, long docs, multi-file codebases):

Create a knowledge-base skill with a lean SKILL.md and one distilled reference file per chapter/topic:

```
skills/<skill-name>/
├── SKILL.md                # Core mental models + index of references
├── references/
│   ├── chapter-01.md       # One distilled file per chapter/topic
│   ├── chapter-02.md
│   └── glossary.md         # Key terms when the source earns them
└── examples/
    └── basic-usage.md
```

The SKILL.md should contain:
- A brief description of the source
- The key mental models or frameworks
- An index of what each reference file covers
- "Load reference files with `skill_view(name, path)` on demand"

### 4. Save via skill_manage

Use the `skill_manage` tool to save:

```json
// Create the main SKILL.md
skill_manage(action="create", name="skill-name", category="category", content="...full SKILL.md content...")

// For each reference file
skill_manage(action="write_file", name="skill-name", file_path="references/chapter-01.md", file_content="...distilled content...")
```

### 5. Report what was created

Tell the user:
- Skill name and location
- Number of reference files created
- How to invoke it: `/<skill-name>`
- What it covers

## Pitfalls
- Do NOT paste entire source text verbatim - distill and synthesize structure
- Do NOT create a skill for trivial/one-time information
- Keep descriptions under 60 characters
- Never use invented tool names or commands
- For URLs, always cite the source URL in the skill's description

## Verification
- The skill appears in `/skills` listing
- `/skill_view skill-name` shows the full content
- The description is meaningful and trigger-conditions are clear
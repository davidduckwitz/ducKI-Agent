# Plan Markdown Format Guide

This guide explains how to format plans in markdown for importing into ducki via the `/plan-import` skill.

## Basic Structure

```markdown
## Plan: [Title]

**Komplexität:** [Level]

1. **Step Title**
   Step description
   _Benötigte Tools: tool1, tool2_

2. **Another Step**
   Description here
   _Benötigte Tools: tool3_
```

## Sections Explained

### Heading (Required)

```markdown
## Plan: Website Redesign
```

- Use `##` (level 2 heading)
- Start with "Plan: " or just the title
- **Goal** is extracted as everything after "Plan: " or the full heading text

### Complexity Level (Optional)

```markdown
**Komplexität:** Mittel
```

- **Niedrig** → Complexity 1
- **Mittel** → Complexity 3 (default)
- **Hoch** → Complexity 5

If omitted, defaults to 3 (Mittel).

### Steps (Required - min 1)

```markdown
1. **Step Title**
   Step description here
   _Benötigte Tools: tool1, tool2_
```

Each step needs:
- **Number** (1, 2, 3...)
- **Title** in **bold**
- **Description** (indented, on next line)
- **Tools** (optional, in italics with format shown)

## Complete Example

```markdown
## Plan: Mobile App Backend

**Komplexität:** Hoch

1. **Project Initialization**
   Set up Node.js project with TypeScript and Express
   _Benötigte Tools: npm, git, coding_

2. **Database Schema**
   Design and create PostgreSQL database with migrations
   _Benötigte Tools: postgres, database_

3. **API Endpoints**
   Build REST API with authentication and validation
   _Benötigte Tools: coding, backend, testing_

4. **Testing Suite**
   Write unit and integration tests for all endpoints
   _Benötigte Tools: testing, ci_

5. **Documentation**
   Create API documentation and deployment guide
   _Benötigte Tools: documentation_
```

## Parsing Rules

1. **Goal**: First heading (## or #) with text
2. **Title**: Full heading text (including "Plan: " prefix if present)
3. **Complexity**: Searched anywhere in document
4. **Steps**: Numbered list items with bold titles
5. **Tools**: Searched within each step, comma-separated
6. **Descriptions**: Text between step title and next step (or end)

## Tips

- Keep step descriptions concise (1-2 sentences)
- List tools that will actually be needed for that step
- Use standard tool names (coding, frontend, backend, database, testing, etc.)
- No special characters required - plain markdown works fine
- Empty lines between steps are optional

## Common Tools

- **coding** - General programming
- **frontend** - React, Vue, Angular components
- **backend** - Server logic, APIs, databases
- **database** - SQL, MongoDB, data design
- **testing** - Unit tests, E2E tests
- **ci** - GitHub Actions, CI/CD pipelines
- **documentation** - Writing docs, guides
- **design** - UI/UX design
- **git** - Git operations
- **npm** - Package management
- **docker** - Containerization
- **deployment** - Server deployment, hosting

## Validation

Plans are validated during import:

- ✅ At least goal is present
- ✅ At least 1 step is defined
- ✅ All steps have titles and descriptions
- ✅ Tools are comma-separated strings

If validation fails, you'll see an error message. Review the format and try again.

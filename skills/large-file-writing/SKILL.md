---
name: large-file-writing
description: "Chunk strategy for writing files larger than token limits - split content across multiple API calls"
---

# Large File Writing Strategy

For files larger than 2000 tokens (~500+ lines), split writing into multiple sequential calls.

## Why

LLM output is limited to ~4000 tokens per response. Large files get truncated mid-way if written as one action.

## When to Use

Apply chunking when writing:
- **HTML/CSS files**: > 300 lines
- **JavaScript/TypeScript**: > 400 lines  
- **JSON**: > 1000 lines
- **Any file**: When approaching response token limit

## How It Works

Write files in 2-3 sequential parts, each using correct action:

| Part | Action | Content |
|------|--------|---------|
| 1 | `write` | File structure, head, setup |
| 2 | `append` | Middle sections, main content |
| 3 | `append` | Final sections, closing tags |

## Example: Large HTML File (250+ lines)

### Part 1: Create file with structure
```
[TOOL:coding({
  "action": "write",
  "project": "my-project",
  "path": "index.html",
  "content": "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n  <title>My App</title>\n  <style>\n    * { margin: 0; padding: 0; }\n    body { font-family: Arial; background: #f5f5f5; }\n    .container { max-width: 1200px; margin: 0 auto; }\n  </style>\n</head>\n<body>\n  <header>\n    <nav class=\"navbar\">\n      <h1>My App</h1>\n      <ul>\n        <li><a href=\"#\">Home</a></li>\n        <li><a href=\"#\">About</a></li>\n      </ul>\n    </nav>\n  </header>"
})]
```

**Response**: Part 1/3 written (head and header)

### Part 2: Add main content
```
[TOOL:coding({
  "action": "append",
  "project": "my-project",
  "path": "index.html",
  "content": "\n  <main class=\"container\">\n    <section class=\"hero\">\n      <h2>Welcome</h2>\n      <p>This is the main content section.</p>\n    </section>\n    <section class=\"features\">\n      <h3>Features</h3>\n      <ul>\n        <li>Feature 1</li>\n        <li>Feature 2</li>\n        <li>Feature 3</li>\n      </ul>\n    </section>\n  </main>"
})]
```

**Response**: Part 2/3 appended (main content)

### Part 3: Close file
```
[TOOL:coding({
  "action": "append",
  "project": "my-project",
  "path": "index.html",
  "content": "\n  <footer>\n    <p>&copy; 2025 My App. All rights reserved.</p>\n  </footer>\n  <script>\n    // JavaScript here\n    console.log('Page loaded');\n  </script>\n</body>\n</html>"
})]
```

**Response**: Part 3/3 completed (closing tags and scripts)

## Key Rules

✅ **DO**:
- Use `write` action for Part 1 (creates file)
- Use `append` action for Parts 2+ (adds to existing file)
- Split at logical boundaries (closing tags, section breaks)
- Report progress: "Part X/Y: [description]"
- Use proper newline escaping: `\n` not literal newlines

❌ **DON'T**:
- Write entire large file in one call (will truncate)
- Mix `write` and `append` in same turn without waiting
- Forget closing tags (will appear truncated)
- Use literal newlines in JSON strings - escape them as `\n`

## Example: Detecting When to Chunk

**File size indicators:**
```
- Short file (< 200 lines) → Use single `write` call
- Medium file (200-500 lines) → Split into 2-3 parts
- Large file (500+ lines) → Split into 3-4 parts
- Very large file (1000+ lines) → Split into 4+ parts
```

## Common Use Cases

### Large CSS File
```
Part 1: Reset, variables, base styles
Part 2: Layout, components
Part 3: Utilities, media queries
```

### Large JavaScript File
```
Part 1: Imports, constants, setup
Part 2: Main functions/classes
Part 3: Event handlers, exports
```

### Large Configuration
```
Part 1: Environment setup, first half of config
Part 2: Second half of config, settings
Part 3: Validation, closings
```

## Troubleshooting

**File appears truncated?**
- Check for unclosed tags `{`, `[`, `<`, or quotes `"`
- Ensure all parts were appended successfully
- Verify final file structure is complete

**Append fails with "file not found"?**
- Ensure Part 1 was created successfully with `write`
- File must exist before using `append`
- Check project path is correct

**Content missing?**
- Each part is independent - verify all parts completed
- Check for warnings about truncation in responses
- Some lines might be lost between parts if boundaries not clear

## Summary

**Large files = multiple sequential calls:**
1. **write** (Part 1) → creates file
2. **append** (Part 2+) → adds content
3. Report progress between parts

This prevents token-limit truncation and ensures complete files.

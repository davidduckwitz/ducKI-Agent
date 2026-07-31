# Skills Privacy & Control Guide

**Last Updated:** 2026-07-31  
**Feature:** Complete control over skill visibility, sync, and installation

---

## Overview

The Skills system now includes comprehensive privacy controls that let you:

1. **Control Public Sync** - Choose whether skills appear on the public landing page
2. **Hide Specific Skills** - Mark individual skills as private (won't sync)
3. **Enable/Disable Skills** - Control which skills are loaded and available
4. **Manage Installation** - View installation status and manage skill lifecycle

---

## Privacy Settings

### Global Privacy Controls

Access via **Skills Page → Privacy Settings** (gear icon)

#### 1. Sync to Public Landing Page

**Setting:** `SKILLS_SYNC_PUBLIC` (default: `true`)

When **enabled** ✓:
- All skills appear on https://ducki-ai-agent.davidduckwitz.de/
- Public users can discover and learn from your skills
- Good for sharing knowledge and community contribution

When **disabled** ✗:
- No skills sync to public landing page
- Maximum privacy - skills remain local only
- API still available but data doesn't appear on public site

**How to Toggle:**
1. Go to Skills Page
2. Click "Skills Privacy Settings" button
3. Toggle "Sync Skills to Public Landing Page"
4. Changes apply immediately

#### 2. Private Mode

**Setting:** `SKILLS_PRIVATE_MODE` (default: `false`)

When **enabled** 🔒:
- Indicates you have private skills you want protected
- UI shows visual indicator for hidden skills
- Useful for sensitive/proprietary skills

When **disabled** 🔓:
- All enabled skills available for normal operations
- Skills can be synchronized if sync is enabled

---

## Per-Skill Controls

### For Each Skill in the Editor

When you open a skill details, you'll see **Skill Controls & Privacy** panel with:

#### Enable/Disable

**Button:** Toggle between green (enabled) and gray (disabled)

| State | Meaning |
|-------|---------|
| 🟢 Enabled | Skill is loaded and available for agent use |
| ⚫ Disabled | Skill exists but is not loaded (inactive) |

**Use Cases:**
- Temporarily disable a skill without deleting it
- Test new skills without affecting production
- Reduce memory usage by disabling unused skills

#### Hide from Sync

**Button:** Toggle between eye (public) and eye-off (hidden)

| State | Meaning |
|-------|---------|
| 👁️ Public | Skill included in landing page sync if sync enabled |
| 🚫 Hidden | Skill never syncs to public, remains private |

**Use Cases:**
- Keep private implementations local only
- Hide sensitive workflows from public view
- Protect proprietary knowledge
- Mark experimental skills as private until ready

#### Delete

**Button:** Remove skill from system permanently

**Warning:** 🚨 Deletion is permanent and cannot be undone!

**Use Cases:**
- Remove outdated skills
- Clean up deprecated versions
- Delete experimental attempts

---

## How It Works

### Sync Flow

```
Skill Created/Updated
        ↓
SKILLS_SYNC_PUBLIC enabled?
        ↓ YES
Hidden Skill?
        ↓ NO
Added to Public Landing Page ✓
        ↓ YES (hidden)
Stays Local Only ✓
        ↓
NO (sync disabled)
Stays Local Only ✓
```

### Settings Storage

All privacy settings are stored in the agent's settings database:

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `SKILLS_SYNC_PUBLIC` | boolean | `true` | Global sync enable/disable |
| `SKILLS_PRIVATE_MODE` | boolean | `false` | Indicator for private skills |
| `SKILLS_HIDDEN` | JSON array | `[]` | List of hidden skill IDs |
| `ENABLED_SKILLS` | JSON array | `[]` | List of enabled skill IDs |
| `PINNED_SKILLS` | JSON array | `[]` | List of pinned skill IDs |
| `ALWAYS_LOAD_SKILLS` | JSON array | `[]` | Skills loaded at startup |

---

## Use Cases

### Use Case 1: Sharing Knowledge

**Goal:** Share useful skills with the community

**Steps:**
1. ✓ Enable global sync (`SKILLS_SYNC_PUBLIC = true`)
2. ✓ Create comprehensive skills with good documentation
3. ✓ Leave skills unmarked (not hidden)
4. ✓ Skills appear on public landing page
5. ✓ Users can learn and adapt your skills

**Result:** Community benefits, you get recognition for good skills

---

### Use Case 2: Keeping Internal Tools Private

**Goal:** Create internal scripts without public exposure

**Steps:**
1. ✓ Create internal skill (e.g., company-specific workflow)
2. ✓ Mark skill as "Hidden" 🚫
3. ✓ Keep global sync enabled or disabled (doesn't matter)
4. ✓ Skill stays in your system, never syncs
5. ✓ Only you see it on the landing page search

**Result:** Internal tools stay private, knowledge preserved locally

---

### Use Case 3: Experimental Features

**Goal:** Test new skills without affecting production

**Steps:**
1. ✓ Create new experimental skill
2. ✗ Leave disabled (gray button)
3. ✓ Test locally without it affecting agent
4. ✓ When ready: Enable + Unhide
5. ✓ Skill now active and synced

**Result:** Safe testing, no impact on production use

---

### Use Case 4: Mixed Public/Private Setup

**Goal:** Share some skills, keep others private

**Steps:**
1. ✓ Enable global sync (`SKILLS_SYNC_PUBLIC = true`)
2. ✓ For public skills: Leave unmarked 👁️
3. ✓ For private skills: Mark as hidden 🚫
4. ✓ SyncController respects hidden status
5. ✓ Only visible skills appear on public page

**Result:** Best of both - share helpful knowledge, protect sensitive content

---

## API Endpoints

### Privacy-Related Settings

```bash
# Check current privacy settings
GET /api/settings?key=SKILLS_SYNC_PUBLIC
GET /api/settings?key=SKILLS_PRIVATE_MODE
GET /api/settings?key=SKILLS_HIDDEN

# Disable public sync
POST /api/settings
  {
    "key": "SKILLS_SYNC_PUBLIC",
    "value": "false"
  }

# Mark skills as hidden
POST /api/settings
  {
    "key": "SKILLS_HIDDEN",
    "value": "[\"skill-id\", \"another-skill\"]"
  }
```

### Sync Behavior

```bash
# Manual sync (respects privacy settings)
GET /landing/api/v1.php?action=sync
# Respects: SKILLS_SYNC_PUBLIC, SKILLS_HIDDEN

# Query skills (filtered by privacy)
GET /landing/api/v1.php?action=skills
# Returns: Public + enabled skills only
```

---

## Troubleshooting

### Q: I hidden a skill but it still appears on landing page

**A:** Check two things:
1. Global sync is enabled - if disabled, nothing syncs anyway
2. Hidden list contains the skill ID - check in Settings

**Fix:**
```
Go to Skills → Privacy Settings → Hidden Skills
Verify your skill is in the list
If not there, click the skill and use Hide button
```

### Q: I want to make all skills private

**A:** Disable global sync:

```
Skills → Privacy Settings → Toggle off "Sync Skills to Public"
Result: No skills sync regardless of individual settings
```

### Q: I accidentally hidden a skill, how do I un-hide it?

**A:** Easy fix:

```
Skills → Privacy Settings → Scroll to "Hidden Skills"
Find your skill
Click "Unhide" button
Done!
```

### Q: Can I delete a hidden skill?

**A:** Yes, but recommended flow:

```
1. Unhide the skill first
2. Go to skill editor
3. Click Delete button
4. Confirm deletion
```

---

## Best Practices

### ✅ DO

- ✓ Review privacy settings before creating important skills
- ✓ Hide experimental skills until they're production-ready
- ✓ Document why a skill is hidden if it's sensitive
- ✓ Use "Disable" for temporary, "Hide" for privacy
- ✓ Periodically review your hidden skills
- ✓ Set sync to match your sharing philosophy

### ❌ DON'T

- ✗ Don't leave sensitive skills public by accident
- ✗ Don't assume disabled = private (it's not! Disabled just means inactive)
- ✗ Don't forget to unhide experimental skills when ready
- ✗ Don't share passwords/secrets in skill content (ever)
- ✗ Don't rely on hiding for security (encryption is better for secrets)

---

## Security Note

⚠️ **Important:**

**Hiding skills prevents them from syncing to the public landing page, but:**

1. They still exist in your local system
2. They're still sent to the agent executor
3. They're still stored in your database
4. Hiding ≠ Encryption

**If you have truly sensitive data:**
- Use encryption for secrets (`.env` files, config)
- Don't store credentials in skill content
- Use system environment variables instead

---

## Future Enhancements

Potential improvements for skills privacy:

- 🔄 Skill versioning (keep old versions private)
- 🔐 Encryption for sensitive skill content
- 📊 Privacy audit log (track sync history)
- 🔗 Skill dependencies (hide dependent skills when base is hidden)
- 🏷️ Tags for privacy categories (internal, experimental, public)

---

## Summary

| Feature | Purpose | Who Uses It |
|---------|---------|------------|
| Global Sync Toggle | Control all skills sync at once | Privacy-conscious users |
| Per-Skill Hide | Control individual skill privacy | Mixed public/private setups |
| Enable/Disable | Control skill loading | Testing, performance tuning |
| Hidden Skills List | View and manage private skills | Privacy management |

**End Result:** Complete control over what appears publicly while preserving local functionality.

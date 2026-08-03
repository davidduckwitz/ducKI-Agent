# Project Deletion Feature - Implementation Status

## Overview
Implemented project deletion with dependency confirmation dialog and selective deletion options.

**Status:** ✅ Functional with known issues

---

## What Works ✅

### Backend
- **GET `/api/projects/:id/dependencies`** - Returns dependency counts
  - `codingFolder` (boolean)
  - `conversationCount` (number)
  - `taskCount` (number)
  - `workflowCount` (number - currently 0)

- **DELETE `/api/projects/:id`** - Deletes project with selective options
  - Accepts request body with deletion options
  - Safely handles Foreign Key constraints
  - Deletes associated conversations, messages, archived conversations, tasks
  - Optionally deletes coding folder from filesystem

- **Database Service**
  - `getProjectDependencies(id)` - Queries and counts all dependencies
  - `deleteProject(id, options?)` - Cascading delete with optional flags
  - Foreign Key safe: Deletes archived_conversations before projects

### Frontend
- **Delete Dialog Component** (`ProjectDeleteDialog.tsx`)
  - Modal overlay with dark theme
  - Displays project name and ID
  - Shows checkboxes for each dependency type:
    - Projektverzeichnis (Coding) - enabled by default
    - Chats
    - Tasks
    - Workflows (placeholder)
  - Warning message: "Diese Aktion kann nicht rückgängig gemacht werden"
  - Cancel/Delete buttons with loading state

- **ProjectManager Component Updates**
  - Delete button (trash icon) on each project card
  - Opens dialog on click with aria-label="Projekt löschen"
  - Proper event handling with `stopPropagation()` and `preventDefault()`
  - Shows selected project info in dialog

- **API Client**
  - `api.projects.getDependencies(id)` - Fetch dependencies
  - `api.projects.delete(id, options)` - Delete with options

---

## Known Issues ❌

### Issue 1: Delete Button Unresponsiveness
**Problem:** Only the first (top) project's delete button works. Other project delete buttons don't respond to clicks.

**Symptoms:**
- Clicking delete button on 2nd+ projects: no dialog appears
- Console log "Delete clicked" doesn't fire
- First project deletion works correctly

**Possible Causes:**
1. React event delegation issue with map-rendered elements
2. CSS z-index or overflow issues masking button clicks
3. Parent component Click handler interfering with button event
4. Ref calculation issue with multiple interactive buttons in map

**Code Location:** `apps/web/src/components/projects/ProjectManager.tsx` lines 122-155

### Issue 2: Dependency Counts May Be Inaccurate
**Problem:** Dependency counts (Chats, Tasks) might not display correctly for all projects.

**Symptoms:**
- Dialog shows "Chats (0)" and "Tasks (0)" even if project has conversations
- useQuery for conversations/tasks only runs when `selectedProjectId` is set
- Delete dialog doesn't automatically select the project to load dependencies

**Code Location:** Lines 62-72 (conversations/tasks queries are selectedProjectId-dependent)

---

## Technical Details

### Files Modified/Created

**New Files:**
- `apps/web/src/components/projects/ProjectDeleteDialog.tsx` (comprehensive delete dialog)

**Modified Files:**
- `apps/web/src/components/projects/ProjectManager.tsx`
  - Added `projectToDelete` state
  - Added `deleteOptions` state
  - Added inline delete dialog (previously separate component)
  - Updated delete button with `stopPropagation()` and `preventDefault()`
  
- `apps/web/src/lib/api.ts`
  - Added `getDependencies(id)` method
  - Updated `delete(id, options)` to accept deletion options

- `packages/database/src/index.ts`
  - Added `getProjectDependencies()` method
  - Updated `deleteProject()` to accept selective deletion options
  - Added deletion of `archived_conversations` (Foreign Key safety)

- `apps/server/src/routes/projects.ts`
  - Added `GET /:id/dependencies` endpoint
  - Updated `DELETE /:id` to handle deletion options
  - Added filesystem cleanup for coding folder

### API Endpoints

```
GET /api/projects/:id/dependencies
Response: {
  success: true,
  data: {
    codingFolder: boolean,
    conversationCount: number,
    taskCount: number,
    workflowCount: number
  }
}

DELETE /api/projects/:id
Body: {
  deleteCodingFolder?: boolean,    // default: true
  deleteConversations?: boolean,   // default: false
  deleteTasks?: boolean,           // default: false
  deleteWorkflows?: boolean        // default: false
}
Response: { success: true, data: { deleted: true } }
```

---

## Reproduction Steps

### To Trigger Issue #1:
1. Open Projects page
2. Click "Projekt löschen" button on first project → Dialog appears ✅
3. Close dialog (click "Abbrechen")
4. Click "Projekt löschen" button on 2nd project → No dialog ❌

### To Verify Dependency Counts:
1. Open Projects page
2. Click "Projekt löschen" on any project
3. Check if "Chats (X)" and "Tasks (X)" show correct counts
4. Select a project first, then click delete to compare

---

## Next Steps / Fixes Required

### High Priority
1. **Fix Delete Button Event Handling**
   - Investigate React event delegation with mapped elements
   - Consider using event.target checks instead of relying on closure
   - Test with explicit key prop on map elements
   - May need to use useCallback with dependencies array

2. **Load Dependencies with Dialog**
   - When dialog opens, fetch dependencies via API
   - Display counts from API response, not from selectedProjectId queries
   - Show loading state while dependencies load

### Implementation Suggestions

**Option A: Use useCallback with Project ID**
```typescript
const handleDeleteClick = useCallback((projectId: number, projectName: string) => {
  setProjectToDelete({ id: projectId, name: projectName });
}, []);

// In map:
onClick={() => handleDeleteClick(project.id, project.name)}
```

**Option B: Separate Delete Endpoints**
- Create separate query for dependencies only when dialog opens
- Don't rely on global selectedProjectId state

**Option C: Event Delegation Fix**
- Move delete button outside map context
- Use dataset attributes to pass project ID
- Implement event delegation pattern

---

## Testing Checklist

- [ ] First project deletion works end-to-end
- [ ] 2nd-5th project deletion works end-to-end
- [ ] Last project deletion works end-to-end
- [ ] Dependency counts accurate for all projects
- [ ] Conversations deleted when checkbox selected
- [ ] Tasks deleted when checkbox selected
- [ ] Coding folder deleted when checkbox selected
- [ ] Dialog closes after successful deletion
- [ ] Project list updates after deletion
- [ ] Foreign key errors don't occur on delete

---

## References

**Related Code:**
- `packages/database/src/schema.ts` - Database schema with Foreign Keys
- `apps/server/src/routes/coding.ts` - CODING_ROOT constant
- `packages/database/src/index.ts` - DatabaseService class

**User Story:**
User requested: "überarbeite den projekt bereich. wenn ein projekt gelöscht wird, soll gefragt werden, ob abhängigkeiten auch gelöscht werden sollen"

---

## Status Summary

| Component | Status | Notes |
|-----------|--------|-------|
| Backend API | ✅ Working | All endpoints functional, tested with curl |
| Database Logic | ✅ Working | Foreign key handling correct |
| Dialog Component | ✅ Working | Displays correctly when triggered |
| First Project Delete | ✅ Working | Full end-to-end deletion works |
| Other Project Deletes | ❌ Broken | Event handling issue |
| Dependency Counts | ⚠️ Partial | Works for selected project only |
| Filesystem Cleanup | ✅ Working | Coding folder deleted correctly |

---

**Last Updated:** 2026-08-03  
**Session:** Claude Code Project Overhaul

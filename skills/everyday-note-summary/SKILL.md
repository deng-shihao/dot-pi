---
name: everyday-note-summary
description: >
  Organize and summarize daily notes into structured, searchable documents.
  Use when working with YYYY-MM-DD*.md files, or when user asks to process,
  organize, restructure, clean up, or summarize a daily note.
---

# Everyday Note Summary

## File Naming

Format: `YYYY-MM-DD-{brief-title}.md`

- ISO date prefix for sortable listing.
- Brief English title describing the main topic.

## Summary Block

Place at top of file, before original content:

```
YYYY-MM-DD: Title

Topics:
- topic: one-line description
- topic: one-line description
```

## Workflow

### 1. Read and Summarize
Read the full note. Write a structured summary block (see Summary Block above) and insert at file start.

### 2. Restructure
- Group related topics under `##` headings, `###` for subtopics.
- Merge scattered or duplicated content into one section.
- Preserve all facts and information.

### 3. Correct
Fix spelling and typos. Skip code blocks, links, and technical references.

### 4. Rename
Rename to `YYYY-MM-DD-{brief-title}.md` if it does not match.

## Edge Cases

- **No date in filename**: Extract from content (first line, metadata header, ctime). Fallback to `0000-00-00`.
- **No discernible topic**: Use broadest category (e.g. "notes").
- **Multiple files in session**: Process each file independently.
- **File already well-structured**: Only add summary block and rename if needed.

---
description: Create an architecture decision record in docs/decisions/NNNN-title.md.
---

Create an ADR for: $ARGUMENTS

1. Determine the next number: list `docs/decisions/`, find the highest `NNNN` prefix, increment (start at `0001` if the directory is empty or missing — create it if needed).
2. Slugify the title: `docs/decisions/NNNN-kebab-case-title.md`.
3. Write the ADR in exactly this format:

```markdown
# NNNN — <Title>

## Status
Accepted | Proposed | Superseded by NNNN

## Context
<Why this decision is needed. The forces at play. 2-6 sentences.>

## Decision
<What we decided. Concrete and specific.>

## Consequences
<What becomes easier, what becomes harder, what we now must do.>

## Alternatives considered
<Each rejected option with the one-line reason it lost.>

## Date
<YYYY-MM-DD>
```

4. Content rules: ground it in this project (real packages, real constraints from CLAUDE.md); no filler; if the decision is one the human must approve (CLAUDE.md §33 — auth method, LiveKit hosting, framework, database provider), set Status to `Proposed` and flag it for the human.
5. Report the file path and a two-line summary of the decision.

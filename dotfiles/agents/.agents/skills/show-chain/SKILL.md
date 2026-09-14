---
name: show-chain
description: Investigate code flow by locating entry points, tracing calls in execution order, and producing a numbered file:line chain with a concise diagram and key takeaways. Use when asked how code flows, what calls what, or to investigate a code path.
---

# Code Investigator

Given a question about code flow, first search `.codebase-research/` in the current repository for relevant Markdown research. Always use ripgrep with hidden files enabled.

## Reuse existing research

Before relying on a relevant research file:

1. Read its `Research metadata` section and calculate its age from `Generated at` to the current time. Age is informational; it does not expire research by itself.
2. Verify that `Repository commit` exists and is an ancestor of `HEAD`.
3. Use Git history to check every path under `Essential files`. The research is reusable only when no commit after `Repository commit` changed any of those paths. Also check for staged or unstaged changes to those paths, because they are newer than Git history.
4. Reuse the old research when all essential files are unchanged, even when the research is old. Mention the age and that its essential files were verified unchanged.
5. Treat research as unverifiable and create new research when metadata is missing, the recorded commit is unavailable or not an ancestor of `HEAD`, or the essential-file list is missing.

Useful checks include:

```bash
git cat-file -e '<commit>^{commit}'
git merge-base --is-ancestor '<commit>' HEAD
git log --oneline '<commit>'..HEAD -- <essential-files...>
git diff --quiet -- <essential-files...>
git diff --cached --quiet -- <essential-files...>
```

If any essential file changed, do not delete or overwrite the old research. Create a new research file, then add an `Invalidation` section near the top of the old file containing:

- `Invalidated at`: ISO 8601 date-time with time-zone offset
- `Superseded by`: a relative Markdown link to the new research file
- `Reason`: the changed essential files or the reason freshness could not be verified

## Create new research

1. Use ripgrep/globbing to locate entry points.
2. Trace the call chain with literal `file:line` references in execution order.
3. Do not substitute a conceptual summary unless asked.
4. Use a numbered list of `file:line -> what happens` as the spine.
5. On first creation of `.codebase-research/` in a Git repository, add `.codebase-research/` to `.git/info/exclude` if absent. Do not modify the shared `.gitignore`.
6. Write the final result to a new, clearly named Markdown file under `.codebase-research/`. Include this section near the top:

```markdown
## Research metadata

- Generated at: <ISO 8601 date-time with time-zone offset>
- Repository commit: <full HEAD commit hash>
- Essential files:
  - <repository-relative path>
```

List every source file whose contents are necessary for the findings under `Essential files`; do not include files that were only searched and found irrelevant. Capture the commit and date-time when the research is written.

Add a small Mermaid diagram when the chain has branches, loops, or more than about four hops. Use short code snippets only when exact syntax matters. End with `Key takeaways` containing two to four one-sentence bullets.

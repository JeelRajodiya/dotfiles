# Tool usages

- instead of `grep` prefer using `rg` (ripgrep) for searching through codebases, as it is faster and more efficient.

# Git Conventions

## Commits

- Never include an AI agent as coauthor in the commit message

# General

## Response

Answer directly and concisely. Answer what is asked only. Use CEFR-B2 as the text style for your responses.

## Code Investigation section

When asked to trace call chains, dependencies, or code flow, respond with literal file:line references in order. Do not substitute a high-level conceptual summary unless explicitly asked.
# graphify
- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`
When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

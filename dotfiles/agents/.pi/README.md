# Pi local additions

This README covers local capabilities that distinguish this setup from upstream; it is not an exhaustive upstream comparison.

## Agent teams

Dynamic, isolated child agents support orchestrator, tracer, worker, and reviewer roles. Workers are approval-gated; routing reuses suitable agents, auto-spawns when needed, and queues work when capacity is full. Model variants and profile families are defined in [`agent/agents/teams.yaml`](agent/agents/teams.yaml); see [`agent/extensions/agent-team.ts`](agent/extensions/agent-team.ts) and [`agent/extensions/lib/agent-defs.ts`](agent/extensions/lib/agent-defs.ts) for implementation. The YAML is the source for the full profile matrix.

<!-- Paste the GitHub attachment URL for the team variants screenshot here. -->

## Model selection

The `/model` picker fuzzy-matches models and ranks them by usage. It records usage and cost statistics, persists disabled-model state, and supports model cycling with `Ctrl+P`. See [`agent/extensions/usage-ranking.ts`](agent/extensions/usage-ranking.ts).

<!-- Paste the GitHub attachment URL for the model picker screenshot here. -->

## Context control

Context tools show remaining context or start a new context. Outgoing tool output is trimmed to stay within budget. See [`agent/extensions/tool-output-budget.ts`](agent/extensions/tool-output-budget.ts).

## Usage and cost telemetry

The footer shows Codex allowance and monthly cost. See [`agent/extensions/codex-usage.ts`](agent/extensions/codex-usage.ts) and [`agent/extensions/monthly-cost.ts`](agent/extensions/monthly-cost.ts).

## Install and sync

This repository is the source of truth for this configuration. Make changes here, then run:

```bash
bash bin/sync.sh
```

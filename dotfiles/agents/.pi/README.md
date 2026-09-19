# Pi local additions

How is this configuration different from the main stream agent harness like codex or claude? Below are some highlight features. 

## Agent teams

Dynamic, isolated child agents support orchestrator, tracer, worker, and reviewer roles. Workers are approval-gated; routing reuses suitable agents, auto-spawns when needed, and queues work when capacity is full. Model variants and profile families are defined in [`agent/agents/teams.yaml`](agent/agents/teams.yaml); see [`agent/extensions/agent-team.ts`](agent/extensions/agent-team.ts) and [`agent/extensions/lib/agent-defs.ts`](agent/extensions/lib/agent-defs.ts) for implementation. The YAML is the source for the full profile matrix.

<img width="2050" height="258" alt="image" src="https://github.com/user-attachments/assets/4bde8a73-3ce6-4f9f-9d7f-cec74e3e17e0" />

<img width="370" height="336" alt="image" src="https://github.com/user-attachments/assets/1bf64306-66c2-405b-9bac-c002ec813105" />

## Model selection

The `/model` picker fuzzy-matches models and ranks them by usage. It records usage and cost statistics, persists disabled-model state, and supports model cycling with `Ctrl+P`. See [`agent/extensions/usage-ranking.ts`](agent/extensions/usage-ranking.ts).

<img width="1390" height="528" alt="image" src="https://github.com/user-attachments/assets/a4a9b082-1805-4c46-a294-f07071af0919" />

## Context control

Context tools show remaining context or start a new context. Outgoing tool output is trimmed to stay within budget. See [`agent/extensions/tool-output-budget.ts`](agent/extensions/tool-output-budget.ts).

## Usage and cost telemetry

The footer shows Codex allowance and monthly cost. See [`agent/extensions/codex-usage.ts`](agent/extensions/codex-usage.ts) and [`agent/extensions/monthly-cost.ts`](agent/extensions/monthly-cost.ts).

## Install and sync

This repository is the source of truth for this configuration. Make changes here, then run:

```bash
bash bin/sync.sh
```

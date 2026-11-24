# Decision Inbox sessions

Read the [approved scope](docs/v1-spec.md), [typed contract](src/contract.ts), and [handoff with ownership and acceptance](docs/implementation-handoff.md) before work. Use this repo's AGENTS.md and the selected role file to establish authority. The development orchestrator chooses the appropriate role and the brief states the objective.

AI Native Migration is the development orchestrator. Claude Sonnet owns design, Claude Opus owns frontend implementation and separate frontend verification, and GPT/Codex sessions own backend implementation and independent backend verification. Use the three repo-local design skills under .claude/skills/. Follow the [frontend and plugin contract](docs/frontend-plugin-contract.md) when connecting the selected D design to live sources.

The owner-selected orchestrator writes owner-facing integration reports in Traditional Chinese. Specs, briefs, handoffs, design discussion with the owner, tests, and PRs are English. Use the shared fixtures for both FE and BE. Keep native delivery claims tied to the release gate.

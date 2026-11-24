# Decision Inbox sessions

Read the [approved scope](docs/v1-spec.md), [typed contract](src/contract.ts), and [handoff with ownership and acceptance](docs/implementation-handoff.md) before work. Use this repo's AGENTS.md and the selected role file to establish authority. The development orchestrator chooses the appropriate role and the brief states the objective.

The owner will select the development orchestrator later. The active Claude Sonnet session owns FE design with Execution Engine's `modern-web-guidance` and `frontend-patterns` skills at `/home/steven-tang/dev/repo/execution_engine/.agents/skills/<skill>/SKILL.md`. Leave in-flight UX decisions in that session. Use separate Claude Opus sessions for FE implementation and independent FE verification, and GPT/Codex sessions for BE implementation and BE verification.

The owner-selected orchestrator writes owner-facing integration reports in Traditional Chinese. Specs, briefs, handoffs, design discussion with the owner, tests, and PRs are English. Use the shared fixtures for both FE and BE. Keep native delivery claims tied to the release gate.

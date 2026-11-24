# Disposable desktop worker push probe

This separate trusted worker attempts the real documented Orca send command once per activation. The production Decision Inbox uses its own manifest and worker. This probe has no storage capability and sends only a generated synthetic code.

Run the experiment on a desktop with the matching Orca CLI, using a disposable runtime with no live Orca terminal panes. Keep that runtime free of terminal panes during the experiment. The CLI can infer a sender from a live terminal, so the probe checks the terminal inventory immediately before send and rejects inherited agent or terminal context. The operator shell can be outside Orca. From a shell on that desktop, with a disposable local workspace selected:

```sh
probe_dir="$PWD/diagnostics/desktop-push-probe"
orca plugin install "$probe_dir" --json
```

Review the reported capabilities and follow Orca's explicit approval instructions. Use the installed plugin key from the CLI. Keep a separate desktop shell for observation. Launch an ordinary disposable Codex Chat as follows, or use a supported Claude Chat in the same way.

```sh
orca agent launch --agent codex --surface chat --worktree current \
  --prompt "$(node --input-type=module -e 'import { prompt } from "./diagnostics/desktop-push-probe/protocol.mjs"; process.stdout.write(prompt)')" --json
```

1. Confirm the result is a structured Chat and copy its session UUID. In the desktop shell you may confirm that it posted `READY FOR DESKTOP PUSH PROBE` with `orca agent read orca_session_id:UUID --limit 10 --json`. The recipient must end that turn and perform zero tool calls, including mailbox checks.
2. Open the probe with `orca plugin open local.decision-inbox-push-probe --panel probe`. Enter `orca_session_id:UUID`, confirm the disposable Chat and click **Send one synthetic message**. The installed worker independently checks the exact initial prompt, exact ready response, local workspace/session binding, settled tool-free history, and single live Chat place before it invokes the CLI.
3. Save the JSON report from the panel. A send reports the child process exit status, CLI version, exact available error and message ID when accepted. `refused` indicates a CLI rejection. `unknown` indicates an ambiguous or incomplete CLI/process result. For either outcome, preserve the report and use a new Chat for another experiment.
4. Only after `accepted`, run `node "$probe_dir/observe.mjs" /path/to/saved-report.json` from the observer shell. The operator can run this read again if the new turn has yet to settle. The recipient stays passive. The observer requires the complete initial exchange, incoming mail with the same message ID and code, an exact assistant echo, and zero tool entries in the returned transcript. This is an observation of that transcript, separate from the CLI report. It creates no Inbox receipt.

The worker uses the installed bundled CLI when present and falls back to `orca` on PATH. Its send argv is exactly `orchestration send --to orca_session_id:UUID --type status --subject "Decision Inbox disposable push probe" --body INBOX-PUSH-… --json`. The subprocess inherits the worker context. The command contains no sender or environment override. Orca may refuse to resolve a sender in that context. The observed refusal on an identity-free headless shell was `no_active_sender_terminal`. On that same runtime the plugin service is unavailable, so this shell result does not predict the desktop worker outcome.

Offline checks:

```sh
node --test diagnostics/desktop-push-probe/probe.test.mjs
orca plugin validate diagnostics/desktop-push-probe --json
orca plugin check diagnostics/desktop-push-probe --json
```

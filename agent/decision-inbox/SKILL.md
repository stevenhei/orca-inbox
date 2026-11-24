---
name: decision-inbox
description: Submit a structured owner decision from an ordinary Orca workspace Chat.
---

Read applicable repository instructions and the selected role. Check prior decisions and resolve routine reversible choices within your authority. For a material choice, state the recommendation, alternatives, impact, blocked work, and relevant source links. Continue the work that can proceed.

Write a JSON object with stable `requestId`, `packageId`, `evidence`, `sourceLinks`, and `questions` fields using the repository's `SubmitDecision` contract. Use a unique request ID of 1–128 ASCII letters, digits, underscores or hyphens. Use link evidence and omit private bytes. Keep the marker under 32,768 characters.

Run `node /path/to/orca-inbox/agent/decision-inbox/inbox.mjs submit INPUT.json` from the originating Chat. Place its exact output as a line in your visible assistant response. The tool only queues a local lookup hint. Decision Inbox imports the request after the desktop Inbox reads and verifies that line in the originating Chat. Repeating the same IDs and contents is safe.

When documented Orca mail actually supplies a Decision Inbox reply, use its question ID and reply ID with a unique receipt ID. Run the same command with `ack` and a JSON object containing those three fields, and place the exact output line in the same Chat. A saved local answer alone supplies no mail. The inspected host has no supported plugin sender, so push delivery remains unavailable there.

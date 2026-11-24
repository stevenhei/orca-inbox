---
name: decision-inbox
description: Submit a structured owner decision from an ordinary Orca workspace Chat.
---

Read applicable repository instructions and the selected role. Check prior decisions and resolve routine reversible choices within your authority. For a material choice, state the recommendation, alternatives, impact, blocked work, and relevant source links. Continue the work that can proceed.

Write a JSON object with stable `requestId`, `packageId`, `evidence`, `sourceLinks`, and `questions` fields using the repository's `SubmitDecision` contract. Use a unique request ID of 1–128 ASCII letters, digits, underscores or hyphens. Use source links or explicitly stage local images. Keep private bytes out of the JSON and the Chat. Keep the marker under 32,768 characters.

Run `node /path/to/orca-inbox/agent/decision-inbox/inbox.mjs submit INPUT.json` from the originating Chat. Place its exact output as a line in your final assistant response to the current exchange. Open or refresh the Inbox before starting another exchange. The tool only queues a local lookup hint. Decision Inbox imports the request after the desktop Inbox reads and verifies that line in the originating Chat. Repeating the same IDs and contents is safe.

When documented Orca mail actually supplies a Decision Inbox reply, use its question ID and reply ID with a unique receipt ID. Run the same command with `ack` and a JSON object containing those three fields, and place the exact output line in the same Chat. A saved local answer alone supplies no mail. The inspected host has no supported plugin sender, so push delivery remains unavailable there.

## Ordered context

Use optional `description` for a separate Markdown overview of up to 16,384 UTF-16 code units. Use `background` for the original supporting Markdown, including headings, paragraphs, and HTTP(S) source links. Put command examples in fenced code blocks. They are text for the owner to read or copy. Keep selection anchors in raw Markdown UTF-16 offsets, including Markdown markers and line breaks.

When a trusted integration has granted an image snapshot, add its metadata to package `evidence` and insert it in the background with an optional `inlineImages` entry on the question. Supply the exact `evidenceId` and `version`, a zero-based UTF-16 `offset` into the unchanged background, and an optional plain-text `caption` of up to 1,024 characters. For an interior placement, insert before a nonblank, unindented top-level line after a blank line. Use a heading or paragraph as the next block. List items, continuations, quote lines and fenced code are not placement points. The document start and end also work outside fenced code. Order entries by offset and use array order when two share an offset. A question can place up to 20 images. Reviewers whose image access is unavailable see a placeholder.

For a local ordinary Chat, add the image-snapshot metadata to `INPUT.json` with a placeholder `attachmentId`. Run `node inbox.mjs submit INPUT.json --image EVIDENCE_ID VERSION LOCAL_PATH` with one flag group per image. The CLI reads only the local files you explicitly name, stages them privately, and replaces the placeholder with a content-bound ID. Paste only its emitted marker. The worker verifies the original Chat and reads only the staged bytes bound to that request, evidence ID and version. The original Chat and the desktop Inbox owner receive the attachment grant.

Stage up to eight PNG, JPEG, GIF or WebP images of at most 675,000 bytes each. Image containers and declared dimensions are checked before staging and again before intake. The dimension limit is 8,192 per side and 32 million pixels per canvas or declared frame. PNG checks also cover the legal header depth, color type and method values. The renderer handles pixel decoding. Local staging requires a filesystem that supports hard links. Concurrent staging uses bounded private slots. If staging is busy, let the Inbox finish intake or retry after expiration. Shared Inbox storage limits also apply. Missing or invalid staging keeps intake pending. Stage it again with the same contents or use an authorized source link. This intake requires the local workspace Chat and the same OS user as the desktop worker. Keep bytes, data URLs, file paths and credentials out of the marker. See the [synthetic fixture](../../fixtures/rich-context.ts) for the metadata format.

Use the optional `recommendedOptionId` only when one listed option is explicitly recommended. Keep any explanation in `recommendation`. Add existing GitHub issue, PR or Linear URLs to `sourceLinks` when the source material supplies them. The Inbox derives the original Chat identifier from verified origin metadata.

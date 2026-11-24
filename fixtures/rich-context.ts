import type { SubmitDecision } from '../src/contract.ts'

const beforeImage = '# Paper model review\n\nCompare the two folds in the [sample notes](https://example.test/sample).\n\n'
const afterImage = '## Example command\n\n```sh\nprintf "%s\\n" "paper sample"\n```\n\nChoose the easier fold.'

// Synthetic identifiers and metadata only. A trusted test boundary supplies snapshot bytes.
export const richContext: SubmitDecision = {
  requestId: 'rich-context-demo', packageId: 'rich-context-demo',
  sourceLinks: [{ label: 'Sample notes', url: 'https://example.test/sample' }],
  evidence: [{ kind: 'image-snapshot', evidenceId: 'fold-sample', version: 2, attachmentId: 'fixture-fold-v2',
    label: 'Fold sample', width: 800, height: 600, alt: 'Two paper folds side by side' }],
  questions: [{
    questionId: 'rich-context-question', title: 'Which fold should we use?', background: beforeImage + afterImage,
    inlineImages: [{ offset: beforeImage.length, evidenceId: 'fold-sample', version: 2, caption: 'Left: valley fold. Right: mountain fold.' }],
    recommendation: 'Choose the valley fold.', options: [{ optionId: 'valley', label: 'Valley fold' }],
    priority: 'P2', blockedWork: []
  }]
}

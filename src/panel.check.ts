import { defineCheck } from 'orca/testing'

// Renders for `orca plugin check`: the first open with no saved state, and a reopen with one
// answer already saved in the preview.
export default defineCheck({
  'first open': {},
  'reopen with a saved answer': {
    persisted: {
      plugin: {
        'preview.store': {
          seededAt: Date.parse('2026-01-05T10:00:00Z'),
          replies: {
            schedule: [{ replyId: 'preview-schedule-1', kind: 'initial', answer: { kind: 'option', optionId: 'tue' }, annotations: [], savedAt: Date.parse('2026-01-05T10:05:00Z') }],
          },
        },
      },
    },
  },
  dark: { theme: 'dark' },
})

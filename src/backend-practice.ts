import type { OrcaWorkerApi } from 'orca/worker'
import { InboxBackend } from './backend.ts'
import type { AgentCaller, InboxBoundary } from './backend.ts'
import type { OwnerCaller } from './backend-protocol.ts'
import { orcaStorage } from './backend-storage.ts'
import { InboxError } from './backend-validation.ts'
import { practicePrefix } from './contract.ts'
import type { QuestionInput, SubmitDecision } from './contract.ts'

const workspace = { hostId: 'practice:local', workspaceId: 'practice:inbox' }
export const practiceOwner: OwnerCaller = { kind: 'owner', id: 'practice:owner', workspaces: [workspace], repos: [] }
const source: AgentCaller = {
  kind: 'agent', id: 'practice:fixture', origin: { ...workspace, sessionId: 'practice:fixture' },
  policyOwnerId: practiceOwner.id, projectName: 'Practice', workspaceName: 'Practice Inbox', repo: 'practice'
}
const readers = [source.id, practiceOwner.id]
const imageEvidence = {
  kind: 'image-snapshot', evidenceId: 'practice:layout', attachmentId: 'practice:layout-v1',
  version: 1, label: '兩種海報版面', alt: '左側綠色版面以文字為主，右側紫色版面以圓形插圖為主。',
  width: 160, height: 96
} as const

// Synthetic layout diagram, 160 × 96 RGB PNG, bundled with the worker.
const layout = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABgCAIAAAAVRe7OAAABYklEQVR42u3dwQ3CIBiA0U7gPnp1CA91AI1bOZcDmHgw8WCi8eAEaqEIhb7km6DvQP4Cbfd83NVwnUcAWIAFWIAFWIAFGLBmCLzY9BUV+iBWy0NFAQYMGPAn4NPtOtnGA1/Or8kGGDBgwIABAwYMGDBgwIABAwYMOBlwnteQgAEDBgwYMGDAgAEDbgl42x+/Zw6udQ7+STueGXAx4CDdaGPABYAjaKOZAecGHqkbagwYMOB0wEl0g4wB5wNOqDvcGDBgwCmAk+sONC4JvN7tMwcYMGDAgK3BgAEDBgwYMGDAgAEbkwAD9i4asM0G+8H2g53ocKIDMGCnKgE7Fw3YzQZj0qzvJgFu/HYhYF/Z8ZUdwIABAwYMGDBgwICNSYCbA/73/3IAA7YGAwYMGDBgY5I5GDBgwIABAwYMGDBgwIABAwYMeOLAVRQNXEWAAQMGrAYCDFiABViABViABRiwAKuO3mr+Tak4yYUHAAAAAElFTkSuQmCC'

function question(id: string, title: string, background: string, fields: Partial<QuestionInput> = {}): QuestionInput {
  return { questionId: practicePrefix + id, title, background, priority: 'P2', recommendation: '', options: [], blockedWork: [], ...fields }
}

const packages: SubmitDecision[] = [
  {
    requestId: 'practice:poster-v1', packageId: 'practice:poster', summary: '同一張活動海報的三個問題，各自作答。',
    evidence: [imageEvidence], sourceLinks: [], questions: [
      question('poster-layout', '活動海報要用哪一款版面？', '## 比較版面\n\n考慮入口處的照明和觀眾的閱讀距離。', {
        description: '練習選擇一個方案，並補充理由。', priority: 'P0',
        options: [{ optionId: 'text', label: '左：文字優先' }, { optionId: 'image', label: '右：插圖優先' }],
        recommendedOptionId: 'text', recommendation: '資訊較多時，左側版面比較清楚。',
        inlineImages: [{ offset: 0, evidenceId: imageEvidence.evidenceId, version: 1, caption: '左：文字優先。右：插圖優先。' }]
      }),
      question('poster-copy', '請寫一句海報標題', '標題將與日期並排。請用一句話說明活動的重點。', { priority: 'P1' }),
      question('poster-note', '哪一條資訊需要補充？', '入場免費。座位有限，額滿為止。', {
        description: '主辦方尚未確認是否需要預約。請選取這段文字並加上註記。', priority: 'P1'
      })
    ]
  },
  {
    requestId: 'practice:studio-v1', packageId: 'practice:studio', summary: '以下是虛構的工作室安排。',
    evidence: [], sourceLinks: [], questions: [
      question('studio-slot', '週末排練選哪個時段？', '週六上午比較安靜，週日下午有更多人可出席。', {
        options: [{ optionId: 'sat', label: '週六上午' }, { optionId: 'sun', label: '週日下午' }]
      }),
      question('studio-summary', '如何回覆第一次來的訪客？', '請用兩句話說明如何報到，並提醒訪客帶水。'),
      question('studio-checklist', '哪些準備工作先做？', '目前有三項工作：清點材料、確認場地、發送提醒。請選取一句加註，或直接寫下順序。'),
      question('studio-label', '材料盒應該用哪一種標籤？', '大字適合遠看，圖示能幫助還不熟悉材料的人。', {
        priority: 'P3', options: [{ optionId: 'words', label: '大字標籤' }, { optionId: 'icons', label: '圖示加短文字' }]
      }),
      question('studio-retro', '下一次活動要保留什麼？', '寫一個想保留的做法與一個想調整的做法。', { priority: 'P3' })
    ]
  }
]

const boundary: InboxBoundary = {
  async grantSubmission(caller, input) {
    if (caller.id !== source.id) throw new InboxError('forbidden', 'Practice fixtures can only be seeded by the worker.')
    return { participantIds: readers, snapshots: input.evidence.length ? [{
      attachmentId: imageEvidence.attachmentId, readerIds: readers,
      image: { mimeType: 'image/png', base64: layout }
    }] : [] }
  },
  async canReadSnapshot(caller, binding) {
    return readers.includes(caller.id) && binding.evidence.attachmentId === imageEvidence.attachmentId
  },
  async send() { throw new Error('Practice does not use a delivery transport.') },
  async verifyReceipt() { return false }
}

export function createPractice(orca: OrcaWorkerApi) {
  const backend = new InboxBackend(orcaStorage(orca.storage, true), boundary, {
    practice: true, changed: () => orca.panels.post('practice.changed', {})
  })
  let seed: Promise<void> | undefined
  return {
    backend,
    ready() {
      return seed ??= (async () => {
        for (const input of packages) {
          const result = await backend.submitDecision(source, input)
          if (!result.ok) throw new InboxError(result.code, result.message)
        }
      })().catch(error => { seed = undefined; throw error })
    }
  }
}

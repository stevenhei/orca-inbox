export const hintDirectory: string
export const hintPattern: RegExp
export function hints(): Promise<string[]>
export function removeHint(name: string): Promise<void>
export function localOrca(args: string[]): Promise<unknown>
export function writeReference(workspace: string, reference: { questionId: string } | { view: 'settings' }): Promise<string>

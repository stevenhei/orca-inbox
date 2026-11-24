export const hintDirectory: string
export const hintPattern: RegExp
export function hints(): Promise<string[]>
export function scanHints(): Promise<{ names: string[]; truncated: boolean }>
export function removeHint(name: string): Promise<void>
export function localOrca(args: string[], environment?: string, runtimeId?: string): Promise<unknown>
export function writeReference(workspace: string, reference: { questionId: string } | { view: 'settings' }): Promise<string>

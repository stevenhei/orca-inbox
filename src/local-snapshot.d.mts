import type { Evidence } from './contract.ts'
import type { PrivateSnapshot } from './backend-protocol.ts'

export function isLocalSnapshotId(value: string): boolean
export function readLocalSnapshot(session: string, request: string, evidence: Extract<Evidence, {kind: 'image-snapshot'}>): Promise<PrivateSnapshot>
export function clearLocalSnapshots(session: string, request: string, evidence: Evidence[]): Promise<void>

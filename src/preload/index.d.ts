export interface CopyResult {
  machine: string
  status: 'ok' | 'failed'
  exitCode: number
  newFiles: number
  elapsedSeconds: number
  error?: string
}

export interface ProbeResult {
  exists: boolean
  files: number
  bytes: number
  error?: string
}

export interface Api {
  probeSource: (srcPath: string) => Promise<ProbeResult>
  startCopy: (job: {
    src: string
    template: string
    machines: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  onCopyStatus: (cb: (data: { machine: string; status: 'running' }) => void) => () => void
  onCopyResult: (cb: (data: CopyResult) => void) => () => void
  onCopyLine: (cb: (data: { machine: string; text: string }) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}

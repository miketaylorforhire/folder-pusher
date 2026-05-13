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

export interface Profile {
  name: string
  src: string
  template: string
  destinations: string
  updatedAt: string
}

export interface Api {
  probeSource: (srcPath: string) => Promise<ProbeResult>
  pickSource: (currentPath?: string) => Promise<string | null>
  startCopy: (job: {
    src: string
    template: string
    machines: string[]
  }) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>
  cancelCopy: () => Promise<void>
  onCopyStatus: (cb: (data: { machine: string; status: 'running' }) => void) => () => void
  onCopyResult: (cb: (data: CopyResult) => void) => () => void
  onCopyLine: (cb: (data: { machine: string; text: string }) => void) => () => void
  profiles: {
    list: () => Promise<Profile[]>
    save: (p: Omit<Profile, 'updatedAt'>) => Promise<Profile[]>
    delete: (name: string) => Promise<Profile[]>
  }
  isPackaged: () => Promise<boolean>
  uninstall: () => Promise<{ ok: boolean; error?: string }>
}

declare global {
  interface Window {
    api: Api
  }
}

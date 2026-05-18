import { contextBridge, ipcRenderer } from 'electron'

interface CopyResult {
  machine: string
  status: 'ok' | 'failed'
  exitCode: number
  newFiles: number
  elapsedSeconds: number
  error?: string
}

type SourceType = 'folder' | 'file'

interface Profile {
  name: string
  src: string
  template: string
  destinations: string
  sourceType?: SourceType
  updatedAt: string
}

const api = {
  probeSource: (srcPath: string) => ipcRenderer.invoke('source:probe', srcPath),
  pickSource: (currentPath?: string, sourceType: SourceType = 'folder'): Promise<string | null> =>
    ipcRenderer.invoke('source:pick', currentPath, sourceType),
  startCopy: (job: {
    src: string
    template: string
    machines: string[]
    sourceType: SourceType
  }) => ipcRenderer.invoke('copy:start', job),
  cancelCopy: (): Promise<void> => ipcRenderer.invoke('copy:cancel'),
  onCopyStatus: (cb: (data: { machine: string; status: 'running' }) => void) => {
    const listener = (_e: unknown, data: { machine: string; status: 'running' }) => cb(data)
    ipcRenderer.on('copy:status', listener)
    return () => ipcRenderer.removeListener('copy:status', listener)
  },
  onCopyResult: (cb: (data: CopyResult) => void) => {
    const listener = (_e: unknown, data: CopyResult) => cb(data)
    ipcRenderer.on('copy:result', listener)
    return () => ipcRenderer.removeListener('copy:result', listener)
  },
  onCopyLine: (cb: (data: { machine: string; text: string }) => void) => {
    const listener = (_e: unknown, data: { machine: string; text: string }) => cb(data)
    ipcRenderer.on('copy:line', listener)
    return () => ipcRenderer.removeListener('copy:line', listener)
  },
  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),
    save: (p: Omit<Profile, 'updatedAt'>): Promise<Profile[]> =>
      ipcRenderer.invoke('profiles:save', p),
    delete: (name: string): Promise<Profile[]> => ipcRenderer.invoke('profiles:delete', name)
  },
  isPackaged: (): Promise<boolean> => ipcRenderer.invoke('app:is-packaged'),
  uninstall: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('app:uninstall'),
  getLaunchSource: (): Promise<string | null> => ipcRenderer.invoke('app:get-launch-source'),
  onExternalSource: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string): void => cb(path)
    ipcRenderer.on('source:external', listener)
    return () => ipcRenderer.removeListener('source:external', listener)
  },
  onCloseAttempt: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:close-attempt', listener)
    return () => ipcRenderer.removeListener('app:close-attempt', listener)
  },
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirm-close'),
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: (url: string) => ipcRenderer.invoke('update:install', url)
  }
}

contextBridge.exposeInMainWorld('api', api)

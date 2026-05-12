import { contextBridge, ipcRenderer } from 'electron'

interface CopyResult {
  machine: string
  status: 'ok' | 'failed'
  exitCode: number
  newFiles: number
  elapsedSeconds: number
  error?: string
}

const api = {
  probeSource: (srcPath: string) => ipcRenderer.invoke('source:probe', srcPath),
  startCopy: (job: { src: string; template: string; machines: string[] }) =>
    ipcRenderer.invoke('copy:start', job),
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
  }
}

contextBridge.exposeInMainWorld('api', api)

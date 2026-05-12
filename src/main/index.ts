import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { stat, readdir } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function probeSource(srcPath: string): Promise<{
  exists: boolean
  files: number
  bytes: number
  error?: string
}> {
  try {
    const s = await stat(srcPath)
    if (!s.isDirectory()) {
      return { exists: false, files: 0, bytes: 0, error: 'Path is not a directory' }
    }
    let files = 0
    let bytes = 0
    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.isFile()) {
          const fs = await stat(full)
          files++
          bytes += fs.size
        }
      }
    }
    await walk(srcPath)
    return { exists: true, files, bytes }
  } catch (err) {
    return { exists: false, files: 0, bytes: 0, error: (err as Error).message }
  }
}

interface CopyJob {
  src: string
  template: string
  machines: string[]
}

interface CopyResult {
  machine: string
  status: 'ok' | 'failed'
  exitCode: number
  newFiles: number
  elapsedSeconds: number
  error?: string
}

let activeJob = false

function runRobocopyForMachine(src: string, dst: string, machine: string): Promise<CopyResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const args = [
      src,
      dst,
      '/E', '/XC', '/XN', '/XO', '/Z',
      '/R:2', '/W:5', '/MT:8',
      '/NP', '/NDL', '/NJH', '/NJS'
    ]
    const proc = spawn('robocopy', args, { windowsHide: true })
    let newFiles = 0
    let stderr = ''

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      newFiles += text.split(/\r?\n/).filter((l) => l.trim().length > 0).length
      mainWindow?.webContents.send('copy:line', { machine, text })
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    proc.on('close', (code) => {
      const exitCode = code ?? -1
      const elapsedSeconds = Math.round((Date.now() - start) / 1000)
      const status: 'ok' | 'failed' = exitCode < 8 ? 'ok' : 'failed'
      resolve({
        machine,
        status,
        exitCode,
        newFiles,
        elapsedSeconds,
        error: status === 'failed' ? stderr.trim() || `robocopy exit ${exitCode}` : undefined
      })
    })
    proc.on('error', (err) => {
      resolve({
        machine,
        status: 'failed',
        exitCode: -1,
        newFiles: 0,
        elapsedSeconds: Math.round((Date.now() - start) / 1000),
        error: err.message
      })
    })
  })
}

ipcMain.handle('source:probe', (_e, srcPath: string) => probeSource(srcPath))

ipcMain.handle('copy:start', async (_e, job: CopyJob) => {
  if (activeJob) return { ok: false, error: 'A copy job is already running' }
  activeJob = true
  try {
    const folderName = basename(job.src)
    for (const machine of job.machines) {
      mainWindow?.webContents.send('copy:status', { machine, status: 'running' })
      const dstBase = job.template.replace(/\{machine\}/g, machine)
      const dst = join(dstBase, folderName)
      const result = await runRobocopyForMachine(job.src, dst, machine)
      mainWindow?.webContents.send('copy:result', result)
    }
    return { ok: true }
  } finally {
    activeJob = false
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

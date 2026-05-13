import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { stat, readdir } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfiles, saveProfile, deleteProfile, type Profile } from './profiles.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

interface WindowState {
  x: number
  y: number
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState | null {
  try {
    const raw = readFileSync(windowStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {
    // first run or corrupt file — fall through
  }
  return null
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    writeFileSync(windowStatePath(), JSON.stringify({ x: bounds.x, y: bounds.y }))
  } catch {
    // best-effort; ignore failures
  }
}

function createWindow(): void {
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: 900,
    height: 820,
    x: saved?.x,
    y: saved?.y,
    show: false,
    autoHideMenuBar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#1a2030',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('moved', saveWindowState)
  mainWindow.on('close', saveWindowState)

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

async function pickSourceFolder(defaultPath?: string): Promise<string | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'treatPackageAsDirectory'],
    title: 'Select source folder',
    defaultPath: defaultPath || undefined
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
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
let activeProc: ChildProcess | null = null
let cancelRequested = false

function runRobocopyForMachine(src: string, dst: string, machine: string): Promise<CopyResult> {
  const start = Date.now()
  return new Promise((resolve) => {
    const args = [
      src,
      dst,
      '/E', '/XC', '/XN', '/Z',
      '/R:2', '/W:5', '/MT:8',
      '/NP', '/NDL', '/NJH', '/NJS'
    ]
    const proc = spawn('robocopy', args, { windowsHide: true })
    activeProc = proc
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
      const wasCancelled = cancelRequested
      activeProc = null
      const exitCode = code ?? -1
      const elapsedSeconds = Math.round((Date.now() - start) / 1000)
      const status: 'ok' | 'failed' =
        wasCancelled || exitCode < 0 || exitCode >= 8 ? 'failed' : 'ok'
      const error = wasCancelled
        ? 'Cancelled by user.'
        : status === 'failed'
          ? stderr.trim() || `robocopy exit ${exitCode}`
          : undefined
      resolve({ machine, status, exitCode, newFiles, elapsedSeconds, error })
    })
    proc.on('error', (err) => {
      activeProc = null
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
ipcMain.handle('source:pick', (_e, currentPath?: string) => pickSourceFolder(currentPath))

ipcMain.handle('copy:start', async (_e, job: CopyJob) => {
  if (activeJob) return { ok: false, error: 'A copy job is already running' }
  activeJob = true
  cancelRequested = false
  try {
    const folderName = basename(job.src)
    for (const machine of job.machines) {
      if (cancelRequested) break
      mainWindow?.webContents.send('copy:status', { machine, status: 'running' })
      const dstBase = job.template.replace(/\{machine\}/g, machine)
      const dst = join(dstBase, folderName)
      const result = await runRobocopyForMachine(job.src, dst, machine)
      mainWindow?.webContents.send('copy:result', result)
    }
    return { ok: true, cancelled: cancelRequested }
  } finally {
    activeJob = false
    activeProc = null
  }
})

ipcMain.handle('copy:cancel', () => {
  cancelRequested = true
  if (activeProc) {
    activeProc.kill()
  }
})

ipcMain.handle('profiles:list', () => loadProfiles())
ipcMain.handle('profiles:save', (_e, profile: Omit<Profile, 'updatedAt'>) => saveProfile(profile))
ipcMain.handle('profiles:delete', (_e, name: string) => deleteProfile(name))

ipcMain.handle('app:is-packaged', () => app.isPackaged)
ipcMain.handle('app:uninstall', () => {
  if (!app.isPackaged) {
    return { ok: false, error: 'Uninstall is only available in the installed app.' }
  }
  const exeDir = dirname(app.getPath('exe'))
  const uninstaller = join(exeDir, 'Uninstall.exe')
  spawn(uninstaller, ['--uninstall'], { detached: true, stdio: 'ignore' }).unref()
  setTimeout(() => app.quit(), 150)
  return { ok: true }
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

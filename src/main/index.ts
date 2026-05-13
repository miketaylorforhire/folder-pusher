import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { stat, readdir, mkdir, copyFile, chmod } from 'node:fs/promises'
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
let cancelRequested = false

// Walk a directory tree, yielding files relative to the base.
async function* walkFiles(base: string, rel = ''): AsyncGenerator<string> {
  const here = rel ? join(base, rel) : base
  let entries
  try {
    entries = await readdir(here, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}\\${entry.name}` : entry.name
    if (entry.isDirectory()) {
      yield* walkFiles(base, childRel)
    } else if (entry.isFile()) {
      yield childRel
    }
  }
}

// Mtime tolerance for "same time" — SMB/FAT may round to 2-second precision.
const MTIME_TOLERANCE_MS = 2000

function emit(machine: string, text: string): void {
  mainWindow?.webContents.send('copy:line', { machine, text })
}

async function runCopyForMachine(src: string, dst: string, machine: string): Promise<CopyResult> {
  const start = Date.now()
  emit(machine, `> node-copy "${src}" -> "${dst}"\r\n`)

  let copied = 0
  let skipped = 0
  let failed = 0
  const errors: string[] = []

  try {
    await mkdir(dst, { recursive: true })
  } catch (err) {
    emit(machine, `[error] mkdir dest: ${(err as Error).message}\r\n`)
    return {
      machine,
      status: 'failed',
      exitCode: -1,
      newFiles: 0,
      elapsedSeconds: Math.round((Date.now() - start) / 1000),
      error: `Failed to create destination: ${(err as Error).message}`
    }
  }

  for await (const relPath of walkFiles(src)) {
    if (cancelRequested) {
      emit(machine, '[cancelled]\r\n')
      return {
        machine,
        status: 'failed',
        exitCode: -1,
        newFiles: copied,
        elapsedSeconds: Math.round((Date.now() - start) / 1000),
        error: 'Cancelled by user.'
      }
    }

    const srcFile = join(src, relPath)
    const dstFile = join(dst, relPath)

    let srcStat
    try {
      srcStat = await stat(srcFile)
    } catch (err) {
      emit(machine, `[error] stat src ${relPath}: ${(err as Error).message}\r\n`)
      failed++
      errors.push(`${relPath}: ${(err as Error).message}`)
      continue
    }

    let dstStat
    try {
      dstStat = await stat(dstFile)
    } catch {
      dstStat = null
    }

    // Decide whether to copy.
    // Rule: size differs ⇒ content differs ⇒ copy (regardless of mtime).
    //       size matches  ⇒ trust mtime: src newer copies, src older skips.
    // We don't rely on mtime alone because a file dropped into the source via
    // a tool that preserved the origin mtime can be "older than dest" by
    // filesystem time but obviously different by content (different size).
    let action: 'copy' | 'skip'
    let reason: string
    if (!dstStat) {
      action = 'copy'
      reason = 'new'
    } else if (srcStat.size !== dstStat.size) {
      action = 'copy'
      reason = `size differs (${dstStat.size} -> ${srcStat.size} bytes)`
    } else {
      const dtime = srcStat.mtimeMs - dstStat.mtimeMs
      if (Math.abs(dtime) <= MTIME_TOLERANCE_MS) {
        action = 'skip'
        reason = 'same'
      } else if (dtime > 0) {
        action = 'copy'
        reason = `newer (src ${srcStat.mtime.toISOString()} > dst ${dstStat.mtime.toISOString()})`
      } else {
        action = 'skip'
        reason = `older (src ${srcStat.mtime.toISOString()} < dst ${dstStat.mtime.toISOString()})`
      }
    }

    if (action === 'skip') {
      emit(machine, `[skip ${reason}] ${relPath}\r\n`)
      skipped++
      continue
    }

    // Ensure parent dir exists.
    try {
      await mkdir(dirname(dstFile), { recursive: true })
    } catch (err) {
      emit(machine, `[error] mkdir ${dirname(relPath)}: ${(err as Error).message}\r\n`)
      failed++
      errors.push(`${relPath}: ${(err as Error).message}`)
      continue
    }

    // If destination exists, clear read-only attribute so copyFile can overwrite.
    if (dstStat) {
      try {
        await chmod(dstFile, 0o666)
      } catch {
        // best-effort; copyFile will fail clearly if it really can't write
      }
    }

    try {
      await copyFile(srcFile, dstFile)
      emit(machine, `[copy ${reason}] ${relPath}\r\n`)
      copied++
    } catch (err) {
      emit(machine, `[error] copy ${relPath}: ${(err as Error).message}\r\n`)
      failed++
      errors.push(`${relPath}: ${(err as Error).message}`)
    }
  }

  const elapsedSeconds = Math.round((Date.now() - start) / 1000)
  const status: 'ok' | 'failed' = failed > 0 ? 'failed' : 'ok'
  emit(machine, `\r\n[done — copied ${copied}, skipped ${skipped}, failed ${failed}, ${elapsedSeconds}s]\r\n`)
  return {
    machine,
    status,
    exitCode: failed,
    newFiles: copied,
    elapsedSeconds,
    error: errors.length ? errors.slice(0, 3).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '') : undefined
  }
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
      const result = await runCopyForMachine(job.src, dst, machine)
      mainWindow?.webContents.send('copy:result', result)
    }
    return { ok: true, cancelled: cancelRequested }
  } finally {
    activeJob = false
  }
})

ipcMain.handle('copy:cancel', () => {
  cancelRequested = true
})

ipcMain.handle('profiles:list', () => loadProfiles())
ipcMain.handle('profiles:save', (_e, profile: Omit<Profile, 'updatedAt'>) => saveProfile(profile))
ipcMain.handle('profiles:delete', (_e, name: string) => deleteProfile(name))

const RELEASES_REPO = 'miketaylorforhire/FolderPusher-releases'

interface GhAsset { name: string; browser_download_url: string }
interface GhRelease { tag_name?: string; assets?: GhAsset[] }

ipcMain.handle('update:check', async () => {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'FolderPusher' }
    })
    if (!res.ok) return { ok: false, error: `GitHub API returned ${res.status}` }
    const data = (await res.json()) as GhRelease
    const latest = (data.tag_name ?? '').replace(/^v/, '')
    const current = app.getVersion()
    const asset = (data.assets ?? []).find((a) => /Setup.*\.exe$/i.test(a.name))
    return {
      ok: true,
      current,
      latest,
      hasUpdate: !!latest && latest !== current,
      downloadUrl: asset?.browser_download_url ?? null
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('update:install', async (_e, url: string) => {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) return { ok: false, error: `Download failed: HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const tmpPath = join(app.getPath('temp'), 'FolderPusher-Update.exe')
    writeFileSync(tmpPath, buf)
    spawn(tmpPath, ['--upgrade'], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 150)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

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

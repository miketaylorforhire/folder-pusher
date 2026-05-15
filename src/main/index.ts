import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { spawn } from 'node:child_process'
import { stat, readdir, mkdir, copyFile, chmod, utimes } from 'node:fs/promises'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfiles, saveProfile, deleteProfile, type Profile } from './profiles.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

// A source folder passed on the command line (e.g. by WhoPlayedThat's
// "Export to FolderPusher" button) — captured at launch, handed to the
// renderer once it asks for it via app:get-launch-source.
let pendingSourceArg: string | null = null

// Scan argv for the first entry that's an existing directory. In a packaged
// app argv is [exePath] or [exePath, "<folder>"]; flags are skipped.
function extractFolderArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue
    try {
      if (statSync(a).isDirectory()) return a
    } catch {
      // not an existing path — skip
    }
  }
  return null
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

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

type SourceType = 'folder' | 'file'

// Probe a source path. Auto-detects whether it's a file or a folder and
// reports `kind` so the renderer can sync its Folder/File toggle to match.
async function probeSource(srcPath: string): Promise<{
  exists: boolean
  kind?: SourceType
  files: number
  bytes: number
  error?: string
}> {
  try {
    const s = await stat(srcPath)
    if (s.isFile()) {
      return { exists: true, kind: 'file', files: 1, bytes: s.size }
    }
    if (!s.isDirectory()) {
      return { exists: false, files: 0, bytes: 0, error: 'Path is not a file or folder' }
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
    return { exists: true, kind: 'folder', files, bytes }
  } catch (err) {
    return { exists: false, files: 0, bytes: 0, error: (err as Error).message }
  }
}

async function pickSource(
  defaultPath: string | undefined,
  sourceType: SourceType
): Promise<string | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties:
      sourceType === 'file' ? ['openFile'] : ['openDirectory', 'treatPackageAsDirectory'],
    title: sourceType === 'file' ? 'Select source file' : 'Select source folder',
    defaultPath: defaultPath || undefined
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
}

interface CopyJob {
  src: string
  template: string
  machines: string[]
  sourceType?: SourceType
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

type FileOutcome = 'copied' | 'skipped' | 'failed'

// Copy a single file with the newer-wins decision. `relLabel` is what shows in
// the per-machine log (a relative path for folder copies, a bare filename for
// file copies). Failures are pushed onto `errors` and reported as 'failed'.
async function copyOneFile(
  srcFile: string,
  dstFile: string,
  relLabel: string,
  machine: string,
  errors: string[]
): Promise<FileOutcome> {
  let srcStat
  try {
    srcStat = await stat(srcFile)
  } catch (err) {
    emit(machine, `[error] stat src ${relLabel}: ${(err as Error).message}\r\n`)
    errors.push(`${relLabel}: ${(err as Error).message}`)
    return 'failed'
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
    emit(machine, `[skip ${reason}] ${relLabel}\r\n`)
    return 'skipped'
  }

  // Ensure parent dir exists.
  try {
    await mkdir(dirname(dstFile), { recursive: true })
  } catch (err) {
    emit(machine, `[error] mkdir ${dirname(relLabel)}: ${(err as Error).message}\r\n`)
    errors.push(`${relLabel}: ${(err as Error).message}`)
    return 'failed'
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
    // Preserve source mtime/atime on the destination — fs.copyFile doesn't
    // do this, so without utimes the dest gets mtime=now and the dest file's
    // metadata no longer matches the source it came from.
    try {
      await utimes(dstFile, srcStat.atime, srcStat.mtime)
    } catch (err) {
      emit(machine, `[warn] utimes ${relLabel}: ${(err as Error).message}\r\n`)
    }
    emit(machine, `[copy ${reason}] ${relLabel}\r\n`)
    return 'copied'
  } catch (err) {
    emit(machine, `[error] copy ${relLabel}: ${(err as Error).message}\r\n`)
    errors.push(`${relLabel}: ${(err as Error).message}`)
    return 'failed'
  }
}

function summarize(
  machine: string,
  start: number,
  copied: number,
  skipped: number,
  failed: number,
  errors: string[]
): CopyResult {
  const elapsedSeconds = Math.round((Date.now() - start) / 1000)
  emit(machine, `\r\n[done — copied ${copied}, skipped ${skipped}, failed ${failed}, ${elapsedSeconds}s]\r\n`)
  return {
    machine,
    status: failed > 0 ? 'failed' : 'ok',
    exitCode: failed,
    newFiles: copied,
    elapsedSeconds,
    error: errors.length
      ? errors.slice(0, 3).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '')
      : undefined
  }
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
    const outcome = await copyOneFile(join(src, relPath), join(dst, relPath), relPath, machine, errors)
    if (outcome === 'copied') copied++
    else if (outcome === 'skipped') skipped++
    else failed++
  }

  return summarize(machine, start, copied, skipped, failed, errors)
}

// Copy a single source file into `dstDir` (the machine-substituted template),
// keeping its filename. The folder path's leaf is appended by the caller; for
// a file copy the file itself is the leaf.
async function runCopyForFile(srcFile: string, dstDir: string, machine: string): Promise<CopyResult> {
  const start = Date.now()
  const name = basename(srcFile)
  const dstFile = join(dstDir, name)
  emit(machine, `> node-copy "${srcFile}" -> "${dstFile}"\r\n`)

  if (cancelRequested) {
    emit(machine, '[cancelled]\r\n')
    return {
      machine,
      status: 'failed',
      exitCode: -1,
      newFiles: 0,
      elapsedSeconds: 0,
      error: 'Cancelled by user.'
    }
  }

  try {
    await mkdir(dstDir, { recursive: true })
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

  const errors: string[] = []
  const outcome = await copyOneFile(srcFile, dstFile, name, machine, errors)
  return summarize(
    machine,
    start,
    outcome === 'copied' ? 1 : 0,
    outcome === 'skipped' ? 1 : 0,
    outcome === 'failed' ? 1 : 0,
    errors
  )
}

ipcMain.handle('source:probe', (_e, srcPath: string) => probeSource(srcPath))
ipcMain.handle('source:pick', (_e, currentPath: string | undefined, sourceType?: SourceType) =>
  pickSource(currentPath, sourceType ?? 'folder')
)

ipcMain.handle('copy:start', async (_e, job: CopyJob) => {
  if (activeJob) return { ok: false, error: 'A copy job is already running' }
  activeJob = true
  cancelRequested = false
  // Accumulate the per-machine results and return them in the response. The
  // renderer used to count statuses off its `rows` array after the await, but
  // the final `copy:result` event isn't guaranteed to land before the IPC
  // return resolves — leaving the last machine stuck at 'running'.
  const results: CopyResult[] = []
  try {
    const sourceType: SourceType = job.sourceType ?? 'folder'
    const leafName = basename(job.src)
    for (const machine of job.machines) {
      if (cancelRequested) break
      mainWindow?.webContents.send('copy:status', { machine, status: 'running' })
      const dstBase = job.template.replace(/\{machine\}/g, machine)
      const result =
        sourceType === 'file'
          ? await runCopyForFile(job.src, dstBase, machine)
          : await runCopyForMachine(job.src, join(dstBase, leafName), machine)
      results.push(result)
      mainWindow?.webContents.send('copy:result', result)
    }
    return { ok: true, cancelled: cancelRequested, results }
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

ipcMain.handle('app:get-launch-source', () => {
  const s = pendingSourceArg
  pendingSourceArg = null
  return s
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

// Single-instance lock: a second launch (e.g. WhoPlayedThat invoking
// FolderPusher.exe "<album folder>" while it's already open) hands its argv
// to the running instance instead of starting a new window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    const folder = extractFolderArg(argv)
    if (folder) mainWindow?.webContents.send('source:external', folder)
  })

  app.whenReady().then(() => {
    pendingSourceArg = extractFolderArg(process.argv)
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

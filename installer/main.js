const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const ofs = require('original-fs');
const path = require('path');
const os = require('os');

const APP_DISPLAY_NAME = 'FolderPusher';
const APP_FOLDER_NAME = 'FolderPusher';
const APP_EXE_NAME = 'FolderPusher.exe';
const APP_USERDATA_NAME = 'folderpusher';
const APP_VERSION = '0.1.11';
const UNINSTALL_REG_KEY = 'FolderPusher';
const SHORTCUT_NAME = 'FolderPusher.lnk';

const isUninstall = process.argv.includes('--uninstall');
const isUpgrade = process.argv.includes('--upgrade');

app.setAppUserModelId('com.folderpusher.installer');

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 720,
    height: 460,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#1a2030',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (isUninstall) win.webContents.send('mode', 'uninstall');
    else if (isUpgrade) win.webContents.send('mode', 'upgrade');
  });
  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 250);
  });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('window:close', () => win && win.close());
ipcMain.handle('window:minimize', () => win && win.minimize());

ipcMain.handle('install:default-dir', () => {
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', APP_FOLDER_NAME);
});

ipcMain.handle('install:pick-folder', async (_evt, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return path.join(res.filePaths[0], APP_FOLDER_NAME);
});

ipcMain.handle('install:disk-space', (_evt, targetDir) => {
  try {
    const drive = path.parse(targetDir).root.replace(/\\$/, '');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        `(Get-PSDrive -Name '${drive.charAt(0)}').Free`,
      ], (err, stdout) => {
        if (err) return resolve(null);
        const bytes = Number(stdout.trim());
        resolve(Number.isFinite(bytes) ? bytes : null);
      });
    });
  } catch {
    return null;
  }
});

ipcMain.handle('install:run', (evt, targetDir) => runInstallInto(evt, targetDir));

ipcMain.handle('install:shortcuts', (_evt, targetDir, createDesktop) =>
  createShortcutsImpl(targetDir, createDesktop)
);

ipcMain.handle('install:register-uninstall', (_evt, targetDir) =>
  registerUninstallImpl(targetDir)
);

async function runInstallInto(evt, targetDir) {
  // Kill any running instance so we can overwrite locked .exe/.pak/.dll files.
  // taskkill is a no-op if the app isn't running, and the helper swallows
  // errors either way. Short sleep gives Windows time to release the handles.
  await killRunningApp();
  await sleep(600);

  const JSZip = require('jszip');
  const payloadPath = path.join(process.resourcesPath, 'payload', 'payload.zip');
  if (!fs.existsSync(payloadPath)) {
    let diag = '';
    try {
      const parent = path.dirname(payloadPath);
      diag = fs.existsSync(parent)
        ? `dir contents: ${fs.readdirSync(parent).join(', ') || '(empty)'}`
        : `parent missing: ${parent}`;
    } catch (e) { diag = `(diag failed: ${e.message})`; }
    throw new Error(
      `Payload not found.\n`
      + `  resourcesPath: ${process.resourcesPath}\n`
      + `  payloadPath:   ${payloadPath}\n`
      + `  ${diag}`
    );
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(payloadPath));
  ofs.mkdirSync(targetDir, { recursive: true });

  const entries = Object.values(zip.files);
  const fileEntries = entries.filter((e) => !e.dir);
  const total = fileEntries.length;
  let done = 0;

  for (const entry of entries) {
    const outPath = path.join(targetDir, entry.name);
    if (entry.dir) {
      ofs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    ofs.mkdirSync(path.dirname(outPath), { recursive: true });
    const buf = await entry.async('nodebuffer');
    ofs.writeFileSync(outPath, buf);
    done++;
    if (done % 3 === 0 || done === total) {
      evt.sender.send('install:progress', { pct: done / total, file: entry.name });
    }
  }
  evt.sender.send('install:progress', { pct: 1, file: '' });
  return true;
}

async function createShortcutsImpl(targetDir, createDesktop) {
  const exePath = path.join(targetDir, APP_EXE_NAME);
  const startMenuDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs'
  );
  const desktopDir = path.join(os.homedir(), 'Desktop');
  fs.mkdirSync(startMenuDir, { recursive: true });
  await makeShortcut(exePath, path.join(startMenuDir, SHORTCUT_NAME), APP_DISPLAY_NAME);
  if (createDesktop) {
    await makeShortcut(exePath, path.join(desktopDir, SHORTCUT_NAME), APP_DISPLAY_NAME);
  }
  return true;
}

async function registerUninstallImpl(targetDir) {
  const installerDest = path.join(targetDir, 'Uninstall.exe');
  const source = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    ofs.copyFileSync(source, installerDest);
  } catch (e) {
    console.error('Could not copy uninstaller', e);
  }
  const iconPath = path.join(targetDir, APP_EXE_NAME);
  const sizeKb = Math.floor(dirSize(targetDir) / 1024);
  const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REG_KEY}`;
  const entries = [
    ['DisplayName', 'REG_SZ', APP_DISPLAY_NAME],
    ['DisplayVersion', 'REG_SZ', APP_VERSION],
    ['Publisher', 'REG_SZ', 'Mike Taylor'],
    ['DisplayIcon', 'REG_SZ', iconPath],
    ['InstallLocation', 'REG_SZ', targetDir],
    ['UninstallString', 'REG_SZ', `"${installerDest}" --uninstall`],
    ['QuietUninstallString', 'REG_SZ', `"${installerDest}" --uninstall --silent`],
    ['NoModify', 'REG_DWORD', '1'],
    ['NoRepair', 'REG_DWORD', '1'],
    ['EstimatedSize', 'REG_DWORD', String(sizeKb)],
  ];
  for (const [name, type, value] of entries) {
    await regAdd(regKey, name, type, value);
  }
  return true;
}

ipcMain.handle('install:launch', async (_evt, targetDir) => {
  const exePath = path.join(targetDir, APP_EXE_NAME);
  shell.openPath(exePath);
  setTimeout(() => app.quit(), 500);
});

ipcMain.handle('uninstall:find', async () => findExistingInstall());
ipcMain.handle('upgrade:find', async () => findExistingInstall());

ipcMain.handle('upgrade:run', async (evt, targetDir) => {
  await killRunningApp();
  await sleep(800);
  await runInstallInto(evt, targetDir);
  await createShortcutsImpl(targetDir, false);
  await registerUninstallImpl(targetDir);
  return true;
});

function findExistingInstall() {
  return new Promise((resolve) => {
    const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REG_KEY}`;
    execFile('reg.exe', ['query', regKey, '/v', 'InstallLocation'], (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/InstallLocation\s+REG_SZ\s+(.+)/i);
      resolve(m ? m[1].trim() : null);
    });
  });
}

ipcMain.handle('uninstall:run', async (_evt, installDir, wipeData) => {
  await killRunningApp();
  await sleep(600);
  try {
    await rmrf(installDir);
  } catch (e) {
    console.error('rmrf failed', e);
  }
  await removeShortcuts();
  const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UNINSTALL_REG_KEY}`;
  await regDelete(regKey);
  if (wipeData) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const candidates = [APP_USERDATA_NAME, APP_DISPLAY_NAME];
    for (const name of candidates) {
      try { await rmrf(path.join(appData, name)); }
      catch (e) { console.warn('wipe userData failed for', name, e); }
    }
  }
  return true;
});

function makeShortcut(target, lnkPath, description) {
  return new Promise((resolve, reject) => {
    const escape = (s) => s.replace(/'/g, "''");
    const script = [
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${escape(lnkPath)}')`,
      `$s.TargetPath = '${escape(target)}'`,
      `$s.WorkingDirectory = '${escape(path.dirname(target))}'`,
      `$s.Description = '${escape(description)}'`,
      `$s.IconLocation = '${escape(target)},0'`,
      `$s.Save()`,
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-Command', script], (err) => {
      err ? reject(err) : resolve();
    });
  });
}

function removeShortcuts() {
  const startMenu = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', SHORTCUT_NAME
  );
  const desktop = path.join(os.homedir(), 'Desktop', SHORTCUT_NAME);
  for (const p of [startMenu, desktop]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  return Promise.resolve();
}

function regAdd(key, name, type, value) {
  return new Promise((resolve, reject) => {
    const args = ['add', key, '/v', name, '/t', type, '/d', value, '/f'];
    execFile('reg.exe', args, (err) => (err ? reject(err) : resolve()));
  });
}

function regDelete(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['delete', key, '/f'], () => resolve());
  });
}

function killRunningApp() {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', '/IM', APP_EXE_NAME], () => resolve());
  });
}

function rmrf(p) {
  return ofs.promises.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dirSize(p) {
  let total = 0;
  try {
    for (const entry of ofs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(full);
      else if (entry.isFile()) total += ofs.statSync(full).size;
    }
  } catch { /* ignore */ }
  return total;
}

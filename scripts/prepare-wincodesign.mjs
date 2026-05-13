import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const VERSION = 'winCodeSign-2.6.0';
const ARCHIVE_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${VERSION}/${VERSION}.7z`;

const CACHE_BASE =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
    : path.join(os.homedir(), '.cache', 'electron-builder', 'winCodeSign');

const TARGET_DIR = path.join(CACHE_BASE, VERSION);
const ARCHIVE_PATH = path.join(CACHE_BASE, `${VERSION}.7z`);

const MARKER_FILES = [
  path.join('windows-10', 'x64', 'signtool.exe'),
  path.join('windows-10', 'ia32', 'signtool.exe'),
];

function hasExtractedCache() {
  if (!fs.existsSync(TARGET_DIR)) return false;
  return MARKER_FILES.some((rel) => fs.existsSync(path.join(TARGET_DIR, rel)));
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const handle = (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, handle).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      pipeline(res, out).then(resolve, reject);
    };
    https.get(url, handle).on('error', reject);
  });
}

function findSevenZ() {
  const roots = [process.cwd(), path.dirname(new URL(import.meta.url).pathname)];
  for (const root of roots) {
    for (const sub of ['node_modules/7zip-bin/win/x64/7za.exe', '../node_modules/7zip-bin/win/x64/7za.exe']) {
      const candidate = path.resolve(root, sub);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[prepare-wincodesign] not on Windows, skipping');
    return;
  }

  if (hasExtractedCache()) {
    console.log('[prepare-wincodesign] cache already valid at', TARGET_DIR);
    return;
  }

  fs.mkdirSync(CACHE_BASE, { recursive: true });

  if (!fs.existsSync(ARCHIVE_PATH)) {
    console.log('[prepare-wincodesign] downloading', VERSION);
    await downloadFile(ARCHIVE_URL, ARCHIVE_PATH);
  }

  const sevenZ = findSevenZ();
  if (!sevenZ) {
    throw new Error('7za.exe not found — run `npm install` first');
  }

  console.log('[prepare-wincodesign] extracting (excluding *.dylib symlinks)...');
  if (fs.existsSync(TARGET_DIR)) {
    fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  const result = spawnSync(
    sevenZ,
    ['x', '-snld', '-bd', '-y', '-xr!*.dylib', ARCHIVE_PATH, `-o${TARGET_DIR}`],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    throw new Error(`7za exited with code ${result.status}`);
  }

  if (!hasExtractedCache()) {
    throw new Error('Extraction completed but signtool.exe not found in expected path');
  }

  console.log('[prepare-wincodesign] cache ready at', TARGET_DIR);
}

main().catch((e) => {
  console.error('[prepare-wincodesign] failed:', e.message || e);
  console.error('');
  console.error('Fallback: enable Windows Developer Mode (Settings → Privacy & Security → For developers → Developer Mode)');
  console.error('         or run `npm run package` from an elevated PowerShell, then try again.');
  process.exit(1);
});

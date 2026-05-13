import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const installerDir = join(repoRoot, 'installer');
const payloadDir = join(installerDir, 'payload');
const payloadZip = join(payloadDir, 'payload.zip');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const unpackedDir = join(repoRoot, 'release', version, 'win-unpacked');

// Auto-detect the self-signed PFX. electron-builder picks up WIN_CSC_LINK +
// WIN_CSC_KEY_PASSWORD from the environment for both the main-app `--dir`
// build and the installer build. Without these set, the resulting exes are
// unsigned and Smart App Control blocks the installer.
const pfxPath = resolve(repoRoot, 'build', 'codesign', 'folderpusher-selfsigned.pfx');
const signEnv = { ...process.env };
if (existsSync(pfxPath) && !signEnv.WIN_CSC_LINK) {
  signEnv.WIN_CSC_LINK = pfxPath;
  signEnv.WIN_CSC_KEY_PASSWORD = process.env.FOLDERPUSHER_CERT_PASSWORD || 'changeme';
  console.log(`[build-installer] signing with ${pfxPath}`);
} else if (!existsSync(pfxPath)) {
  console.log('[build-installer] no code-signing cert found — building unsigned');
  console.log('                  (run `npm run cert:generate` once to enable signing)');
}

const run = (cmd, cwd, label, env = process.env) => {
  console.log(`\n▸ ${label}`);
  console.log(`  $ ${cmd}  (cwd: ${relative(repoRoot, cwd) || '.'})`);
  const res = spawnSync(cmd, { cwd, shell: true, stdio: 'inherit', env });
  if (res.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${res.status}).`);
    process.exit(res.status || 1);
  }
};

function cleanDir(p) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push({ full, rel: relative(base, full).replace(/\\/g, '/') });
  }
  return out;
}

async function zipDir(srcDir, destZip) {
  const zip = new JSZip();
  const files = walk(srcDir);
  for (const f of files) {
    const data = readFileSync(f.full);
    zip.file(f.rel, data, { compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  writeFileSync(destZip, buf);
  return { count: files.length, bytes: buf.length };
}

// -- 1. Build icon (idempotent if already current)
run('npm run icon', repoRoot, 'Build app icon');

// -- 2. Build the main app renderer + main process
run('npm run build', repoRoot, 'Build main app (electron-vite)');

// -- 3. Produce win-unpacked/ using electron-builder with --dir override
run('npx electron-builder --win --x64 --dir', repoRoot, 'Package main app (dir)', signEnv);
if (!existsSync(unpackedDir)) {
  console.error(`Expected unpacked dir at ${unpackedDir} but did not find it.`);
  process.exit(1);
}

// -- 4. Zip the unpacked app into installer/payload/payload.zip
console.log('\n▸ Zipping payload');
cleanDir(payloadDir);
const { count, bytes } = await zipDir(unpackedDir, payloadZip);
console.log(`  packed ${count} files → ${(bytes / 1024 / 1024).toFixed(1)} MB`);

// -- 5. Copy resources the installer needs at build time
console.log('\n▸ Staging installer assets');
copyFileSync(join(repoRoot, 'build', 'icon.ico'), join(installerDir, 'icon.ico'));
copyFileSync(join(repoRoot, 'title.svg'), join(installerDir, 'title.svg'));
const favicon256 = join(repoRoot, 'build', 'favicon-256.png');
if (existsSync(favicon256)) {
  copyFileSync(favicon256, join(installerDir, 'favicon-256.png'));
}

// -- 6. Ensure installer node_modules exist
if (!existsSync(join(installerDir, 'node_modules'))) {
  run('npm install', installerDir, 'Install installer dependencies');
}

// -- 7. Build the installer exe
run('npx electron-builder --win --x64', installerDir, 'Build installer exe', signEnv);

const outDir = join(repoRoot, 'release', 'installer');
console.log(`\n✓ Done. Look in ${relative(repoRoot, outDir)}\\`);

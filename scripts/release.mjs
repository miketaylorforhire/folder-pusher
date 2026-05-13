// Releases v$VERSION (read from package.json) end-to-end:
//   1. Build the installer if missing
//   2. Push the git tag to origin (creating it if needed)
//   3. Create the GitHub release in FolderPusher-releases
//   4. Upload the installer asset
// Idempotent: skip any step that's already done.
//
// Release notes: pass --notes-file=PATH (markdown), or fall back to the body of
// the most recent commit on HEAD (skipping the subject line).

import { execSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const RELEASES_REPO = 'miketaylorforhire/FolderPusher-releases';

// Chunk size for the LFS-pipe fallback. Small enough that per-stream TLS
// corruption probability is low even on flaky middleware. 9MB is empirically
// safe.
const CHUNK_SIZE = 9 * 1024 * 1024;

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? '');
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const installerPath = join(repoRoot, 'release', 'installer', 'FolderPusher Setup.exe');
// The installer file lives at a version-agnostic path — every build overwrites
// the same file. To know whether the on-disk installer is for THIS version, we
// check (a) the per-version unpacked dir exists (created during build) AND
// (b) the installer is newer than that dir.
const versionUnpackedDir = join(repoRoot, 'release', version, 'win-unpacked');

function run(cmd, opts = {}) {
  const res = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`\nx command failed: ${cmd}`);
    process.exit(res.status || 1);
  }
}

function out(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function tryOut(cmd) {
  try { return out(cmd); } catch { return null; }
}

function ok(label) {
  console.log(`* ${label}`);
}

function step(label) {
  console.log(`\n> ${label}`);
}

function getNotes() {
  const notesFile = args.get('notes-file');
  if (notesFile) {
    const p = resolve(repoRoot, notesFile);
    if (!existsSync(p)) {
      console.error(`x notes file not found: ${p}`);
      process.exit(1);
    }
    return readFileSync(p, 'utf8');
  }
  // Default: body of HEAD commit (everything after the subject line).
  const body = tryOut('git log -1 --pretty=%b HEAD') ?? '';
  return body.trim() || `Release ${tag}.`;
}

// Step 1 — installer
step(`Installer for ${tag}`);
const installerFresh = (() => {
  if (!existsSync(installerPath) || !existsSync(versionUnpackedDir)) return false;
  return statSync(installerPath).mtimeMs > statSync(versionUnpackedDir).mtimeMs;
})();
let installerWasRebuilt = false;
if (installerFresh) {
  const sz = (statSync(installerPath).size / 1024 / 1024).toFixed(1);
  ok(`installer for ${tag} present (${sz} MB) — skip build`);
} else {
  installerWasRebuilt = true;
  if (!existsSync(installerPath)) {
    console.log('  installer not found; running npm run package');
  } else if (!existsSync(versionUnpackedDir)) {
    console.log(`  installer file exists but ${versionUnpackedDir} does not — `
      + `that installer is from a different version; rebuilding.`);
  } else {
    console.log(`  installer is older than ${versionUnpackedDir} — likely a `
      + `partial build left a stale EXE; rebuilding.`);
  }
  run('npm run package');
  if (!existsSync(installerPath) || !existsSync(versionUnpackedDir)) {
    console.error(`x installer still missing after build: ${installerPath}`);
    process.exit(1);
  }
  if (statSync(installerPath).mtimeMs <= statSync(versionUnpackedDir).mtimeMs) {
    console.error(`x installer mtime is not newer than ${versionUnpackedDir} `
      + `after build — something's wrong.`);
    process.exit(1);
  }
}

// Step 2 — git tag + push
step(`Git tag ${tag}`);
const localTag = tryOut(`git tag --list ${tag}`);
if (!localTag) {
  run(`git tag ${tag}`);
  ok(`created local tag ${tag}`);
} else {
  ok(`local tag ${tag} exists`);
}

const remoteTag = tryOut(`git ls-remote --tags origin refs/tags/${tag}`);
if (!remoteTag) {
  run('git push origin HEAD');
  run(`git push origin ${tag}`);
  ok(`pushed ${tag} to origin`);
} else {
  ok(`remote tag ${tag} exists — skip push`);
}

// Step 3 — GitHub release in the releases repo
step(`GitHub release ${tag} in ${RELEASES_REPO}`);
const existing = tryOut(`gh release view ${tag} --repo ${RELEASES_REPO} --json tagName --jq .tagName`);
if (!existing) {
  const notes = getNotes();
  const res = spawnSync(
    'gh',
    ['release', 'create', tag, '--repo', RELEASES_REPO, '--title', `${tag}`, '--notes-file', '-'],
    { cwd: repoRoot, input: notes, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  if (res.status !== 0) {
    console.error(`x gh release create failed (exit ${res.status})`);
    process.exit(res.status || 1);
  }
  ok(`created release ${tag}`);
} else {
  ok(`release ${tag} exists — skip create`);
}

// Step 4 — upload installer asset
step(`Upload installer to ${tag}`);
const assetsJson = tryOut(`gh release view ${tag} --repo ${RELEASES_REPO} --json assets`) ?? '{}';
let haveAsset = false;
try {
  const parsed = JSON.parse(assetsJson);
  haveAsset = (parsed.assets || []).some((a) => /Setup.*\.exe$/i.test(a.name || ''));
} catch {
  // fall through; we'll just try to upload
}
if (haveAsset && !installerWasRebuilt) {
  ok('installer already attached — skip upload');
} else {
  if (haveAsset && installerWasRebuilt) {
    console.log('  asset is attached but installer was just rebuilt — re-uploading with --clobber');
  }
  uploadInstaller();
}

console.log(`\n* Release ${tag} live: https://github.com/${RELEASES_REPO}/releases/tag/${tag}`);

// === Upload helpers ==========================================================

function uploadInstaller() {
  const directAttempts = 3;
  for (let n = 1; n <= directAttempts; n++) {
    console.log(`  direct upload attempt ${n}/${directAttempts}…`);
    const res = spawnSync(
      'gh',
      ['release', 'upload', tag, installerPath, '--repo', RELEASES_REPO, '--clobber'],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    if (res.status === 0) {
      ok('installer uploaded (direct)');
      return;
    }
    console.log(`  attempt ${n} failed.`);
  }
  console.log('  direct upload exhausted — falling back to chunked-LFS-pipe via CI workflow.');
  uploadViaChunkedLfsPipe();
}

function uploadViaChunkedLfsPipe() {
  const tmp = mkdtempSync(join(tmpdir(), 'fp-pipe-'));
  const cloneDir = join(tmp, 'FolderPusher-releases');
  const branch = `pipe/${tag}`;
  console.log(`  workspace: ${tmp}`);

  try {
    run(`git clone --depth=1 https://github.com/${RELEASES_REPO}.git "${cloneDir}"`);

    const wfPath = join(cloneDir, '.github', 'workflows', 'upload-asset.yml');
    if (!existsSync(wfPath)) {
      console.error(
        `\nx Chunked-LFS-pipe fallback requires .github/workflows/upload-asset.yml in ${RELEASES_REPO}.\n`
        + `  See scripts/release-pipe-workflow.yml for the template — copy it to that path,\n`
        + `  commit + push to main of the releases repo, then re-run \`npm run release\`.`,
      );
      process.exit(1);
    }

    runIn(cloneDir, `git checkout -b ${branch}`);
    runIn(cloneDir, 'git lfs install --local');
    runIn(cloneDir, 'git lfs track "installer.part-*"');

    const installerName = basename(installerPath);
    const totalSize = statSync(installerPath).size;
    const sha = sha256OfFile(installerPath);
    const chunks = splitIntoChunks(installerPath, cloneDir);
    const manifest = {
      name: installerName,
      size: totalSize,
      sha256: sha,
      chunkCount: chunks.length,
      chunkSize: CHUNK_SIZE,
      parts: chunks.map((c) => ({ file: c.name, size: c.size })),
    };
    writeFileSync(join(cloneDir, 'INSTALLER_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(cloneDir, 'RELEASE_TAG'), tag + '\n');
    console.log(`  split installer (${(totalSize / 1024 / 1024).toFixed(1)} MB) into ${chunks.length} chunks of up to ${(CHUNK_SIZE / 1024 / 1024)} MB`);

    runIn(cloneDir, 'git add .gitattributes RELEASE_TAG INSTALLER_MANIFEST.json installer.part-*');
    runIn(cloneDir,
      'git -c user.email=release@folderpusher.local -c user.name="FolderPusher Release" '
      + `commit -m "pipe: ${tag} installer (${chunks.length} chunks) for workflow assembly"`);

    let pushed = false;
    for (let n = 1; n <= 5; n++) {
      console.log(`  LFS push attempt ${n}/5 (${chunks.length} chunks)…`);
      const res = spawnSync('git', ['push', 'origin', branch], { cwd: cloneDir, stdio: 'inherit' });
      if (res.status === 0) { pushed = true; break; }
      console.log(`  push attempt ${n} failed.`);
    }
    if (!pushed) {
      console.error('x LFS push failed after 5 attempts.');
      process.exit(1);
    }

    console.log('  waiting for upload-asset workflow to run…');
    waitForWorkflow();

    const refresh = tryOut(`gh release view ${tag} --repo ${RELEASES_REPO} --json assets`);
    const parsed = JSON.parse(refresh || '{}');
    const landed = (parsed.assets || []).some((a) => /Setup.*\.exe$/i.test(a.name || ''));
    if (!landed) {
      console.error(`x workflow finished but no installer asset on ${tag} — check workflow logs.`);
      process.exit(1);
    }
  } finally {
    tryOut(`gh api -X DELETE repos/${RELEASES_REPO}/git/refs/heads/${branch}`);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log('* installer uploaded (chunked-LFS-pipe via CI)');
}

function sha256OfFile(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let offset = 0;
    let n = 0;
    while ((n = readSync(fd, buf, 0, buf.length, offset)) > 0) {
      hash.update(buf.subarray(0, n));
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function splitIntoChunks(srcPath, outDir) {
  const total = statSync(srcPath).size;
  const fd = openSync(srcPath, 'r');
  const out = [];
  try {
    const buf = Buffer.alloc(CHUNK_SIZE);
    let offset = 0;
    let idx = 0;
    while (offset < total) {
      const toRead = Math.min(CHUNK_SIZE, total - offset);
      const n = readSync(fd, buf, 0, toRead, offset);
      const name = `installer.part-${String(idx + 1).padStart(4, '0')}`;
      writeFileSync(join(outDir, name), buf.subarray(0, n));
      out.push({ name, size: n });
      offset += n;
      idx += 1;
    }
  } finally {
    closeSync(fd);
  }
  return out;
}

function runIn(dir, cmd) {
  const res = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nx command failed in ${dir}: ${cmd}`);
    process.exit(res.status || 1);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForWorkflow() {
  const start = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000;
  let runId = null;
  while (Date.now() - start < TIMEOUT_MS) {
    const list = tryOut(
      `gh run list --repo ${RELEASES_REPO} --workflow upload-asset.yml --limit 5 --json databaseId,status,conclusion,headBranch`,
    );
    if (list) {
      try {
        const runs = JSON.parse(list);
        const candidate = runs.find((r) => r.headBranch === `pipe/${tag}`);
        if (candidate) {
          runId = candidate.databaseId;
          if (candidate.status === 'completed') {
            if (candidate.conclusion === 'success') {
              console.log(' ✓');
              return;
            }
            console.error(`\nx workflow concluded with: ${candidate.conclusion}`);
            process.exit(1);
          }
        }
      } catch { /* ignore parse */ }
    }
    process.stdout.write('.');
    sleepSync(5000);
  }
  console.error(`\nx timed out waiting for workflow${runId ? ` run ${runId}` : ''}.`);
  process.exit(1);
}

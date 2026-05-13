// One-off: upload a release asset via Node's https (different TLS stack than
// gh's Go and curl's Schannel). Usage:
//   node scripts/upload-asset.mjs <release-id> <file-path> <name>
import { request } from 'node:https';
import { statSync, createReadStream } from 'node:fs';
import { execSync } from 'node:child_process';

const [, , releaseId, filePath, assetName] = process.argv;
if (!releaseId || !filePath || !assetName) {
  console.error('Usage: node scripts/upload-asset.mjs <release-id> <file-path> <name>');
  process.exit(2);
}

const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
const size = statSync(filePath).size;
console.log(`Uploading ${(size / 1024 / 1024).toFixed(1)} MB → release ${releaseId}`);

const req = request(
  {
    method: 'POST',
    hostname: 'uploads.github.com',
    path: `/repos/miketaylorforhire/FolderPusher-releases/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'User-Agent': 'fp-uploader',
      Accept: 'application/vnd.github+json',
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log(`HTTP ${res.statusCode}`);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const j = JSON.parse(body);
          console.log(`✓ uploaded: ${j.name} (${j.size} bytes) — ${j.browser_download_url}`);
        } catch {
          console.log(body.slice(0, 500));
        }
      } else {
        console.error(body.slice(0, 500));
        process.exit(1);
      }
    });
  },
);

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

let sent = 0;
const stream = createReadStream(filePath);
stream.on('data', (chunk) => {
  sent += chunk.length;
  if (sent % (16 * 1024 * 1024) < chunk.length) {
    process.stdout.write(`\r  ${(sent / 1024 / 1024).toFixed(0)} / ${(size / 1024 / 1024).toFixed(0)} MB`);
  }
});
stream.on('end', () => process.stdout.write('\n'));
stream.pipe(req);

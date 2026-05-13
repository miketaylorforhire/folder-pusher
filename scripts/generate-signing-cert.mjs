import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const outDir = join(repoRoot, 'build', 'codesign')
const pfxPath = join(outDir, 'folderpusher-selfsigned.pfx')
const cerPath = join(outDir, 'folderpusher-selfsigned.cer')
const subject = 'CN=FolderPusher (Self-Signed)'

const password = process.env.FOLDERPUSHER_CERT_PASSWORD || 'changeme'

mkdirSync(outDir, { recursive: true })

if (existsSync(pfxPath)) {
  console.log(`[generate-signing-cert] ${pfxPath} already exists — leaving it alone.`)
  process.exit(0)
}

if (process.platform !== 'win32') {
  console.error('[generate-signing-cert] Windows only.')
  process.exit(1)
}

const script = `
$ErrorActionPreference = 'Stop'
$cert = New-SelfSignedCertificate \`
  -Type CodeSigningCert \`
  -Subject '${subject}' \`
  -KeyUsage DigitalSignature \`
  -FriendlyName 'FolderPusher Self-Signed' \`
  -CertStoreLocation 'Cert:\\CurrentUser\\My' \`
  -KeyExportPolicy Exportable \`
  -KeyAlgorithm RSA \`
  -KeyLength 2048 \`
  -NotAfter (Get-Date).AddYears(3)
$pwd = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${pfxPath.replace(/\\/g, '\\\\')}' -Password $pwd | Out-Null
Export-Certificate -Cert $cert -FilePath '${cerPath.replace(/\\/g, '\\\\')}' -Type CERT | Out-Null
Write-Output $cert.Thumbprint
`.trim()

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const thumb = out.toString().trim()
  console.log('')
  console.log('Self-signed cert created.')
  console.log(`  PFX:        ${pfxPath}`)
  console.log(`  Password:   ${password}`)
  console.log(`  Thumbprint: ${thumb}`)
  console.log('')
  console.log('Next: trust the cert on this machine so SmartScreen + Smart App Control accept it:')
  console.log(`  certutil -user -addstore "TrustedPublisher" "${cerPath}"`)
  console.log(`  certutil -user -addstore "Root" "${cerPath}"`)
  console.log('')
  console.log('Then run `npm run build:win` — the build auto-detects the PFX and signs.')
} catch (err) {
  console.error('[generate-signing-cert] failed:', err.message || err)
  process.exit(1)
}

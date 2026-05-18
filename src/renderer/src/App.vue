<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import titleUrl from '../../../title.svg?url'

type RowStatus = 'queued' | 'running' | 'ok' | 'failed'
type ThemeName = 'console' | 'hardware'
type SourceType = 'folder' | 'file'

interface Row {
  machine: string
  status: RowStatus
  newFiles?: number
  elapsedSeconds?: number
  exitCode?: number
  error?: string
  log: string
  showLog: boolean
}

interface ProbeResult {
  exists: boolean
  kind?: SourceType
  files: number
  bytes: number
  error?: string
}

interface Profile {
  name: string
  src: string
  template: string
  destinations: string
  sourceType?: SourceType
  updatedAt: string
}

interface ConfirmState {
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
  resolve: (value: boolean) => void
}

interface ResultsState {
  ok: number
  failed: number
  failedMachines: string[]
  total: number
  cancelled: boolean
}

const STORAGE_KEY_THEME = 'folderpusher.theme'
const STORAGE_KEY_AUTOFILL = 'folderpusher.autofillTemplate'
const STORAGE_KEY_PROFILE = 'folderpusher.selectedProfile'
const MAX_DESTINATIONS = 10

const themes: { id: ThemeName; label: string }[] = [
  { id: 'console', label: 'Console' },
  { id: 'hardware', label: 'Hardware' }
]

const theme = ref<ThemeName>('hardware')
const autoFillTemplate = ref(true)
const src = ref('')
const sourceType = ref<SourceType>('folder')
const template = ref('\\\\{machine}\\Users\\Public\\Music')
const destinations = ref<string[]>([])
const chipDraft = ref('')
const chipInputEl = ref<HTMLInputElement | null>(null)
const probe = ref<ProbeResult | null>(null)
const probing = ref(false)
const rows = ref<Row[]>([])
const running = ref(false)

const profiles = ref<Profile[]>([])
const selectedProfile = ref<string>('')
const showSaveForm = ref(false)
const newProfileName = ref('')

const confirmDialog = ref<ConfirmState | null>(null)
const confirmButtonEl = ref<HTMLButtonElement | null>(null)

const resultsDialog = ref<ResultsState | null>(null)
const resultsButtonEl = ref<HTMLButtonElement | null>(null)

const isPackaged = ref(false)

const machines = computed(() => destinations.value)

const canCopy = computed(
  () =>
    !running.value &&
    src.value.trim().length > 0 &&
    template.value.includes('{machine}') &&
    machines.value.length > 0 &&
    probe.value?.exists === true
)

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

const sizeLabel = computed(() => {
  if (!probe.value?.exists) return ''
  if (probe.value.kind === 'file') return formatBytes(probe.value.bytes)
  const gb = probe.value.bytes / (1024 * 1024 * 1024)
  return `${gb.toFixed(1)} GB · ${probe.value.files.toLocaleString()} files`
})

const summary = computed(() => {
  if (!rows.value.length) return null
  const ok = rows.value.filter((r) => r.status === 'ok').length
  const failed = rows.value.filter((r) => r.status === 'failed').length
  return { ok, failed, total: rows.value.length }
})

function setTheme(t: ThemeName): void {
  theme.value = t
  localStorage.setItem(STORAGE_KEY_THEME, t)
}

function setAutoFillTemplate(on: boolean): void {
  autoFillTemplate.value = on
  localStorage.setItem(STORAGE_KEY_AUTOFILL, on ? '1' : '0')
}

// Persist the selected profile so the next launch restores it instead of
// resetting to "— none —". An empty name clears the restore.
function setSelectedProfile(name: string): void {
  selectedProfile.value = name
  localStorage.setItem(STORAGE_KEY_PROFILE, name)
}

// Switching the source type starts a fresh selection: the old path almost
// certainly doesn't match the new type, so clear it rather than leave a
// folder path sitting under a "File" label. Any path that arrives afterward
// (typed, pasted, profile, or hand-off) re-corrects this toggle via the probe.
function setSourceType(t: SourceType): void {
  if (sourceType.value === t) return
  sourceType.value = t
  src.value = ''
  probe.value = null
}

function showConfirm(opts: Omit<ConfirmState, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmDialog.value = { ...opts, resolve }
  })
}

function handleConfirm(yes: boolean): void {
  if (!confirmDialog.value) return
  confirmDialog.value.resolve(yes)
  confirmDialog.value = null
}

// Dismiss the results modal AND clear the progress panel. The user has been
// informed of the per-machine outcome; the rows have done their job.
function closeResults(): void {
  resultsDialog.value = null
  rows.value = []
}

watch(confirmDialog, async (val) => {
  if (val) {
    await nextTick()
    confirmButtonEl.value?.focus()
  }
})

watch(resultsDialog, async (val) => {
  if (val) {
    await nextTick()
    resultsButtonEl.value?.focus()
  }
})

async function onProbeBlur(): Promise<void> {
  if (!src.value.trim()) {
    probe.value = null
    return
  }
  probing.value = true
  try {
    probe.value = await window.api.probeSource(src.value.trim())
    // Auto-correct the Folder/File toggle to whatever the path actually is on
    // disk. Keeps the toggle honest for typed, pasted, and profile-loaded
    // paths without forcing the user to flip it themselves.
    if (probe.value?.exists && probe.value.kind) {
      sourceType.value = probe.value.kind
    }
  } finally {
    probing.value = false
  }
}

// Derive a destination template from a source path: strip the root (drive
// letter or UNC host), drop the leaf folder (it's appended automatically),
// and prepend \\{machine}\. Returns null for unrecognized path shapes so the
// caller can leave the existing template alone.
function deriveTemplate(srcPath: string): string | null {
  const p = srcPath.trim().replace(/[\\/]+$/, '')
  if (!p) return null
  const drive = p.match(/^[A-Za-z]:[\\/]+(.*)$/)
  const unc = p.match(/^[\\/]{2}[^\\/]+[\\/]+(.*)$/)
  const rest = drive ? drive[1] : unc ? unc[1] : null
  if (rest === null) return null
  const segments = rest.split(/[\\/]+/).filter((s) => s.length > 0)
  segments.pop() // leaf folder name is appended automatically downstream
  const parent = segments.join('\\')
  return parent ? `\\\\{machine}\\${parent}\\` : '\\\\{machine}\\'
}

// Apply a source folder (from the picker, the launch CLI arg, or another app
// like WhoPlayedThat handing one over): set it, optionally auto-fill the
// destination template, and probe.
async function applySource(path: string): Promise<void> {
  src.value = path
  if (autoFillTemplate.value) {
    const derived = deriveTemplate(path)
    if (derived) template.value = derived
  }
  await onProbeBlur()
}

async function pickSource(): Promise<void> {
  const picked = await window.api.pickSource(src.value.trim() || undefined, sourceType.value)
  if (!picked) return
  await applySource(picked)
}

function addChips(raw: string): void {
  const parts = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const existing = new Set(destinations.value.map((m) => m.toUpperCase()))
  for (const p of parts) {
    if (destinations.value.length >= MAX_DESTINATIONS) break
    if (!existing.has(p.toUpperCase())) {
      destinations.value.push(p)
      existing.add(p.toUpperCase())
    }
  }
}

function commitDraft(): void {
  if (!chipDraft.value.trim()) return
  addChips(chipDraft.value)
  chipDraft.value = ''
}

function onChipKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
    if (chipDraft.value.trim()) {
      e.preventDefault()
      commitDraft()
    }
  } else if (e.key === 'Backspace' && chipDraft.value === '' && destinations.value.length) {
    destinations.value.pop()
  }
}

function onChipPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text') || ''
  if (/[\s,;\n]/.test(text)) {
    e.preventDefault()
    addChips(text)
    chipDraft.value = ''
  }
}

function removeChip(idx: number): void {
  destinations.value.splice(idx, 1)
}

function focusChipInput(): void {
  chipInputEl.value?.focus()
}

async function loadProfile(name: string): Promise<void> {
  setSelectedProfile(name)
  if (!name) return
  const p = profiles.value.find((x) => x.name === name)
  if (!p) return
  src.value = p.src
  template.value = p.template
  sourceType.value = p.sourceType ?? 'folder'
  destinations.value = p.destinations
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_DESTINATIONS)
  await onProbeBlur()
}

async function saveProfileAs(): Promise<void> {
  const name = newProfileName.value.trim()
  if (!name) return
  const exists = profiles.value.some((p) => p.name === name)
  if (exists) {
    const ok = await showConfirm({
      title: 'Overwrite profile',
      message: `Replace existing profile "${name}" with current values?`,
      confirmLabel: 'Overwrite'
    })
    if (!ok) return
  }
  profiles.value = await window.api.profiles.save({
    name,
    src: src.value,
    template: template.value,
    sourceType: sourceType.value,
    destinations: destinations.value.join('\n')
  })
  setSelectedProfile(name)
  newProfileName.value = ''
  showSaveForm.value = false
}

async function removeProfile(): Promise<void> {
  if (!selectedProfile.value) return
  const name = selectedProfile.value
  const ok = await showConfirm({
    title: 'Delete profile',
    message: `Delete profile "${name}"? This can't be undone.`,
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  profiles.value = await window.api.profiles.delete(name)
  setSelectedProfile('')
}

function statusLabel(s: RowStatus): string {
  if (s === 'queued') return 'queued'
  if (s === 'running') return 'copying…'
  if (s === 'ok') return 'ok'
  return 'failed'
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (resultsDialog.value) {
    e.preventDefault()
    closeResults()
    return
  }
  if (confirmDialog.value) {
    e.preventDefault()
    handleConfirm(false)
  }
}

let unsubStatus: (() => void) | null = null
let unsubResult: (() => void) | null = null
let unsubLine: (() => void) | null = null
let unsubExternalSource: (() => void) | null = null

onMounted(async () => {
  document.addEventListener('keydown', onGlobalKeydown)
  const stored = localStorage.getItem(STORAGE_KEY_THEME) as ThemeName | null
  if (stored && themes.some((t) => t.id === stored)) {
    theme.value = stored
  }
  const storedAutoFill = localStorage.getItem(STORAGE_KEY_AUTOFILL)
  if (storedAutoFill !== null) {
    autoFillTemplate.value = storedAutoFill === '1'
  }
  isPackaged.value = await window.api.isPackaged()
  profiles.value = await window.api.profiles.list()
  // Restore the profile that was selected when the app was last closed. A
  // launch source handed over later in this hook still overrides its fields.
  const storedProfile = localStorage.getItem(STORAGE_KEY_PROFILE)
  if (storedProfile && profiles.value.some((p) => p.name === storedProfile)) {
    await loadProfile(storedProfile)
  }
  if (isPackaged.value) {
    checkForUpdates(true)
  }
  unsubStatus = window.api.onCopyStatus((d) => {
    const row = rows.value.find((r) => r.machine === d.machine)
    if (row) row.status = 'running'
  })
  unsubResult = window.api.onCopyResult((r) => {
    const row = rows.value.find((x) => x.machine === r.machine)
    if (!row) return
    row.status = r.status
    row.newFiles = r.newFiles
    row.elapsedSeconds = r.elapsedSeconds
    row.exitCode = r.exitCode
    row.error = r.error
  })
  unsubLine = window.api.onCopyLine((d) => {
    const row = rows.value.find((x) => x.machine === d.machine)
    if (row) row.log += d.text
  })
  unsubExternalSource = window.api.onExternalSource((path) => {
    applySource(path)
  })
  // A source folder passed at launch (e.g. from WhoPlayedThat's export button)
  // when FolderPusher was started cold rather than already running.
  const launchSource = await window.api.getLaunchSource()
  if (launchSource) {
    applySource(launchSource)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown)
  unsubStatus?.()
  unsubResult?.()
  unsubLine?.()
  unsubExternalSource?.()
})

async function startCopy(): Promise<void> {
  if (!canCopy.value) return
  commitDraft()
  rows.value = machines.value.map((m) => ({
    machine: m,
    status: 'queued' as const,
    log: '',
    showLog: false
  }))
  running.value = true
  let cancelled = false
  let ipcResults: Array<{ machine: string; status: 'ok' | 'failed' }> = []
  try {
    const result = await window.api.startCopy({
      src: src.value.trim(),
      template: template.value.trim(),
      machines: [...machines.value],
      sourceType: sourceType.value
    })
    cancelled = result?.cancelled === true
    ipcResults = result?.results ?? []
  } finally {
    running.value = false
  }
  // Inform the user of the per-machine outcome. Source of truth is the IPC
  // response from main — `rows` may still have a stale 'running' entry if the
  // last copy:result event hasn't drained from the renderer queue yet.
  if (rows.value.length) {
    const failedResults = ipcResults.filter((r) => r.status !== 'ok')
    resultsDialog.value = {
      ok: ipcResults.filter((r) => r.status === 'ok').length,
      failed: failedResults.length,
      failedMachines: failedResults.map((r) => r.machine),
      total: rows.value.length,
      cancelled
    }
  }
}

async function cancelCopy(): Promise<void> {
  await window.api.cancelCopy()
}

async function uninstallApp(): Promise<void> {
  const ok = await showConfirm({
    title: 'Uninstall FolderPusher',
    message:
      "This will close FolderPusher and launch the uninstaller.\n\nYou'll be asked whether to keep or delete your profiles.",
    confirmLabel: 'Uninstall',
    destructive: true
  })
  if (!ok) return
  await window.api.uninstall()
}

const updateState = ref<{
  status: 'idle' | 'checking' | 'available' | 'current' | 'installing' | 'error'
  current?: string
  latest?: string
  downloadUrl?: string | null
  error?: string
}>({ status: 'idle' })

async function checkForUpdates(silent = false): Promise<void> {
  if (!isPackaged.value) {
    if (!silent) updateState.value = { status: 'error', error: 'Updates only available in the installed app.' }
    return
  }
  updateState.value = { status: 'checking' }
  const res = await window.api.update.check()
  if (!res.ok) {
    updateState.value = silent ? { status: 'idle' } : { status: 'error', error: res.error }
    return
  }
  if (res.hasUpdate && res.downloadUrl) {
    updateState.value = {
      status: 'available',
      current: res.current,
      latest: res.latest,
      downloadUrl: res.downloadUrl
    }
  } else {
    updateState.value = silent ? { status: 'idle' } : { status: 'current', current: res.current }
  }
}

async function installUpdate(): Promise<void> {
  const url = updateState.value.downloadUrl
  if (updateState.value.status !== 'available' || !url) return
  updateState.value = { ...updateState.value, status: 'installing' }
  const res = await window.api.update.install(url)
  if (!res.ok) {
    updateState.value = { status: 'error', error: res.error }
  }
}

function dismissUpdate(): void {
  updateState.value = { status: 'idle' }
}
</script>

<template>
  <main class="app" :data-theme="theme">
    <div class="app-shell">
      <header class="app-header">
        <div class="app-brand">
          <h1 class="app-title">
            <img :src="titleUrl" alt="FolderPusher" />
          </h1>
        </div>
        <div class="theme-switcher" role="tablist" aria-label="Theme">
          <button
            v-for="t in themes"
            :key="t.id"
            :class="{ active: theme === t.id }"
            @click="setTheme(t.id)"
            role="tab"
            :aria-selected="theme === t.id"
          >
            {{ t.label }}
          </button>
        </div>
      </header>

      <div class="profile-bar">
        <label class="profile-label">Profile</label>
        <select
          class="profile-select"
          :value="selectedProfile"
          @change="loadProfile(($event.target as HTMLSelectElement).value)"
          :disabled="running || probing"
        >
          <option value="">— none —</option>
          <option v-for="p in profiles" :key="p.name" :value="p.name">
            {{ p.name }}
          </option>
        </select>
        <button
          class="secondary-button"
          @click="showSaveForm = !showSaveForm"
          :disabled="running || probing"
        >
          Save as…
        </button>
        <button
          class="secondary-button danger"
          @click="removeProfile"
          :disabled="!selectedProfile || running || probing"
        >
          Delete
        </button>
      </div>
      <div v-if="showSaveForm" class="profile-save-form">
        <input
          class="field-input"
          v-model="newProfileName"
          placeholder="Profile name (e.g. All Kypes machines)"
          @keyup.enter="saveProfileAs"
        />
        <button
          class="primary-button compact"
          @click="saveProfileAs"
          :disabled="!newProfileName.trim()"
        >
          Save
        </button>
        <button class="secondary-button" @click="showSaveForm = false">Cancel</button>
      </div>

      <section class="field">
        <div class="field-label-row">
          <label class="field-label">{{ sourceType === 'file' ? 'Source file' : 'Source folder' }}</label>
          <div class="theme-switcher" role="tablist" aria-label="Source type">
            <button
              :class="{ active: sourceType === 'folder' }"
              @click="setSourceType('folder')"
              :disabled="running || probing"
              role="tab"
              :aria-selected="sourceType === 'folder'"
            >
              Folder
            </button>
            <button
              :class="{ active: sourceType === 'file' }"
              @click="setSourceType('file')"
              :disabled="running || probing"
              role="tab"
              :aria-selected="sourceType === 'file'"
            >
              File
            </button>
          </div>
        </div>
        <div class="field-with-action">
          <input
            class="field-input mono"
            v-model="src"
            @blur="onProbeBlur"
            :placeholder="sourceType === 'file' ? '\\\\HOST\\share\\path\\to\\file.ext' : '\\\\HOST\\share\\path\\to\\folder'"
            :disabled="running || probing"
            spellcheck="false"
          />
          <button class="secondary-button browse-button" @click="pickSource" :disabled="running || probing">
            Browse…
          </button>
        </div>
        <p class="field-hint checking" v-if="probing">
          <span class="spinner" aria-hidden="true"></span>Checking…
        </p>
        <p class="field-hint ok" v-else-if="probe?.exists">{{ sizeLabel }}</p>
        <p class="field-hint error" v-else-if="probe && !probe.exists">
          Not reachable<span v-if="probe.error">: {{ probe.error }}</span>
        </p>
        <p class="field-hint" v-else>UNC path, local path, or pick a folder with Browse.</p>
      </section>

      <section class="field">
        <label class="field-label">Destination template</label>
        <input
          class="field-input mono"
          v-model="template"
          placeholder="\\{machine}\Users\Public\Music\"
          :disabled="running || probing"
          spellcheck="false"
        />
        <p class="field-hint">
          Use <code>{machine}</code> as the placeholder. The source
          {{ sourceType === 'file' ? 'file' : 'folder' }} name is appended automatically.
        </p>
        <label class="toggle-row">
          <input
            type="checkbox"
            :checked="autoFillTemplate"
            :disabled="running || probing"
            @change="setAutoFillTemplate(($event.target as HTMLInputElement).checked)"
          />
          <span>Auto-fill this template from the source folder when I Browse</span>
        </label>
      </section>

      <section class="field">
        <label class="field-label">Destinations</label>
        <div
          class="chip-input"
          :class="{ disabled: running || probing || destinations.length >= MAX_DESTINATIONS }"
          @click="focusChipInput"
        >
          <span
            v-for="(m, i) in destinations"
            :key="`${m}-${i}`"
            class="chip"
          >
            <span class="chip-name">{{ m }}</span>
            <button
              class="chip-remove"
              type="button"
              aria-label="Remove"
              @click.stop="removeChip(i)"
              :disabled="running || probing"
            >×</button>
          </span>
          <input
            ref="chipInputEl"
            v-model="chipDraft"
            class="chip-input-field"
            :placeholder="destinations.length >= MAX_DESTINATIONS ? '' : (destinations.length ? '' : 'KYPES-HQ, then Enter…')"
            @keydown="onChipKeydown"
            @blur="commitDraft"
            @paste="onChipPaste"
            :disabled="running || probing || destinations.length >= MAX_DESTINATIONS"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
          />
        </div>
        <p class="field-hint" :class="{ error: destinations.length >= MAX_DESTINATIONS }">
          <template v-if="destinations.length >= MAX_DESTINATIONS">
            {{ MAX_DESTINATIONS }} / {{ MAX_DESTINATIONS }} — maximum reached. Remove one to add another.
          </template>
          <template v-else>
            {{ destinations.length }} / {{ MAX_DESTINATIONS }} machine{{ destinations.length === 1 ? '' : 's' }} —
            Enter or comma to add, × to remove, Backspace on empty to undo last.
          </template>
        </p>
      </section>

      <div class="actions">
        <button
          v-if="!running"
          class="primary-button"
          :disabled="!canCopy"
          @click="startCopy"
        >
          <span class="play-icon">▶</span>
          Copy to all
        </button>
        <button
          v-else
          class="primary-button destructive"
          @click="cancelCopy"
        >
          ■ Cancel
        </button>
      </div>

      <section v-if="rows.length" class="progress">
        <header class="progress-header">
          <h2 class="progress-title">Progress</h2>
          <div v-if="summary" class="progress-summary">
            <span class="summary-pill ok">{{ summary.ok }} ok</span>
            <span v-if="summary.failed" class="summary-pill failed">{{ summary.failed }} failed</span>
            <span class="summary-pill muted">{{ summary.total }} total</span>
          </div>
        </header>
        <div class="progress-rows">
          <div
            v-for="row in rows"
            :key="row.machine"
            class="progress-row-group"
            :class="{ 'has-error': !!row.error }"
          >
            <div
              class="progress-row"
              :class="[row.status, { clickable: !!row.log }]"
              @click="row.log && (row.showLog = !row.showLog)"
            >
              <span class="status-dot" :class="row.status" aria-hidden="true"></span>
              <span class="machine-name">{{ row.machine }}</span>
              <span class="row-meta">{{ statusLabel(row.status) }}</span>
              <span class="row-meta">{{ row.newFiles != null ? `${row.newFiles} files` : '' }}</span>
              <span class="row-meta">{{ row.elapsedSeconds != null ? `${row.elapsedSeconds}s` : '' }}</span>
              <span class="row-meta">{{ row.exitCode != null ? `rc ${row.exitCode}` : '' }}</span>
              <span class="row-expand" v-if="row.log">{{ row.showLog ? '▼' : '▶' }}</span>
            </div>
            <pre v-if="row.showLog && row.log" class="progress-log">{{ row.log }}</pre>
            <div v-if="row.error" class="progress-error">{{ row.error }}</div>
          </div>
        </div>
      </section>

      <footer v-if="isPackaged" class="app-footer">
        <button class="text-button" @click="checkForUpdates(false)" :disabled="running || updateState.status === 'checking'">
          {{ updateState.status === 'checking' ? 'Checking…' : 'Check for updates' }}
        </button>
        <span class="footer-sep">·</span>
        <button class="text-button danger" @click="uninstallApp" :disabled="running">
          Uninstall FolderPusher
        </button>
      </footer>
    </div>

    <Transition name="modal">
      <div
        v-if="confirmDialog"
        class="modal-backdrop"
        @mousedown.self="handleConfirm(false)"
      >
        <div class="modal" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h2 class="modal-title">{{ confirmDialog.title }}</h2>
          </header>
          <p class="modal-message">{{ confirmDialog.message }}</p>
          <footer class="modal-actions">
            <button class="secondary-button" @click="handleConfirm(false)">Cancel</button>
            <button
              ref="confirmButtonEl"
              class="primary-button compact"
              :class="{ destructive: confirmDialog.destructive }"
              @click="handleConfirm(true)"
            >
              {{ confirmDialog.confirmLabel || 'OK' }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>

    <Transition name="modal">
      <div
        v-if="['available', 'current', 'error', 'installing'].includes(updateState.status)"
        class="modal-backdrop"
        @mousedown.self="updateState.status !== 'installing' && dismissUpdate()"
      >
        <div class="modal" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h2 class="modal-title">
              {{
                updateState.status === 'available' ? 'Update available' :
                updateState.status === 'current' ? 'Up to date' :
                updateState.status === 'installing' ? 'Installing update…' :
                'Update check failed'
              }}
            </h2>
          </header>
          <p class="modal-message">
            <template v-if="updateState.status === 'available'">
              FolderPusher v{{ updateState.latest }} is available. You're on v{{ updateState.current }}.
              Installing will close FolderPusher, swap in the new files, and relaunch.
            </template>
            <template v-else-if="updateState.status === 'current'">
              You're on the latest version (v{{ updateState.current }}).
            </template>
            <template v-else-if="updateState.status === 'installing'">
              Downloading and launching the installer. The window will close in a moment.
            </template>
            <template v-else>
              {{ updateState.error || 'Unknown error.' }}
            </template>
          </p>
          <footer class="modal-actions" v-if="updateState.status !== 'installing'">
            <button class="secondary-button" @click="dismissUpdate">
              {{ updateState.status === 'available' ? 'Later' : 'Close' }}
            </button>
            <button
              v-if="updateState.status === 'available'"
              class="primary-button compact"
              @click="installUpdate"
            >
              Install
            </button>
          </footer>
        </div>
      </div>
    </Transition>

    <Transition name="modal">
      <div
        v-if="resultsDialog"
        class="modal-backdrop"
        @mousedown.self="closeResults"
      >
        <div class="modal" role="dialog" aria-modal="true">
          <header class="modal-header">
            <h2 class="modal-title">
              {{ resultsDialog.cancelled ? 'Copy cancelled' : 'Copy complete' }}
            </h2>
          </header>
          <p class="modal-message">
            <template v-if="resultsDialog.failed === 0 && resultsDialog.ok === resultsDialog.total">
              Copied to all {{ resultsDialog.total }} machine{{ resultsDialog.total === 1 ? '' : 's' }}.
            </template>
            <template v-else>
              {{ resultsDialog.ok }} of {{ resultsDialog.total }} machine{{ resultsDialog.total === 1 ? '' : 's' }} completed successfully.
              <span v-if="resultsDialog.failed > 0">
                Failed: {{ resultsDialog.failedMachines.join(', ') }}.
              </span>
            </template>
          </p>
          <footer class="modal-actions">
            <button
              ref="resultsButtonEl"
              class="primary-button compact"
              @click="closeResults"
            >
              OK
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </main>
</template>

<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }
body { overflow-x: hidden; }
button { cursor: pointer; border: none; background: none; font: inherit; color: inherit; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
input, textarea, select { font: inherit; color: inherit; }

/* Scrollbars stay out of the way: the track has no chrome, the thumb is
   invisible until the user actually reaches for the scroll area. Chromium
   only shows the scrollbar when content overflows, so when nothing's there
   to scroll, the right edge is clean. */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track,
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
  transition: background-color 0.18s ease;
}
body:hover::-webkit-scrollbar-thumb,
.progress-log:hover::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.18);
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.32);
  background-clip: padding-box;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
body:hover, .progress-log:hover {
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

/* ────────────────────────────────────────────────────────────
   THEME: console — operator's terminal
   ──────────────────────────────────────────────────────────── */
[data-theme="console"] {
  --bg: radial-gradient(ellipse at top, #0f0f0f 0%, #050505 100%);
  --surface: #0c0c0c;
  --surface-elevated: #141414;
  --surface-soft: rgba(255, 176, 0, 0.04);
  --border: #242424;
  --border-strong: #3a3a3a;
  --text: #e4e4e4;
  --text-muted: #888;
  --text-dim: #555;
  --accent: #ffb000;
  --accent-hover: #ffc733;
  --accent-fg: #0a0a0a;
  --accent-dim: rgba(255, 176, 0, 0.12);
  --success: #00d97e;
  --error: #ff5555;
  --radius: 2px;
  --radius-lg: 2px;
  --font-body: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --font-heading: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --label-transform: uppercase;
  --label-tracking: 0.1em;
  --label-weight: 500;
  --title-weight: 700;
  --shadow: none;
  --shell-border: 1px solid var(--border);
  --shell-padding: 28px;
  --backdrop: none;
}

/* ────────────────────────────────────────────────────────────
   THEME: hardware — rack-mounted instrument
   ──────────────────────────────────────────────────────────── */
[data-theme="hardware"] {
  --bg: linear-gradient(180deg, #1a2030 0%, #0e1320 100%);
  --surface: #232a3d;
  --surface-elevated: #2c3349;
  --surface-soft: rgba(0, 0, 0, 0.25);
  --border: #3a4258;
  --border-strong: #525c78;
  --text: #e8eaf0;
  --text-muted: #9098ad;
  --text-dim: #5a6178;
  --accent: #ffa726;
  --accent-hover: #ffb74d;
  --accent-fg: #1a1300;
  --accent-dim: rgba(255, 167, 38, 0.14);
  --success: #4ade80;
  --error: #f87171;
  --radius: 3px;
  --radius-lg: 6px;
  --font-body: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --font-mono: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --font-heading: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
  --label-transform: uppercase;
  --label-tracking: 0.14em;
  --label-weight: 600;
  --title-weight: 700;
  --shadow:
    0 12px 36px rgba(0, 0, 0, 0.55),
    0 2px 6px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.4);
  --shell-border: 1px solid var(--border);
  --shell-padding: 28px;
  --backdrop: none;
}

/* ────────────────────────────────────────────────────────────
   Layout
   ──────────────────────────────────────────────────────────── */
.app {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.app-shell {
  width: 100%;
  min-height: 100vh;
  background: var(--surface);
  padding: var(--shell-padding);
  backdrop-filter: var(--backdrop);
  -webkit-backdrop-filter: var(--backdrop);
  position: relative;
}

[data-theme="hardware"] .app-shell {
  background:
    repeating-linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.018) 0px,
      rgba(0, 0, 0, 0.022) 1px,
      transparent 2px,
      transparent 3px
    ),
    linear-gradient(180deg, #2c344a 0%, #232a3d 100%);
}
[data-theme="hardware"] .app-shell::before {
  content: '';
  position: absolute;
  inset: 6px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: calc(var(--radius-lg) - 4px);
  pointer-events: none;
}
[data-theme="hardware"] .app-shell::after {
  content: '';
  position: absolute;
  top: 14px;
  right: 14px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  box-shadow:
    -10px 0 0 rgba(255, 255, 255, 0.1),
    0 calc(100% + 0px) 0 rgba(255, 255, 255, 0.1),
    -10px calc(100% + 0px) 0 rgba(255, 255, 255, 0.1);
  pointer-events: none;
}

/* ────────────────────────────────────────────────────────────
   Header
   ──────────────────────────────────────────────────────────── */
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.app-brand { display: flex; align-items: center; }

.app-title {
  margin: 0;
  display: flex;
  align-items: center;
  line-height: 0;
}

.app-title img {
  height: 40px;
  width: auto;
  display: block;
}

[data-theme="hardware"] .app-title img {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
}

/* Theme switcher */
.theme-switcher {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.theme-switcher button {
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  border-radius: calc(var(--radius-lg) - 4px);
  transition: background 0.12s, color 0.12s;
}

.theme-switcher button:hover { color: var(--text); }

.theme-switcher button.active {
  background: var(--surface-elevated);
  color: var(--accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

[data-theme="console"] .theme-switcher button.active {
  background: var(--accent-dim);
  box-shadow: none;
}

[data-theme="hardware"] .theme-switcher button {
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 10px;
  font-family: var(--font-mono);
}

[data-theme="hardware"] .theme-switcher button.active {
  background: var(--accent-dim);
  color: var(--accent);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
  text-shadow: 0 0 6px rgba(255, 167, 38, 0.4);
}

/* ────────────────────────────────────────────────────────────
   Profile bar
   ──────────────────────────────────────────────────────────── */
.profile-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
  padding: 12px 14px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

[data-theme="hardware"] .profile-bar {
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.35);
}

.profile-label {
  font-size: 11px;
  font-weight: var(--label-weight);
  color: var(--text-muted);
  text-transform: var(--label-transform);
  letter-spacing: var(--label-tracking);
}

[data-theme="hardware"] .profile-label::before { content: '[ '; color: var(--accent); }
[data-theme="hardware"] .profile-label::after { content: ' ]'; color: var(--accent); }

.profile-select {
  flex: 1;
  padding: 7px 10px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--text);
}

[data-theme="hardware"] .profile-select {
  background: #0f1320;
  font-family: var(--font-mono);
  color: #d4e2ff;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
}

.profile-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

.profile-save-form {
  display: flex;
  gap: 8px;
  margin: -16px 0 24px;
  padding: 12px 14px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

.profile-save-form .field-input { flex: 1; }

/* ────────────────────────────────────────────────────────────
   Fields
   ──────────────────────────────────────────────────────────── */
.field { margin-bottom: 20px; }

.field-label {
  display: block;
  margin-bottom: 7px;
  font-size: 11px;
  font-weight: var(--label-weight);
  color: var(--text-muted);
  text-transform: var(--label-transform);
  letter-spacing: var(--label-tracking);
}

[data-theme="hardware"] .field-label::before { content: '[ '; color: var(--accent); }
[data-theme="hardware"] .field-label::after { content: ' ]'; color: var(--accent); }

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 7px;
}

.field-label-row .field-label { margin-bottom: 0; }

.field-with-action {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.field-with-action .field-input { flex: 1; min-width: 0; }
.browse-button { white-space: nowrap; }

.field-input,
.field-textarea {
  width: 100%;
  padding: 10px 13px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text);
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
}

.field-input.mono,
.field-textarea.mono {
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.field-input:hover:not(:disabled),
.field-textarea:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.field-input:focus,
.field-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

[data-theme="console"] .field-input,
[data-theme="console"] .field-textarea {
  background: #050505;
}

[data-theme="hardware"] .field-input,
[data-theme="hardware"] .field-textarea {
  background: #0e1320;
  color: #d4e2ff;
  border-color: #2a3148;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
  caret-color: var(--accent);
}

[data-theme="hardware"] .field-input:focus,
[data-theme="hardware"] .field-textarea:focus {
  border-color: var(--accent);
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.5),
    0 0 0 2px var(--accent-dim),
    0 0 12px rgba(255, 167, 38, 0.2);
}

.field-textarea {
  resize: vertical;
  min-height: 110px;
  line-height: 1.5;
}

.field-hint {
  margin: 7px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.field-hint.ok { color: var(--success); }
.field-hint.error { color: var(--error); }

.field-hint.checking {
  display: flex;
  align-items: center;
  gap: 7px;
}

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}

.toggle-row input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.toggle-row input:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.field-hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 5px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
}

[data-theme="hardware"] .field-hint code {
  background: #0e1320;
  color: var(--accent);
}

/* ────────────────────────────────────────────────────────────
   Chip input
   ──────────────────────────────────────────────────────────── */
.chip-input {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 6px;
  padding: 8px;
  min-height: 110px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: text;
  transition: border-color 0.12s, box-shadow 0.12s;
}

.chip-input.disabled { cursor: not-allowed; opacity: 0.7; }

.chip-input:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-dim);
}

[data-theme="console"] .chip-input { background: #050505; }

[data-theme="hardware"] .chip-input {
  background: #0e1320;
  border-color: #2a3148;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
}

[data-theme="hardware"] .chip-input:focus-within {
  border-color: var(--accent);
  box-shadow:
    inset 0 1px 3px rgba(0, 0, 0, 0.5),
    0 0 0 2px var(--accent-dim),
    0 0 12px rgba(255, 167, 38, 0.2);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 10px;
  background: var(--surface-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  line-height: 1;
}

[data-theme="console"] .chip {
  background: var(--accent-dim);
  border-color: rgba(255, 176, 0, 0.4);
  color: var(--accent);
}

[data-theme="hardware"] .chip {
  background: linear-gradient(180deg, #3a4258 0%, #2c3349 100%);
  border-color: var(--border);
  color: #d4e2ff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 11px;
}

.chip-name { display: inline-block; }

.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: 2px;
  border-radius: 50%;
  font-size: 15px;
  line-height: 1;
  color: var(--text-muted);
  transition: background 0.12s, color 0.12s;
}

.chip-remove:hover:not(:disabled) {
  background: var(--error);
  color: white;
}

[data-theme="hardware"] .chip-remove { color: var(--accent); }
[data-theme="console"] .chip-remove { color: var(--accent); }

.chip-input-field {
  flex: 1;
  min-width: 160px;
  padding: 4px 6px;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text);
}

[data-theme="hardware"] .chip-input-field { color: #d4e2ff; caret-color: var(--accent); }
[data-theme="console"] .chip-input-field { caret-color: var(--accent); }

.chip-input-field::placeholder { color: var(--text-dim); }

/* ────────────────────────────────────────────────────────────
   Buttons
   ──────────────────────────────────────────────────────────── */
.primary-button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 22px;
  background: var(--accent);
  color: var(--accent-fg);
  border-radius: var(--radius);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: var(--label-tracking);
  text-transform: var(--label-transform);
  transition: background 0.12s, transform 0.05s, box-shadow 0.12s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.primary-button:hover:not(:disabled) { background: var(--accent-hover); }

.primary-button:active:not(:disabled) {
  transform: translateY(1px);
  box-shadow: none;
}

.primary-button.compact {
  padding: 7px 14px;
  font-size: 12px;
  text-transform: none;
  letter-spacing: 0;
}

.play-icon { font-size: 10px; line-height: 1; }

[data-theme="hardware"] .primary-button {
  background: linear-gradient(180deg, #ffc168 0%, var(--accent) 50%, #d97f00 100%);
  color: #1a1300;
  border: 1px solid #b06800;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 2px 6px rgba(0, 0, 0, 0.4),
    0 0 18px rgba(255, 167, 38, 0.2);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.25);
}

[data-theme="hardware"] .primary-button:hover:not(:disabled) {
  background: linear-gradient(180deg, #ffd28a 0%, var(--accent-hover) 50%, #e08e00 100%);
}

.primary-button.destructive {
  background: var(--error);
  color: white;
  text-shadow: none;
}

.primary-button.destructive:hover:not(:disabled) {
  background: #dc2626;
}

[data-theme="hardware"] .primary-button.destructive {
  background: linear-gradient(180deg, #ffa5a5 0%, var(--error) 50%, #991b1b 100%);
  color: white;
  border: 1px solid #7f1d1d;
  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 2px 6px rgba(0, 0, 0, 0.4),
    0 0 18px rgba(248, 113, 113, 0.25);
}

[data-theme="hardware"] .primary-button.destructive:hover:not(:disabled) {
  background: linear-gradient(180deg, #ffc4c4 0%, #ef5350 50%, #b91c1c 100%);
}

.secondary-button {
  padding: 7px 12px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--text);
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.secondary-button:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--surface-soft);
}

.secondary-button.danger:hover:not(:disabled) {
  border-color: var(--error);
  color: var(--error);
}

[data-theme="hardware"] .secondary-button {
  background: linear-gradient(180deg, #3a4258 0%, #2c3349 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 10.5px;
  font-family: var(--font-mono);
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin: 28px 0 8px;
}

.app-footer {
  margin-top: 40px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 4px;
}

.footer-sep {
  color: var(--text-dim);
  opacity: 0.5;
  font-size: 11px;
}

.text-button {
  background: none;
  border: none;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: var(--label-weight);
  color: var(--text-dim);
  text-transform: var(--label-transform);
  letter-spacing: var(--label-tracking);
  cursor: pointer;
  transition: color 0.12s;
}

.text-button:hover:not(:disabled) { color: var(--accent); }
.text-button.danger:hover:not(:disabled) { color: var(--error); }
.text-button:disabled { cursor: not-allowed; opacity: 0.5; }

/* ────────────────────────────────────────────────────────────
   Modal / confirm dialog
   ──────────────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}

.modal {
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  padding: 22px 24px 18px;
  min-width: 320px;
  max-width: 480px;
  width: 100%;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.4);
  position: relative;
}

[data-theme="console"] .modal {
  background: #0a0a0a;
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent-dim),
    0 24px 64px rgba(0, 0, 0, 0.7);
}

[data-theme="hardware"] .modal {
  background:
    repeating-linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.018) 0px,
      rgba(0, 0, 0, 0.022) 1px,
      transparent 2px,
      transparent 3px
    ),
    linear-gradient(180deg, #2c344a 0%, #232a3d 100%);
  border-color: var(--border);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.7),
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.4);
}

[data-theme="hardware"] .modal::before {
  content: '';
  position: absolute;
  inset: 6px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: calc(var(--radius-lg) - 4px);
  pointer-events: none;
}

.modal-header { margin-bottom: 12px; position: relative; }

.modal-title {
  margin: 0;
  font-size: 12px;
  font-weight: var(--label-weight);
  color: var(--text-muted);
  text-transform: var(--label-transform);
  letter-spacing: var(--label-tracking);
}

[data-theme="hardware"] .modal-title::before { content: '── '; color: var(--accent); }
[data-theme="hardware"] .modal-title::after { content: ' ──'; color: var(--accent); }

.modal-message {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  font-family: var(--font-body);
  position: relative;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  position: relative;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.modal-enter-from,
.modal-leave-to { opacity: 0; }
.modal-enter-from .modal,
.modal-leave-to .modal { transform: scale(0.96); opacity: 0; }

/* ────────────────────────────────────────────────────────────
   Progress
   ──────────────────────────────────────────────────────────── */
.progress {
  margin-top: 28px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

.progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.progress-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--label-weight);
  color: var(--text-muted);
  text-transform: var(--label-transform);
  letter-spacing: var(--label-tracking);
}

[data-theme="hardware"] .progress-title::before { content: '── '; color: var(--accent); }
[data-theme="hardware"] .progress-title::after { content: ' ──'; color: var(--accent); }

.progress-summary { display: flex; gap: 6px; }

.summary-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  font-family: var(--font-mono);
  letter-spacing: 0;
  text-transform: none;
}

.summary-pill.ok { background: rgba(22, 163, 74, 0.12); color: var(--success); }
.summary-pill.failed { background: rgba(220, 38, 38, 0.12); color: var(--error); }
.summary-pill.muted { background: var(--surface-soft); color: var(--text-muted); border: 1px solid var(--border); }

.progress-rows { display: flex; flex-direction: column; gap: 4px; }

.progress-row-group { display: flex; flex-direction: column; }

.progress-row-group.has-error .progress-row {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-bottom-width: 0;
}

.progress-error {
  margin: 0;
  padding: 8px 14px 10px 36px;
  background: rgba(220, 38, 38, 0.07);
  border: 1px solid rgba(220, 38, 38, 0.3);
  border-radius: 0 0 var(--radius) var(--radius);
  color: var(--error);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

[data-theme="hardware"] .progress-error {
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.35);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
}

.progress-row {
  display: grid;
  grid-template-columns: 14px 1fr 90px 80px 60px 70px 20px;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  background: var(--surface-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  transition: background 0.15s;
}

.progress-row.clickable { cursor: pointer; user-select: none; }
.progress-row.clickable:hover { background: var(--surface-elevated-hover, var(--accent-dim)); }

.row-expand {
  font-size: 9px;
  color: var(--text-dim);
  text-align: center;
}

.progress-log {
  margin: 0;
  padding: 10px 14px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 var(--radius) var(--radius);
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

[data-theme="hardware"] .progress-row {
  background: rgba(0, 0, 0, 0.3);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);
}

.progress-row.running {
  border-color: var(--accent);
  background: var(--accent-dim);
}

[data-theme="hardware"] .progress-row.running {
  background: rgba(255, 167, 38, 0.08);
  border-color: rgba(255, 167, 38, 0.5);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.3),
    0 0 12px rgba(255, 167, 38, 0.15);
}

.progress-row.ok { border-color: rgba(22, 163, 74, 0.3); }
.progress-row.failed { border-color: rgba(220, 38, 38, 0.3); }

[data-theme="console"] .progress-row.ok { border-color: rgba(0, 217, 126, 0.3); }
[data-theme="hardware"] .progress-row.ok { border-color: rgba(74, 222, 128, 0.4); }
[data-theme="hardware"] .progress-row.failed { border-color: rgba(248, 113, 113, 0.4); }

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}

.status-dot.running {
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
  box-shadow: 0 0 0 0 var(--accent);
}

.status-dot.ok { background: var(--success); }
.status-dot.failed { background: var(--error); }

[data-theme="console"] .status-dot { border-radius: 1px; }

[data-theme="hardware"] .status-dot {
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.2), var(--text-dim) 60%);
  box-shadow: inset 0 -1px 2px rgba(0, 0, 0, 0.4);
}
[data-theme="hardware"] .status-dot.running {
  background: radial-gradient(circle at 30% 30%, #ffe1a8, var(--accent) 55%, #9a5a00 100%);
  box-shadow: 0 0 8px var(--accent), 0 0 14px rgba(255, 167, 38, 0.5);
  animation: led-pulse 1.4s ease-in-out infinite;
}
[data-theme="hardware"] .status-dot.ok {
  background: radial-gradient(circle at 30% 30%, #c4f5d5, var(--success) 55%, #166534 100%);
  box-shadow: 0 0 8px var(--success), 0 0 12px rgba(74, 222, 128, 0.4);
}
[data-theme="hardware"] .status-dot.failed {
  background: radial-gradient(circle at 30% 30%, #ffd0d0, var(--error) 55%, #991b1b 100%);
  box-shadow: 0 0 8px var(--error), 0 0 12px rgba(248, 113, 113, 0.4);
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-dim); }
  50% { box-shadow: 0 0 0 6px transparent; }
}

@keyframes led-pulse {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.4); }
}

.machine-name { font-weight: 600; color: var(--text); }

.row-meta { color: var(--text-muted); font-size: 12px; text-align: right; }

.progress-row.ok .row-meta:nth-child(3) { color: var(--success); }
.progress-row.failed .row-meta:nth-child(3) { color: var(--error); }
.progress-row.running .row-meta:nth-child(3) { color: var(--accent); }

@media (max-width: 640px) {
  .progress-row {
    grid-template-columns: 14px 1fr auto;
    grid-template-rows: auto auto;
  }
  .progress-row .row-meta { grid-column: 2 / 4; }
}
</style>

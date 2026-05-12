<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

type RowStatus = 'queued' | 'running' | 'ok' | 'failed'

interface Row {
  machine: string
  status: RowStatus
  newFiles?: number
  elapsedSeconds?: number
  exitCode?: number
  error?: string
}

interface ProbeResult {
  exists: boolean
  files: number
  bytes: number
  error?: string
}

const src = ref('')
const template = ref('\\\\{machine}\\Users\\Public\\Music\\Wes Montgomery')
const destinationsText = ref('')
const probe = ref<ProbeResult | null>(null)
const probing = ref(false)
const rows = ref<Row[]>([])
const running = ref(false)

const machines = computed(() =>
  destinationsText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
)

const canCopy = computed(
  () =>
    !running.value &&
    src.value.trim().length > 0 &&
    template.value.includes('{machine}') &&
    machines.value.length > 0 &&
    probe.value?.exists === true
)

const sizeLabel = computed(() => {
  if (!probe.value?.exists) return ''
  const mb = probe.value.bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB, ${probe.value.files} files`
})

async function onProbeBlur(): Promise<void> {
  if (!src.value.trim()) {
    probe.value = null
    return
  }
  probing.value = true
  try {
    probe.value = await window.api.probeSource(src.value.trim())
  } finally {
    probing.value = false
  }
}

let unsubStatus: (() => void) | null = null
let unsubResult: (() => void) | null = null

onMounted(() => {
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
})

onUnmounted(() => {
  unsubStatus?.()
  unsubResult?.()
})

async function startCopy(): Promise<void> {
  if (!canCopy.value) return
  rows.value = machines.value.map((m) => ({ machine: m, status: 'queued' as const }))
  running.value = true
  try {
    await window.api.startCopy({
      src: src.value.trim(),
      template: template.value.trim(),
      machines: machines.value
    })
  } finally {
    running.value = false
  }
}

function statusIcon(s: RowStatus): string {
  if (s === 'ok') return '[OK]'
  if (s === 'failed') return '[X]'
  if (s === 'running') return '...'
  return '   '
}
</script>

<template>
  <main>
    <h1>Folder Pusher</h1>

    <section class="field">
      <label>Source folder</label>
      <input
        v-model="src"
        @blur="onProbeBlur"
        placeholder="\\HOST\share\path\to\folder"
        :disabled="running"
      />
      <p class="hint" v-if="probing">Checking…</p>
      <p class="hint" v-else-if="probe?.exists">{{ sizeLabel }}</p>
      <p class="hint error" v-else-if="probe && !probe.exists">
        Not reachable<span v-if="probe.error">: {{ probe.error }}</span>
      </p>
    </section>

    <section class="field">
      <label>Destination template (use <code>{machine}</code>)</label>
      <input
        v-model="template"
        placeholder="\\{machine}\Users\Public\Music\Wes Montgomery"
        :disabled="running"
      />
    </section>

    <section class="field">
      <label>Destinations (one machine per line)</label>
      <textarea
        v-model="destinationsText"
        rows="6"
        placeholder="KYPES-HQ&#10;KYPES-HQ2"
        :disabled="running"
      ></textarea>
    </section>

    <div class="actions">
      <button :disabled="!canCopy" @click="startCopy">
        {{ running ? 'Copying…' : 'Copy to all' }}
      </button>
    </div>

    <section v-if="rows.length" class="progress">
      <h2>Progress</h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Machine</th>
            <th>Status</th>
            <th>New files</th>
            <th>Elapsed</th>
            <th>rc</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.machine">
            <td><code>{{ statusIcon(row.status) }}</code></td>
            <td>{{ row.machine }}</td>
            <td>
              {{ row.status }}
              <span v-if="row.error" class="error" :title="row.error">— error</span>
            </td>
            <td>{{ row.newFiles ?? '' }}</td>
            <td>{{ row.elapsedSeconds != null ? row.elapsedSeconds + 's' : '' }}</td>
            <td>{{ row.exitCode ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 24px; }
h1 { margin: 0 0 16px; font-size: 20px; }
h2 { margin: 24px 0 8px; font-size: 16px; }
.field { margin-bottom: 16px; }
.field label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 13px; }
.field input,
.field textarea { width: 100%; padding: 6px 8px; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
.hint { font-size: 12px; color: #666; margin: 4px 0 0; }
.hint.error { color: #b00020; }
.actions { display: flex; justify-content: flex-end; margin: 16px 0; }
button { padding: 8px 16px; font-weight: 600; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #eee; }
.error { color: #b00020; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; background: #f4f4f4; padding: 1px 4px; }
</style>

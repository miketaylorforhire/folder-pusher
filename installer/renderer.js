const api = window.installer;

const state = {
  mode: 'install',
  targetDir: '',
  launch: true,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showScreen(name) {
  $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === name));
  const stepMap = {
    welcome: 'welcome',
    location: 'location',
    installing: 'installing',
    finish: 'finish',
  };
  const current = stepMap[name];
  $$('.step').forEach((el) => {
    el.classList.remove('active', 'done');
    if (!current) return;
    const order = ['welcome', 'location', 'installing', 'finish'];
    const currentIdx = order.indexOf(current);
    const stepIdx = order.indexOf(el.dataset.step);
    if (stepIdx < currentIdx) el.classList.add('done');
    if (stepIdx === currentIdx) el.classList.add('active');
  });
  document.querySelector('.sidebar').style.display = current ? '' : 'none';
}

function formatBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

async function updateSpaceDetail() {
  const free = await api.diskSpace(state.targetDir);
  $('#space-detail').textContent = `~ 200 MB required · ${formatBytes(free)} available`;
}

showScreen('welcome');
(async () => {
  try {
    state.targetDir = await api.defaultDir();
    $('#path-display').textContent = state.targetDir;
  } catch (err) {
    $('#path-display').textContent = 'C:\\Users\\You\\AppData\\Local\\Programs\\FolderPusher';
    console.error('defaultDir failed', err);
  }
})();

api.onMode(async (mode) => {
  if (mode === 'uninstall') {
    state.mode = 'uninstall';
    $('#titlebar-text').textContent = 'FOLDERPUSHER — UNINSTALL';
    const dir = await api.findInstall();
    state.targetDir = dir || '';
    $('#uninstall-path').textContent = dir || 'No installation found.';
    showScreen('uninstall-confirm');
  } else if (mode === 'upgrade') {
    state.mode = 'upgrade';
    $('#titlebar-text').textContent = 'FOLDERPUSHER — UPDATE';
    const dir = await api.findUpgradeTarget();
    if (!dir) {
      showScreen('upgrading');
      $('#upgrade-error').textContent = 'Could not locate the installed app.';
      $('#upgrade-error').style.display = 'block';
      return;
    }
    state.targetDir = dir;
    showScreen('upgrading');
    try {
      $('#upgrade-stage').textContent = 'Unpacking';
      await api.runUpgrade(dir);
      $('#upgrade-stage').textContent = 'Launching';
      await api.launch(dir);
    } catch (err) {
      $('#upgrade-error').textContent = String(err && err.message ? err.message : err);
      $('#upgrade-error').style.display = 'block';
    }
  }
});

$('#close-btn').addEventListener('click', () => api.closeWindow());
$('#min-btn').addEventListener('click', () => api.minimizeWindow());

$('#welcome-cancel').addEventListener('click', () => api.closeWindow());
$('#welcome-next').addEventListener('click', () => {
  updateSpaceDetail();
  showScreen('location');
});

$('#browse-btn').addEventListener('click', async () => {
  const picked = await api.pickFolder(state.targetDir);
  if (picked) {
    state.targetDir = picked;
    $('#path-display').textContent = picked;
    $('#location-error').style.display = 'none';
    updateSpaceDetail();
  }
});

$('#location-back').addEventListener('click', () => showScreen('welcome'));
$('#location-next').addEventListener('click', async () => {
  $('#location-error').style.display = 'none';
  showScreen('installing');
  try {
    await api.runInstall(state.targetDir);
    $('#progress-stage').textContent = 'Creating shortcuts';
    await api.createShortcuts(state.targetDir, true);
    $('#progress-stage').textContent = 'Registering';
    await api.registerUninstall(state.targetDir);
    $('#progress-stage').textContent = 'Done';
    showScreen('finish');
  } catch (err) {
    $('#install-error').textContent = String(err && err.message ? err.message : err);
    $('#install-error').style.display = 'block';
  }
});

$('#install-cancel').addEventListener('click', () => api.closeWindow());

api.onProgress(({ pct, file }) => {
  const p = Math.round(pct * 100);
  const fillIds = state.mode === 'upgrade'
    ? ['upgrade-fill', 'upgrade-pct', 'upgrade-file']
    : ['progress-fill', 'progress-pct', 'progress-file'];
  const [fillId, pctId, fileId] = fillIds;
  const fill = document.getElementById(fillId);
  const pctEl = document.getElementById(pctId);
  const fileEl = document.getElementById(fileId);
  if (fill) fill.style.width = `${p}%`;
  if (pctEl) pctEl.textContent = `${p}%`;
  if (file && fileEl) fileEl.textContent = file;
});

$('#launch-toggle').addEventListener('click', () => {
  state.launch = !state.launch;
  $('#launch-toggle').classList.toggle('checked', state.launch);
});

$('#finish-btn').addEventListener('click', async () => {
  if (state.launch) {
    await api.launch(state.targetDir);
  } else {
    api.closeWindow();
  }
});

$('#uninstall-cancel').addEventListener('click', () => api.closeWindow());
$('#wipe-data-toggle').addEventListener('click', () => {
  $('#wipe-data-toggle').classList.toggle('checked');
});
$('#uninstall-confirm').addEventListener('click', async () => {
  if (!state.targetDir) {
    api.closeWindow();
    return;
  }
  const wipeData = $('#wipe-data-toggle').classList.contains('checked');
  showScreen('uninstalling');
  await api.runUninstall(state.targetDir, wipeData);
  showScreen('uninstalled');
});
$('#uninstalled-close').addEventListener('click', () => api.closeWindow());

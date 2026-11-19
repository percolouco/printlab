// Onglet Imprimante : état en direct, caméra, températures, QIDI Box, console, fichiers, historique.
import { api, toast, confirm2, esc, fmtDuration } from './api.js';

let last = null;
let timer = null;
let active = false;
const listeners = [];
export const onStatus = (fn) => listeners.push(fn);
export const lastStatus = () => last;

const STATE_FR = { standby: 'En attente', printing: 'Impression', paused: 'En pause', complete: 'Terminée',
  cancelled: 'Annulée', error: 'Erreur' };

export function initDevice() {
  document.getElementById('p-pause').onclick = () => act('pause');
  document.getElementById('p-resume').onclick = () => act('resume');
  document.getElementById('p-cancel').onclick = async () => {
    if (await confirm2('Annuler l\'impression', 'Annuler l\'impression en cours ?', 'Annuler l\'impression', true)) act('cancel');
  };
  document.getElementById('estop').onclick = async () => {
    if (await confirm2('Arrêt d\'urgence', 'Couper immédiatement l\'imprimante (arrêt d\'urgence Klipper) ?', 'Arrêt d\'urgence', true)) act('emergency_stop');
  };
  document.querySelectorAll('[data-gcode]').forEach((b) => b.onclick = () => gcode(b.dataset.gcode));
  document.getElementById('light-btn').onclick = () => {
    const on = (last?.status?.['output_pin caselight']?.value || 0) > 0;
    gcode(on ? 'SET_PIN PIN=caselight VALUE=0' : 'SET_PIN PIN=caselight VALUE=1');
  };
  document.getElementById('box-query').onclick = () => gcode('QUERY_MULTI_COLOR');
  document.getElementById('box-rfid').classList.add('hidden');
  document.getElementById('box-dry').classList.add('hidden');
  document.getElementById('console-form').onsubmit = (e) => {
    e.preventDefault();
    const i = document.getElementById('console-input');
    if (i.value.trim()) gcode(i.value.trim());
    i.value = '';
  };
  document.getElementById('queue-start').onclick = async () => {
    if (!await confirm2('Démarrer la file', 'Lancer les impressions en file d\'attente, l\'une après l\'autre ?', 'Démarrer')) return;
    try { await api('/slicer/api/printer-queue/start', { method: 'POST' }); toast('File démarrée'); } catch (e) { toast(e.message, 'err'); }
    refreshQueue();
  };
  document.getElementById('queue-pause').onclick = async () => { try { await api('/slicer/api/printer-queue/pause', { method: 'POST' }); } catch (e) { toast(e.message, 'err'); } refreshQueue(); };
  poll();
}

export function setDeviceActive(on) {
  active = on;
  const cam = document.getElementById('cam');
  if (on) {
    cam.src = '/slicer/api/webcam/stream?t=' + Date.now();
    cam.onerror = () => { cam.src = '/slicer/api/webcam/snapshot?t=' + Date.now(); };
    refreshFiles(); refreshHistory(); refreshConsole(); refreshQueue();
  } else {
    cam.removeAttribute('src');
  }
  clearTimeout(timer); poll();
}

async function act(name) {
  try { await api('/slicer/api/printer/' + name, { method: 'POST' }); toast('Commande envoyée'); poll(); }
  catch (e) { toast(e.message, 'err'); }
}

export async function gcode(script) {
  try {
    appendConsole('> ' + script, 'cmd');
    await api('/slicer/api/printer-gcode', { json: { script } });
    setTimeout(refreshConsole, 400);
  } catch (e) { appendConsole(e.message, 'err'); toast(e.message, 'err'); }
}

function appendConsole(text, cls = '') {
  const c = document.getElementById('console');
  const d = document.createElement('div'); d.className = cls; d.textContent = text;
  c.appendChild(d); c.scrollTop = c.scrollHeight;
}

async function refreshConsole() {
  try {
    const items = await api('/slicer/api/printer-console?count=60');
    const c = document.getElementById('console');
    c.innerHTML = items.map((i) => `<div class="${i.type === 'command' ? 'cmd' : (i.message.startsWith('!!') ? 'err' : '')}">${esc(i.type === 'command' ? '> ' + i.message : i.message)}</div>`).join('');
    c.scrollTop = c.scrollHeight;
  } catch {}
}

async function refreshFiles() {
  try {
    const files = await api('/slicer/api/printer-files');
    document.getElementById('files').innerHTML = files.slice(0, 40).map((f) => `
      <div class="file-row">${f.path.endsWith('.gcode') ? `<img loading="lazy" src="/slicer/api/printer-thumbnail?path=${encodeURIComponent((f.path.includes('/') ? f.path.replace(/[^/]+$/, '') : '') + '.thumbs/' + f.path.split('/').pop().replace(/\.gcode$/, '-300x300.png'))}" onerror="this.style.visibility='hidden'">` : '<span></span>'}
      <div><div class="n" title="${esc(f.path)}">${esc(f.path)}</div><div class="muted small">${new Date(f.modified * 1000).toLocaleString('fr-FR')} · ${(f.size / 1e6).toFixed(1)} Mo</div></div>
      <button class="btn small" data-start="${esc(f.path)}">▶</button></div>`).join('') || '<p class="muted">Aucun fichier</p>';
    document.querySelectorAll('[data-start]').forEach((b) => b.onclick = async () => {
      if (!await confirm2('Lancer l\'impression', `Imprimer <b>${esc(b.dataset.start)}</b> ?`, 'Imprimer')) return;
      try { await api('/slicer/api/printer-files/start', { json: { filename: b.dataset.start } }); toast('Impression lancée'); poll(); }
      catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { document.getElementById('files').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function refreshQueue() {
  try {
    const q = await api('/slicer/api/printer-queue');
    document.getElementById('queue-state').textContent = { ready: '· prête', paused: '· en pause', loading: '· chargement', starting: '· démarrage' }[q.queue_state] || '';
    document.getElementById('queue').innerHTML = (q.queued_jobs || []).map((j) => `<div class="file-row" style="grid-template-columns:1fr auto"><div><div class="n">${esc(j.filename)}</div>
      <div class="muted small">ajouté ${new Date(j.time_added * 1000).toLocaleString('fr-FR')}</div></div><button class="btn small" data-qdel="${esc(j.job_id)}" title="Retirer de la file">✕</button></div>`).join('')
      || '<p class="muted small">Vide. Depuis l\'aperçu : « Ajouter à la file ».</p>';
    document.querySelectorAll('[data-qdel]').forEach((b) => b.onclick = async () => { await api('/slicer/api/printer-queue/' + encodeURIComponent(b.dataset.qdel), { method: 'DELETE' }); refreshQueue(); });
  } catch (e) { document.getElementById('queue').innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
}

async function refreshHistory() {
  try {
    const jobs = await api('/slicer/api/printer-history');
    document.getElementById('history').innerHTML = jobs.slice(0, 25).map((j) => `
      <div class="file-row" style="grid-template-columns:1fr auto"><div><div class="n">${esc(j.filename)}</div>
      <div class="muted small">${new Date(j.start_time * 1000).toLocaleString('fr-FR')} · ${fmtDuration(j.print_duration)} · ${((j.filament_used || 0) / 1000).toFixed(2)} m</div></div>
      <span class="small" style="color:${j.status === 'completed' ? 'var(--ok)' : j.status === 'cancelled' ? 'var(--warn)' : 'var(--err)'}">${esc({ completed: 'Terminée', cancelled: 'Annulée', error: 'Erreur', klippy_shutdown: 'Arrêt', in_progress: 'En cours' }[j.status] || j.status)}</span></div>`).join('') || '<p class="muted">Aucun historique</p>';
  } catch {}
}

async function poll() {
  clearTimeout(timer);
  try {
    last = await api('/slicer/api/printer/status');
    render(last);
    listeners.forEach((fn) => fn(last));
  } catch (e) {
    document.getElementById('dev-badge').className = 'badge error';
    if (active) document.getElementById('job-info').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
  timer = setTimeout(poll, active ? 2000 : 10000);
}

function render({ status: s, box }) {
  const ps = s.print_stats || {}, vs = s.virtual_sdcard || {}, ds = s.display_status || {};
  const state = ps.state || 'standby';
  document.getElementById('dev-badge').className = 'badge ' + ({ printing: 'printing', paused: 'paused', error: 'error' }[state] || 'idle');
  if (!active) return;
  const prog = ds.progress ?? vs.progress ?? 0;
  const elapsed = ps.print_duration || 0;
  const eta = prog > 0.01 ? elapsed / prog - elapsed : null;
  const layer = ps.info?.current_layer, total = ps.info?.total_layer;
  document.getElementById('job-info').innerHTML = `<div class="kv">
    <span>État</span><span>${esc(STATE_FR[state] || state)}${ps.message ? ' — ' + esc(ps.message) : ''}</span>
    <span>Fichier</span><span>${esc(ps.filename || '—')}</span>
    <span>Progression</span><span>${(prog * 100).toFixed(1)} %${layer ? ` · couche ${layer}/${total || '?'}` : ''}</span>
    <span>Écoulé</span><span>${fmtDuration(elapsed)}</span>
    <span>Restant</span><span>${eta !== null && state === 'printing' ? fmtDuration(eta) + ' (fin vers ' + new Date(Date.now() + eta * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + ')' : '—'}</span>
    <span>Filament</span><span>${((ps.filament_used || 0) / 1000).toFixed(2)} m</span></div>`;
  document.getElementById('job-progress').style.width = (prog * 100) + '%';
  document.getElementById('p-pause').disabled = state !== 'printing';
  document.getElementById('p-resume').disabled = state !== 'paused';
  document.getElementById('p-cancel').disabled = !['printing', 'paused'].includes(state);

  const heaters = [['extruder', 'Buse', 'M104 S'], ['heater_bed', 'Plateau', 'M140 S'], ['heater_generic chamber', 'Caisson', 'M141 S']];
  const tEl = document.getElementById('temps');
  if (!tEl.dataset.built) {
    tEl.innerHTML = heaters.filter(([k]) => s[k]).map(([k, label, cmd]) => `<div class="temp-row"><span>${label}</span>
      <span class="cur" data-cur="${k}"></span><input type="number" placeholder="Cible" data-cmd="${cmd}" min="0" max="350"></div>`).join('');
    tEl.querySelectorAll('input').forEach((i) => i.onchange = () => { gcode(i.dataset.cmd + (parseFloat(i.value) || 0)); i.blur(); });
    tEl.dataset.built = '1';
  }
  for (const [k] of heaters) {
    const el = tEl.querySelector(`[data-cur="${k}"]`);
    if (el && s[k]) el.textContent = `${(s[k].temperature ?? 0).toFixed(1)} / ${(s[k].target ?? 0).toFixed(0)} °C`;
  }
  renderBox(box);
}

function renderBox(box) {
  const el = document.getElementById('box');
  if (!box) { el.innerHTML = '<p class="muted">Pas de QIDI Box détectée</p>'; return; }
  const dry = box.drying && Object.values(box.drying).some((d) => d.dry_state);
  document.getElementById('box-env').textContent = [box.temperature != null ? `${box.temperature.toFixed(0)} °C` : '',
    box.humidity != null ? `${box.humidity.toFixed(0)} % HR` : '', dry ? 'séchage en cours' : ''].filter(Boolean).join(' · ');
  el.innerHTML = box.slots.slice(0, 4).map((sl) => `
    <div class="slot-card ${sl.loaded ? '' : 'empty'}">
      <div class="t">Bobine n°${sl.index + 1}</div>
      <div class="spool" style="background:${esc(sl.color)}"></div>
      <div>${sl.loaded ? esc(sl.type) : 'Vide'}</div>
      <div class="muted small" title="${esc(sl.vendor + ' ' + sl.filament)}">${sl.loaded ? esc(sl.vendor) : '&nbsp;'}</div>
      <div class="row gap" style="justify-content:center;margin-top:4px">
        <button class="icon" title="Charger dans la buse" data-load="${sl.index}">↓</button>
        <button class="icon" title="Décharger de la buse" data-unload="${sl.index}">↑</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('[data-load]').forEach((b) => b.onclick = async () => {
    if (await confirm2('Charger le filament', `Charger la bobine n°${+b.dataset.load + 1} dans la buse ?`, 'Charger')) gcode(`EXTRUDER_LOAD SLOT=slot${b.dataset.load}`);
  });
  el.querySelectorAll('[data-unload]').forEach((b) => b.onclick = async () => {
    if (await confirm2('Décharger le filament', `Décharger la bobine n°${+b.dataset.unload + 1} de la buse ?`, 'Décharger')) gcode(`EXTRUDER_UNLOAD SLOT=slot${b.dataset.unload}`);
  });
}

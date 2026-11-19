// Orca Web — logique principale de l'interface.
import { api, toast, busy, modal, prompt2, confirm2, esc, fmtDuration, parseOrcaTime } from './api.js';
import { setSchema, renderSettings, optDef, scalar, objectOptionKeys } from './settings.js';
import { Plate, parseArea } from './plate.js';
import { loadBedAssets } from './bed.js';
import { lang, setLang, startTranslation } from './i18n.js';
import { Preview, parseGcode, typeLabel } from './preview.js';
import { initDevice, setDeviceActive, lastStatus, onStatus } from './device.js';
import { icon, hydrateIcons } from './icons.js';
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'orca-web-state-v1';

const S = {
  info: null,
  machines: [], processes: [], filamentChoices: [], favs: [], mfavs: [],
  machine: null, process: null,
  filaments: [],                      // [{profile, colour}]
  ov: { machine: {}, process: {}, filament: [] },
  flush: null, flushMult: null,       // matrice de purge (null = calcul auto d'Orca), multiplicateur de projet
  wipeTower: [],                      // position de la tour de purge par plateau [[x, y] | null]
  spools: {}, slotSpool: [],          // bobines PrintLab (id -> bobine) et bobine associée à chaque emplacement de la Box
  calibPost: null,                    // calibration : post-traitement du G-code
  layerGcodes: {},                    // changements par couche, par plateau : { index: [{z, type, extruder, color, extra}] }
  resolved: { machine: {}, process: {}, filament: {} },
  page: 0, advanced: false, level: 0, search: '', scope: 'global',
  bedType: null,
  multi: new Set(),
  plateSettings: {},                 // réglages propres à chaque plateau (bed_type, print_sequence, spiral_mode)                   // objets sélectionnés en plus (Ctrl+clic) pour « Assembler »                      // type de plateau (curr_bed_type d'Orca)
  jobs: {},                           // découpes par plateau : { index: { job, gcodeData } }
  selectedPart: null,
  projectName: null,
  job: null, gcodeData: null,
};

// ---------- démarrage ----------
async function boot() {
  startTranslation();
  busy('Chargement…');
  try {
    const [info, schema] = await Promise.all([api('/slicer/api/info'), api('/slicer/api/schema' + (lang() === 'en' ? '?lang=en' : ''))]);
    S.info = info;
    setSchema(schema);
    $('orca-version').textContent = 'OrcaSlicer ' + info.orca_version;
    [S.machines] = await Promise.all([api('/slicer/api/profiles/machines'),
      api('/slicer/api/machine-favorites').then((r) => { S.mfavs = r.names || []; }).catch(() => {})]);
    fillMachineSelect();
    const saved = loadLocal();
    await setMachine(saved?.machine && S.machines.some((m) => m.name === saved.machine) ? saved.machine : info.default_machine, saved);
    if (saved?.objects?.length) await restoreObjects(saved.objects, saved.plates);
    loadSpools();
  } catch (e) {
    toast('Erreur au chargement : ' + e.message, 'err', 8000);
  }
  busy(false);
  startTour();
}

// ---------- état local (dernier plateau, par navigateur) ----------
function loadLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; } }
let saveTimer = null;
function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const js = JSON.stringify(snapshot());
    try { localStorage.setItem(LS_KEY, js); } catch {}
    recordHistory(js);
  }, 400);
}

// ---------- annuler / rétablir (Ctrl+Z / Ctrl+Y, comme Orca) ----------
// Chaque état enregistré du projet (objets, peinture, réglages, filaments, plateaux) est une étape ; pas de limite de nombre,
// seulement une limite de mémoire (les étapes les plus anciennes sont oubliées au-delà de ~150 Mo).
const HIST = { stack: [], idx: -1, busy: false, bytes: 0 };
function recordHistory(js) {
  if (HIST.busy || HIST.stack[HIST.idx] === js) return;
  for (const s of HIST.stack.splice(HIST.idx + 1)) HIST.bytes -= s.length;
  HIST.stack.push(js); HIST.bytes += js.length; HIST.idx = HIST.stack.length - 1;
  while (HIST.bytes > 150e6 && HIST.stack.length > 2) { HIST.bytes -= HIST.stack.shift().length; HIST.idx--; }
  updateUndoButtons();
}
function updateUndoButtons() {
  $('t-undo')?.toggleAttribute('disabled', HIST.idx <= 0);
  $('t-redo')?.toggleAttribute('disabled', HIST.idx >= HIST.stack.length - 1);
}
async function undoRedo(dir) {
  if (HIST.busy) return;
  clearTimeout(saveTimer);
  const cur = JSON.stringify(snapshot());
  if (cur !== HIST.stack[HIST.idx]) recordHistory(cur);           // modification pas encore enregistrée
  const to = HIST.idx + dir;
  if (to < 0 || to >= HIST.stack.length) { toast(dir < 0 ? 'Rien à annuler' : 'Rien à rétablir'); return; }
  HIST.busy = true;
  try {
    await applySnapshot(JSON.parse(HIST.stack[to]));
    HIST.idx = to;
    clearTimeout(saveTimer);
    try { localStorage.setItem(LS_KEY, HIST.stack[to]); } catch {}
  } catch (e) { toast('Annuler : ' + e.message, 'err'); }
  HIST.busy = false;
  updateUndoButtons();
}
async function applySnapshot(snap) {
  const selIdx = plate.selected ? plate.objects.indexOf(plate.selected) : -1;
  if (PAINT.active) paintToggle(false);
  if (snap.machine !== S.machine) await setMachine(snap.machine, snap);
  else {
    S.ov = snap.ov; S.flush = snap.flush || null; S.flushMult = snap.flushMult ?? null; S.wipeTower = snap.wipeTower || [];
    S.layerGcodes = snap.layerGcodes || {}; S.calibPost = snap.calibPost || null; S.filaments = snap.filaments; S.plateSettings = snap.plateSettings || {};
    S.level = snap.level ?? S.level; S.advanced = S.level > 0; $('level-sel').value = S.level;
    S.bedType = snap.bedType || S.bedType; $('sel-bed').value = S.bedType; bedTypeWarning();
    while (S.ov.filament.length < S.filaments.length) S.ov.filament.push({});
    await Promise.all(S.filaments.map((f) => resolveProfile('filament', f.profile)));
    if (snap.process !== S.process) await setProcess(snap.process, true);
    renderFilaments(); renderPanel();
  }
  plate.clear();
  await restoreObjects(snap.objects || [], snap.plates);
  S.multi.clear();
  if (selIdx >= 0 && plate.objects[selIdx]) plate.select(plate.objects[selIdx]);
  renderObjectList(); renderObjectPanel?.();
}

// ---------- sélection multiple, presse-papiers (Ctrl+C / Ctrl+X / Ctrl+V) ----------
function selection() {
  const list = plate.selected ? [plate.selected] : [];
  for (const o of plate.objects) if (S.multi.has(o.id) && !list.includes(o)) list.push(o);
  return list;
}
function selectAll(allPlates = false) {
  const list = allPlates ? plate.objects : plate.objectsOf(plate.current);
  if (!list.length) return;
  S.multi = new Set(list.slice(1).map((o) => o.id));
  plate.select(list[0]);
  renderObjectList();
}
function removeSelection() {
  const list = selection();
  S.multi.clear();
  for (const o of list) plate.remove(o);
  saveLocal();
}
let CLIP = [];
function copySelection(cut = false) {
  const list = selection();
  if (!list.length) return;
  const all = plate.serialize();
  CLIP = list.map((o) => JSON.parse(JSON.stringify(all[plate.objects.indexOf(o)])));
  toast(`${list.length} objet(s) ${cut ? 'coupé(s)' : 'copié(s)'}`);
  if (cut) removeSelection();
}
async function pasteClipboard() {
  if (!CLIP.length) { toast('Le presse-papiers est vide'); return; }
  const added = [];
  for (const o of CLIP) {
    const c = await plate.addObject({ ...o, matrix: o.matrix.slice() });
    plate.arrangeIfOverlap(c);
    added.push(c);
  }
  S.multi = new Set(added.slice(1).map((o) => o.id));
  plate.select(added[0]);
  renderObjectList(); saveLocal();
}
function nudgeSelection(dx, dy, rotDeg = 0) {
  const list = selection();
  if (!list.length) return;
  for (const o of list) {
    const g = o.group;
    if (rotDeg) g.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), rotDeg * Math.PI / 180);
    g.position.x += dx; g.position.y += dy;
    plate._afterTransform(o, true);
  }
  plate.hooks.onChange?.();
  renderObjectPanel();
}
function snapshot() {
  return {
    machine: S.machine, process: S.process, filaments: S.filaments, ov: S.ov, flush: S.flush, flushMult: S.flushMult, wipeTower: S.wipeTower, layerGcodes: S.layerGcodes, calibPost: S.calibPost, plateSettings: S.plateSettings,
    objects: plate.serialize(), advanced: S.level > 0, level: S.level, bedType: S.bedType,
    plates: { count: plate.plateCount, names: plate.plateNames, current: plate.current },
  };
}

// ---------- profils ----------
function fillMachineSelect() {
  const sel = $('sel-machine');
  const byVendor = {};
  // « Mes imprimantes » : seules les imprimantes cochées (+ celle sélectionnée) ; rien de coché = toutes
  const fav = new Set(S.mfavs);
  for (const m of S.machines) if (!fav.size || fav.has(m.name) || m.name === S.machine) (byVendor[m.vendor] ||= []).push(m);
  const vendors = Object.keys(byVendor).sort((a, b) => (a === 'Utilisateur' ? -2 : a === 'Qidi' ? -1 : 0) - (b === 'Utilisateur' ? -2 : b === 'Qidi' ? -1 : 0) || a.localeCompare(b));
  sel.innerHTML = vendors.map((v) => `<optgroup label="${esc(v)}">${byVendor[v].map((m) => `<option>${esc(m.name)}</option>`).join('')}</optgroup>`).join('')
    + `<optgroup label="──────────"><option value="__favs__">${fav.size ? 'Mes imprimantes… (' + fav.size + ' cochées)' : 'Choisir mes imprimantes…'}</option></optgroup>`;
}

async function resolveProfile(kind, name) {
  if (!S.resolved[kind][name]) S.resolved[kind][name] = (await api(`/slicer/api/profiles/${kind}/resolve?name=${encodeURIComponent(name)}`)).settings;
  return S.resolved[kind][name];
}

async function setMachine(name, saved = null) {
  S.machine = name;
  $('sel-machine').value = name;
  const [mcfg, procs, fils] = await Promise.all([
    resolveProfile('machine', name),
    api('/slicer/api/profiles/processes?machine=' + encodeURIComponent(name)),
    api('/slicer/api/profiles/filaments?machine=' + encodeURIComponent(name)),
    api('/slicer/api/filament-favorites').then((r) => { S.favs = r.names || []; }).catch(() => {}),
  ]);
  S.processes = procs; S.filamentChoices = fils;
  $('machine-cover').src = '/slicer/api/profiles/machine/cover?name=' + encodeURIComponent(name);
  $('machine-cover').onerror = function () { this.style.visibility = 'hidden'; };
  $('machine-cover').onload = function () { this.style.visibility = 'visible'; };
  $('sel-process').innerHTML = groupOptions(procs, (p) => p.vendor === 'Utilisateur' ? 'Utilisateur' : 'Système');

  if (saved) {
    S.ov = { machine: saved.ov?.machine || {}, process: saved.ov?.process || {}, filament: saved.ov?.filament || [] };
    S.flush = saved.flush || null;
    S.flushMult = saved.flushMult ?? null;
    S.wipeTower = saved.wipeTower || [];
    S.plateSettings = saved.plateSettings || {};
    S.layerGcodes = saved.layerGcodes || {};
    S.calibPost = saved.calibPost || null;
    S.level = saved.level ?? (saved.advanced ? 1 : 0);
    S.advanced = S.level > 0;
    $('level-sel').value = S.level;
    S.bedType = saved.bedType || null;
  } else {
    S.ov.machine = {};
  }
  const proc = saved?.process && procs.some((p) => p.name === saved.process) ? saved.process
    : (procs.find((p) => p.name === mcfg.default_print_profile)?.name || procs[0]?.name);
  await setProcess(proc, !!saved);
  fillBedTypes(mcfg);

  if (saved?.filaments?.length && saved.filaments.every((f) => fils.some((c) => c.name === f.profile))) {
    S.filaments = saved.filaments;
  } else if (!S.filaments.length || !S.filaments.every((f) => fils.some((c) => c.name === f.profile))) {
    const defs = (mcfg.default_filament_profile || []).map((n) => fils.find((f) => f.name === n || f.name.startsWith(n))).filter(Boolean);
    const first = defs[0] || fils.find((f) => f.vendor !== 'OrcaFilamentLibrary') || fils[0];
    S.filaments = [{ profile: first.name, colour: first.colour || '#F2754E' }];
    S.ov.filament = [{}];
  }
  while (S.ov.filament.length < S.filaments.length) S.ov.filament.push({});
  await Promise.all(S.filaments.map((f) => resolveProfile('filament', f.profile)));

  const area = parseArea(effective('machine', 'printable_area'));
  const exclude = parseExclude(effective('machine', 'bed_exclude_area'));
  const height = parseFloat(scalar(effective('machine', 'printable_height'))) || 250;
  plate.setBed({ area, height, exclude });
  preview.setBed(area, height);
  plate.setBedAssets(null); preview.setBedAssets(null);
  loadBedAssets(name).then((a) => { if (S.machine === name) { plate.setBedAssets(a); preview.setBedAssets(a); } });
  plate.view('iso');
  renderFilaments();
  renderPanel();
  saveLocal();
}

function parseExclude(v) {
  // Orca : liste de points "x0xy0, x1xy1, ..." formant un ou plusieurs polygones (fermés en revenant au point de départ)
  const pts = parseArea((Array.isArray(v) ? v.join(',') : String(v || '')).split(',').map((s) => s.trim()).filter(Boolean));
  const polys = []; let cur = [];
  for (const p of pts) {
    cur.push(p);
    if (cur.length > 2 && p[0] === cur[0][0] && p[1] === cur[0][1]) { polys.push(cur.slice(0, -1)); cur = []; }
  }
  if (cur.length > 2) polys.push(cur);
  return polys.filter((p) => p.length >= 3 && new Set(p.map((q) => q.join())).size >= 3);
}

function groupOptions(list, groupFn, short = false) {
  const groups = {};
  for (const it of list) (groups[groupFn(it)] ||= []).push(it);
  // short : comme Orca, on affiche le nom sans le suffixe « @imprimante » (le profil complet reste dans value / title)
  const label = (n) => (short ? n.replace(/\s*@.*$/, '') || n : n);
  return Object.entries(groups).map(([g, items]) => `<optgroup label="${esc(g)}">${items.map((i) => `<option value="${esc(i.name)}" title="${esc(i.name)}">${esc(label(i.name))}</option>`).join('')}</optgroup>`).join('');
}

// petit menu contextuel ancré sous un bouton ; items : [libellé, action] (null = ignoré)
function popMenu(anchor, items) {
  document.querySelector('.pop-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'pop-menu';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', off, true); };
  const off = (e) => { if (!m.contains(e.target)) close(); };
  for (const it of items.filter(Boolean)) {
    const b = document.createElement('button');
    b.textContent = it[0];
    b.onclick = () => { close(); it[1](); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.top = Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8) + 'px';
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', off, true));
}

async function setProcess(name, keepOverrides = false) {
  S.process = name;
  $('sel-process').value = name;
  if (!keepOverrides) S.ov.process = {};
  await resolveProfile('process', name);
  renderPanel();
  saveLocal();
}

// valeur effective d'une option : modification > profil > défaut Orca
function effective(kind, key, filIdx = 0) {
  if (kind === 'filament') {
    const ov = S.ov.filament[filIdx] || {};
    if (key in ov) return ov[key];
    const r = S.resolved.filament[S.filaments[filIdx]?.profile] || {};
    return key in r ? r[key] : optDef(key)?.default;
  }
  if (key in S.ov[kind]) return S.ov[kind][key];
  const r = S.resolved[kind][kind === 'machine' ? S.machine : S.process] || {};
  return key in r ? r[key] : optDef(key)?.default;
}

// ---------- filaments ----------
function renderFilaments() {
  const el = $('filament-list');
  el.innerHTML = '';
  const qidiFirst = (f) => f.vendor === 'Utilisateur' ? 'Utilisateur' : f.vendor === 'OrcaFilamentLibrary' ? 'Bibliothèque Orca' : f.vendor;
  // « Mes filaments » : seuls les profils cochés sont proposés (+ ceux déjà utilisés dans le projet) ; rien de coché = tout
  const fav = new Set(S.favs), used = new Set(S.filaments.map((f) => f.profile));
  const shown = fav.size ? S.filamentChoices.filter((f) => fav.has(f.name) || used.has(f.name)) : S.filamentChoices;
  const opts = groupOptions(shown, qidiFirst, true) + `<optgroup label="──────────"><option value="__favs__">${fav.size ? 'Mes filaments… (' + fav.size + ' cochés)' : 'Choisir mes filaments…'}</option></optgroup>`;
  syncMixed();
  S.filaments.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fil';
    const lum = luminance(f.colour);
    if (f.mixed) {
      const m = f.mixed;
      row.classList.add('mixed', 'fil-tile', 'span2');
      row.innerHTML = `<div class="num" style="background:${esc(f.colour)};color:${lum > 0.55 ? '#000' : '#fff'}" title="Couleur d'aperçu du mélange">${i + 1}</div>
        <span class="mixdesc" title="Filament mixte : le moteur d'Orca alterne ces filaments">${m.components.map((c, k) => `<span class="swatch" style="background:${esc(S.filaments[c - 1]?.colour || '#888')}"></span>${c}<small>${m.gradient ? '' : ` ${m.ratios[k]}%`}</small>`).join(' + ')}${m.gradient ? ' <small>dégradé</small>' : ''}</span>
        <span class="slot" title="Filament mixte (virtuel, pas d'emplacement dans la Box)">mix</span>
        <button class="icon" title="Modifier le mélange" data-mix>${icon('edit', 14)}</button><button class="icon" title="Retirer" data-del>✕</button>`;
      row.querySelector('[data-mix]').onclick = () => mixedModal(i);
      row.querySelector('[data-del]').onclick = () => removeFilament(i);
      el.appendChild(row);
      return;
    }
    row.innerHTML = `<div class="num" style="background:${esc(f.colour)};color:${lum > 0.55 ? '#000' : '#fff'}" title="Couleur">${i + 1}<input type="color" value="${esc(f.colour.slice(0, 7))}"></div>
      <select title="${esc(f.profile)}">${opts}</select>
      <button class="icon more" title="Plus d'actions" data-more>⋯</button>`;
    const sel = row.querySelector('select');
    sel.value = f.profile;
    sel.onchange = async () => { if (sel.value === '__favs__') { sel.value = f.profile; favsModal(); return; } f.profile = sel.value; S.ov.filament[i] = {}; await resolveProfile('filament', f.profile); renderFilaments(); saveLocal(); };
    row.querySelector('input[type=color]').oninput = (e) => { f.colour = e.target.value.toUpperCase(); row.querySelector('.num').style.background = f.colour; plate.refreshColours(); renderObjectList(); };
    row.querySelector('input[type=color]').onchange = () => { S.flush = null; renderFilaments(); saveLocal(); };
    row.querySelector('[data-more]').onclick = (e) => popMenu(e.currentTarget, [
      ['Réglages du filament…', () => editProfileModal('filament', i)],
      S.slotCount && i < S.slotCount ? [`Changer la bobine n°${i + 1}…`, () => spoolPicker(i)] : null,
      physCount() > 1 ? ['Retirer ce filament', () => removeFilament(i)] : null,
    ]);
    row.ondblclick = (e) => { if (e.target === row) editProfileModal('filament', i); };
    const tile = document.createElement('div');
    tile.className = 'fil-tile' + (S.slotEmpty?.[i] ? ' empty' : '');
    tile.appendChild(row);
    if (S.slotCount && i < S.slotCount) tile.appendChild(spoolChip(i));
    el.appendChild(tile);
  });
  const add = document.createElement('button');
  add.className = 'btn small mix-add span2';
  add.textContent = '+ Ajouter un filament mixte';
  add.title = 'Mélange de plusieurs filaments, alternés couche par couche par le moteur d\'Orca (Orca 2.5)';
  add.disabled = physCount() < 2;
  add.onclick = () => mixedModal(null);
  el.appendChild(add);
  plate.refreshColours();
  renderObjectList();
  if ($('sel-bed').options.length) bedTypeWarning();
}

// ---------- bobines PrintLab ----------
async function loadSpools() {
  try {
    const [box, spools] = await Promise.all([api('/api/box'), api('/api/spools')]);
    S.spools = Object.fromEntries(spools.map((x) => [x.id, x]));
    S.slotSpool = (box.slots || []).map((x) => x.spool_id || null);
    S.relayOf = (box.slots || []).map((x) => x.relay_of ?? null);
    // la Box ne détecte aucune bobine dans l'emplacement : on l'affiche vide (l'association PrintLab reste enregistrée)
    S.slotEmpty = box.online ? (box.slots || []).map((x) => x.box_inserted === false) : [];
    S.slotCount = (box.slots || []).length || 4;
  } catch { S.spools = {}; S.slotSpool = []; S.slotEmpty = []; S.slotCount = 0; }
  renderFilaments();
}

function spoolOf(i) { const id = S.slotSpool[i]; return id ? S.spools[id] || null : null; }
function spoolName(sp) { return `${sp.vendor_name || ''} ${sp.filament_name || ''}`.trim(); }

function spoolChip(i) {
  if (S.slotEmpty?.[i]) {
    const d = document.createElement('div');
    d.className = 'spool-chip none';
    d.title = 'La Box ne détecte aucune bobine dans l\'emplacement n°' + (i + 1) + '. Ce filament reste dans la liste pour que les suivants gardent leur bobine.';
    d.innerHTML = `<span class="slot">N°${i + 1}</span><span class="n">vide</span>`;
    d.onclick = () => spoolPicker(i);
    return d;
  }
  const sp = spoolOf(i);
  const d = document.createElement('div');
  d.className = 'spool-chip' + (sp ? '' : ' none') + (sp?.low ? ' low' : '');
  d.title = 'Bobine n°' + (i + 1) + ' de la Box (clic pour changer)';
  d.innerHTML = `<span class="slot">N°${i + 1}</span>` + (sp ? `<span class="swatch" style="background:#${esc(sp.color_hex || '888')}"></span><span class="n" title="${esc(spoolName(sp))}">${esc(spoolName(sp))}</span><b>${Math.round(sp.remaining_weight ?? 0)} g</b>`
    : '<span class="n">Associer une bobine…</span>');
  d.onclick = () => spoolPicker(i);
  return d;
}

async function spoolPicker(i) {
  const f = S.filaments[i];
  const type = String(scalar(effective('filament', 'filament_type', i)) || '').toUpperCase();
  const list = Object.values(S.spools).filter((x) => !x.archived)
    .sort((a, b) => (String(b.material).toUpperCase() === type) - (String(a.material).toUpperCase() === type) || spoolName(a).localeCompare(spoolName(b)));
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">Bobine n°<b>${i + 1}</b> de la Box (même association que la page Box de PrintLab). Matière du filament ${i + 1} : ${esc(type || '?')}.</p>
    <label class="check"><input type="checkbox" id="sp-apply" checked> Reprendre la couleur et le profil Orca de la bobine</label>
    <div class="list-pick" style="max-height:50vh;overflow:auto;margin-top:8px">
      <button class="btn" data-sp="" style="display:block;width:100%;text-align:left;margin-bottom:4px">— Aucune bobine</button>
      ${list.map((x) => `<button class="btn ${x.id === S.slotSpool[i] ? 'primary' : ''}" data-sp="${x.id}" style="display:flex;gap:6px;align-items:center;width:100%;text-align:left;margin-bottom:4px">
        <span class="swatch" style="background:#${esc(x.color_hex || '888')}"></span><span style="flex:1">${esc(spoolName(x))} <span class="muted small">${esc(x.material || '')}${x.slot != null && x.slot !== i ? ` · déjà en A${x.slot + 1}` : ''}</span></span>
        <b>${Math.round(x.remaining_weight ?? 0)} g</b></button>`).join('')}</div>`;
  const md = modal(`Bobine du filament ${i + 1}`, wrap);
  wrap.querySelectorAll('[data-sp]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.sp ? +b.dataset.sp : null;
    try {
      await api('/api/box/slots/' + i, { method: 'PUT', json: { spool_id: id } });
      md.close();
      const sp = id ? S.spools[id] : null;
      if (sp && $('sp-apply').checked) {
        f.colour = ('#' + (sp.color_hex || '808080')).toUpperCase();
        const prof = matchFilament({ vendor: sp.vendor_name === 'Bambu Lab' ? 'Bambu' : sp.vendor_name, filament: `${sp.material || ''} ${sp.finish || ''}`.trim(), type: sp.material });
        if (prof && prof.name !== f.profile) { f.profile = prof.name; S.ov.filament[i] = {}; await resolveProfile('filament', f.profile); }
        S.flush = null;
      }
      await loadSpools();
      saveLocal();
      toast(sp ? `Bobine n°${i + 1} : ${spoolName(sp)}` : `Bobine n°${i + 1} : aucune bobine`);
    } catch (e) { toast(e.message, 'err'); }
  });
}

// Grammes prévus par emplacement réel (un filament mixte est réparti sur ses composants, comme le fait le G-code)
function spoolCheck(g) {
  const out = [];
  S.filaments.forEach((f, i) => {
    if (f.mixed) return;
    const need = +(g[i] || 0);
    const sp = spoolOf(i);
    if (need > 0 && sp) out.push({ i, need, sp, ok: (sp.remaining_weight ?? 0) >= need });
  });
  return out;
}

// ---------- filaments mixtes (Orca 2.5 : filament_is_mixed, filament_mixed_*) ----------
function physCount() { return S.filaments.filter((f) => !f.mixed).length; }

// Couleur d'aperçu du mélange (Orca utilise un modèle de pigments ; ici mélange en lumière linéaire, affichage seulement)
function blendColour(cols, weights) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const srgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const tot = weights.reduce((a, b) => a + b, 0) || 1;
  const acc = [0, 0, 0];
  cols.forEach((c, k) => { const h = (c || '#808080').replace('#', ''); [0, 2, 4].forEach((j, n) => { acc[n] += lin(parseInt(h.substr(j, 2), 16)) * weights[k] / tot; }); });
  return '#' + acc.map((v) => srgb(Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Profil et couleur d'un emplacement mixte suivent ses composants (comme create_mixed_filament_from_result)
function syncMixed() {
  for (const f of S.filaments) {
    if (!f.mixed) continue;
    const m = f.mixed;
    f.profile = S.filaments[m.components[0] - 1]?.profile || f.profile;
    f.colour = blendColour(m.components.map((c) => S.filaments[c - 1]?.colour), m.gradient ? m.components.map(() => 50) : m.ratios);
  }
}

function mixedModal(idx) {
  const n = physCount();
  if (n < 2) { toast('Il faut au moins 2 filaments réels'); return; }
  const cur = idx != null ? S.filaments[idx].mixed : { components: [1, 2], ratios: [50, 50], gradient: false, dir: 1, perPart: false };
  const wrap = document.createElement('form');
  const phys = S.filaments.slice(0, n);
  wrap.innerHTML = `<p class="muted small">Le moteur d'Orca imprime ce « filament » en alternant les filaments choisis, dans les proportions indiquées (ou en dégradé sur la hauteur).
      Attribue-le ensuite à un objet comme un filament normal.</p>
    <table class="cmp"><tr><th>Filament</th><th>Utilisé</th><th>Proportion %</th></tr>
    ${phys.map((f, i) => { const k = cur.components.indexOf(i + 1); return `<tr><td><span class="swatch" style="background:${esc(f.colour)}"></span> ${i + 1} · ${esc(f.profile.split('@')[0])}</td>
      <td><input type="checkbox" data-c="${i + 1}" ${k >= 0 ? 'checked' : ''}></td><td><input type="number" min="1" max="99" data-r="${i + 1}" value="${k >= 0 ? cur.ratios[k] : 50}" style="width:70px"></td></tr>`; }).join('')}</table>
    <label class="check" style="margin-top:8px"><input type="checkbox" name="grad" ${cur.gradient ? 'checked' : ''}> Dégradé sur la hauteur (2 filaments seulement)</label>
    <div class="row gap" style="margin:4px 0 0 22px"><select name="dir"><option value="1" ${cur.dir === 1 ? 'selected' : ''}>du 2ᵉ vers le 1ᵉʳ en montant (10 % → 90 % du 1ᵉʳ)</option><option value="0" ${cur.dir === 0 ? 'selected' : ''}>du 1ᵉʳ vers le 2ᵉ en montant (90 % → 10 % du 1ᵉʳ)</option></select>
      <label class="check"><input type="checkbox" name="pp" ${cur.perPart ? 'checked' : ''}> par pièce</label></div>
    <div class="row gap" style="margin-top:10px;align-items:center"><span class="swatch" id="mix-prev" style="width:28px;height:18px"></span><span class="muted small">aperçu (approximatif)</span><span style="flex:1"></span><button class="btn primary">${idx != null ? 'Enregistrer' : 'Ajouter'}</button></div>`;
  const md = modal(idx != null ? `Filament mixte ${idx + 1}` : 'Ajouter un filament mixte', wrap);
  const read = () => {
    const comps = [...wrap.querySelectorAll('[data-c]')].filter((c) => c.checked).map((c) => +c.dataset.c);
    const ratios = comps.map((c) => Math.max(1, parseInt(wrap.querySelector(`[data-r="${c}"]`).value) || 1));
    return { comps, ratios, grad: wrap.grad.checked && comps.length === 2 };
  };
  const prev = () => { const { comps, ratios, grad } = read(); $('mix-prev').style.background = comps.length >= 2 ? blendColour(comps.map((c) => phys[c - 1].colour), grad ? comps.map(() => 50) : ratios) : 'transparent'; };
  wrap.addEventListener('input', prev); prev();
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const { comps, ratios, grad } = read();
    if (comps.length < 2) { toast('Choisis au moins 2 filaments'); return; }
    // proportions ramenées à 100 (format_mixed_ratios d'Orca normalise de la même façon)
    const tot = ratios.reduce((a, b) => a + b, 0);
    const pct = ratios.map((r) => Math.round(r * 100 / tot)); pct[0] += 100 - pct.reduce((a, b) => a + b, 0);
    const mixed = { components: comps, ratios: pct, gradient: grad, dir: +wrap.dir.value, perPart: grad && wrap.pp.checked };
    if (idx != null) S.filaments[idx].mixed = mixed;
    else { S.filaments.push({ profile: phys[comps[0] - 1].profile, colour: '#808080', mixed }); S.ov.filament.push({}); }
    S.flush = null;
    md.close(); renderFilaments(); saveLocal();
  };
}

// Options de projet d'Orca pour les emplacements mixtes (tableaux parallèles à filament_colour)
function mixedOverrides() {
  if (!S.filaments.some((f) => f.mixed)) return {};
  const fmt = (r) => (r / 100).toFixed(4);
  return {
    filament_is_mixed: S.filaments.map((f) => (f.mixed ? '1' : '0')),
    filament_mixed_components: S.filaments.map((f) => (f.mixed ? f.mixed.components.join(',') : '')),
    filament_mixed_sublayer_ratios: S.filaments.map((f) => (f.mixed ? f.mixed.ratios.map(fmt).join(',') : '')),
    filament_mixed_gradient: S.filaments.map((f) => (f.mixed?.gradient ? '1' : '0')),
    filament_mixed_gradient_range: S.filaments.map((f) => (f.mixed?.gradient && f.mixed.components.length === 2 ? (f.mixed.dir === 0 ? '0.9000,0.1000' : '0.1000,0.9000') : '')),
    filament_mixed_gradient_curve: S.filaments.map(() => ''),
    filament_mixed_gradient_per_part: S.filaments.map((f) => (f.mixed?.gradient && f.mixed.perPart ? '1' : '0')),
    filament_multi_colour: S.filaments.map((f) => f.colour),
  };
}

function luminance(hex) {
  const h = (hex || '#888').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.substr(k, 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function addFilament(profile = null, colour = null) {
  const n = physCount();
  const last = S.filaments[n - 1];
  const palette = ['#F2754E', '#2E86DE', '#27AE60', '#F1C40F', '#8E44AD', '#E74C3C', '#1ABC9C', '#FFFFFF', '#222222'];
  // les filaments mixtes restent après les filaments réels : on insère avant eux et on renumérote leurs utilisateurs
  S.filaments.splice(n, 0, { profile: profile || last.profile, colour: colour || palette[n % palette.length] });
  S.ov.filament.splice(n, 0, {});
  if (S.filaments.length > n + 1) {
    for (const o of plate.objects) { if (o.extruder > n) o.extruder++; for (const pt of o.parts) if (pt.extruder > n) pt.extruder++; }
    for (const l of Object.values(S.layerGcodes)) for (const t of l) if (t.extruder > n) t.extruder++;
  }
  S.flush = null;
  await resolveProfile('filament', S.filaments.at(-1).profile);
  renderFilaments(); saveLocal();
}

function removeFilament(i) {
  const users = S.filaments.map((f, k) => (f.mixed?.components.includes(i + 1) ? k + 1 : 0)).filter(Boolean);
  if (!S.filaments[i].mixed && users.length) { toast(`Ce filament fait partie du filament mixte ${users.join(', ')} : retire d'abord le mélange`, 'warn', 6000); return; }
  S.filaments.splice(i, 1); S.ov.filament.splice(i, 1); S.flush = null;
  for (const f of S.filaments) if (f.mixed) f.mixed.components = f.mixed.components.map((c) => (c > i + 1 ? c - 1 : c));
  for (const o of plate.objects) {
    if (o.extruder === i + 1) o.extruder = 1; else if (o.extruder > i + 1) o.extruder--;
    for (const p of o.parts) if (p.extruder === i + 1) p.extruder = 0; else if (p.extruder > i + 1) p.extruder--;
  }
  renderFilaments(); saveLocal();
}

// Récupère les filaments chargés dans la QIDI Box (T0..T3 = A1..A4)
async function syncBox() {
  busy('Lecture de la QIDI Box…');
  try {
    const st = await api('/slicer/api/printer/status');
    const box = st.box;
    if (!box) throw new Error('Aucune QIDI Box détectée sur l\'imprimante');
    const slots = box.slots.slice(0, Math.max(4, box.count * 4));
    let lastLoaded = -1;
    slots.forEach((s, i) => { if (s.loaded) lastLoaded = i; });
    if (lastLoaded < 0) throw new Error('Aucun filament chargé dans la Box');
    const fils = [], unmatched = [];
    for (let i = 0; i <= lastLoaded; i++) {
      const s = slots[i];
      const prof = matchFilament(s);
      if (!prof) unmatched.push(`n°${i + 1} (${s.vendor} ${s.filament})`);
      fils.push({ profile: (prof || S.filamentChoices[0]).name, colour: (s.color || '#808080').toUpperCase() });
    }
    const keep = S.filaments.filter((f) => f.mixed && f.mixed.components.every((c) => c <= fils.length));
    const dropped = S.filaments.filter((f) => f.mixed).length - keep.length;
    S.filaments = [...fils, ...keep];
    S.ov.filament = S.filaments.map(() => ({}));
    S.flush = null;
    await Promise.all(fils.map((f) => resolveProfile('filament', f.profile)));
    renderFilaments(); saveLocal();
    loadSpools();
    if (dropped) toast(`${dropped} filament(s) mixte(s) retiré(s) : leurs composants ne sont plus chargés`, 'warn', 6000);
    const empty = slots.slice(0, lastLoaded + 1).filter((s) => !s.loaded).map((s) => 'n°' + (s.index + 1));
    toast(`Box synchronisée : ${fils.length} filament(s)` + (empty.length ? ` — emplacement(s) vide(s) : ${empty.join(', ')}` : ''), empty.length ? 'warn' : '', 6000);
    if (unmatched.length) toast('Profil approximatif pour ' + unmatched.join(', '), 'warn', 7000);
  } catch (e) { toast(e.message, 'err'); }
  busy(false);
}

function matchFilament(slot) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
  const list = S.filamentChoices;
  const base = (n) => norm(n.split('@')[0]);
  const vendor = norm(slot.vendor), fil = norm(slot.filament), type = norm(slot.type);
  const tries = [
    `${vendor} ${fil}`, `${vendor} ${type}`, `${vendor} ${fil} basic`, `${vendor} ${type} basic`,
    vendor === 'qidi' ? `qidi ${fil}` : null, `generic ${fil}`, `generic ${type}`,
  ].filter(Boolean);
  const pref = (arr) => arr.find((f) => f.vendor !== 'OrcaFilamentLibrary') || arr[0];
  for (const t of tries) {
    const exact = list.filter((f) => base(f.name) === t);
    if (exact.length) return pref(exact);
  }
  const byType = list.filter((f) => norm(f.type) === type);
  return byType.length ? pref(byType.filter((f) => /generic/i.test(f.name)).length ? byType.filter((f) => /generic/i.test(f.name)) : byType) : null;
}

// ---------- panneau de réglages ----------
function renderPanel() {
  const obj = plate.selected;
  $('scope-object').disabled = !obj;
  if (S.scope === 'object' && !obj) S.scope = 'global';
  $('scope-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.scope === S.scope));
  $('scope-object').textContent = obj ? (S.selectedPart ? 'Pièce' : 'Objet') : 'Objet';
  const target = S.selectedPart || obj;
  if (S.scope === 'object' && target) {
    renderSettings({
      kind: 'process', container: $('settings-body'), pagesBar: $('settings-pages'),
      only: objectOptionKeys(), advanced: S.advanced, level: S.level, search: S.search, page: S.page,
      onPage: (i) => { S.page = i; renderPanel(); },
      base: (k) => effective('process', k),
      get: (k) => target.settings[k],
      set: (k, v) => { if (v === undefined) delete target.settings[k]; else target.settings[k] = v; renderPanel(); renderObjectList(); saveLocal(); },
    });
    return;
  }
  const r = S.resolved.process[S.process] || {};
  renderSettings({
    kind: 'process', container: $('settings-body'), pagesBar: $('settings-pages'),
    advanced: S.advanced, level: S.level, search: S.search, page: S.page,
    onPage: (i) => { S.page = i; renderPanel(); },
    base: (k) => (k in r ? r[k] : undefined),
    get: (k) => S.ov.process[k],
    set: (k, v) => { if (v === undefined) delete S.ov.process[k]; else S.ov.process[k] = v; renderPanel(); markProcessModified(); saveLocal(); },
  });
  markProcessModified();
}

function markProcessModified() {
  updateTowers();
  const n = Object.keys(S.ov.process).length;
  const opt = [...$('sel-process').options].find((o) => o.value === S.process);
  if (opt) opt.textContent = S.process + (n ? ` (modifié : ${n})` : '');
}

// profils correspondant à une bobine PrintLab : le meilleur réglé pour l'imprimante (Qidi) et le meilleur de la
// bibliothèque Orca (souvent plus précis : « Bambu PLA Matte »…) ; marque absente → profils « Generic » de la matière
const FAV_FINISH = ['basic', 'matte', 'silk', 'marble', 'metal', 'wood', 'rapido', 'translucent', 'tough', 'hf', 'galaxy', 'sparkle', 'glow', 'lite', 'pure', 'impact', 'dynamic', 'aero', 'cf', 'gf', 'support'];
function profilesForSpool(sp, choices) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
  const words = (x) => norm(x).replace(/\+/g, ' + ').split(/\s+/).filter(Boolean);
  const vend = norm(sp.vendor_name).split(' ')[0];
  const mat = norm(sp.material).replace(/\+/g, '');
  const want = new Set(words(`${sp.finish || ''} ${sp.filament_name || ''} ${sp.material || ''}`));
  const score = (f) => {
    const base = norm(f.name.split('@')[0]);
    const typ = norm(f.type).replace(/\+/g, '');
    if (typ !== mat || /support/.test(base)) return null;
    let s = base.startsWith(vend + ' ') ? 10 : base.startsWith('generic ') ? 2 : null;
    if (s === null) return null;
    for (const w of words(base)) if (FAV_FINISH.includes(w) || w === '+') s += want.has(w) ? 2 : -1;
    return s;
  };
  const best = (group) => {
    let top = null, ts = -1e9;
    for (const f of choices.filter(group)) { const s = score(f); if (s !== null && s > ts) { top = f; ts = s; } }
    return top;
  };
  return [best((f) => f.vendor !== 'OrcaFilamentLibrary' && f.vendor !== 'Utilisateur'), best((f) => f.vendor === 'OrcaFilamentLibrary')].filter(Boolean);
}

// choix des filaments proposés dans les menus (équivalent de « Sélectionner des filaments » d'Orca), enregistré dans PrintLab
// cfg des deux listes réduites : filaments (« Mes filaments ») et imprimantes (« Mes imprimantes »)
const FAVK = {
  filament: {
    title: 'Mes filaments', what: 'filament', endpoint: '/slicer/api/filament-favorites', key: 'favs', list: () => S.filamentChoices,
    group: (f) => f.vendor === 'Utilisateur' ? 'Mes profils' : f.vendor === 'OrcaFilamentLibrary' ? 'Bibliothèque Orca' : f.vendor,
    label: (f) => f.name.replace(/\s*@.*$/, '') || f.name, extra: (f) => f.type || '',
    hint: 'Un profil déjà utilisé dans un projet reste toujours proposé.', placeholder: 'Rechercher (ex. bambu abs, sunlu, petg…)',
    mine: ['Cocher ceux de mes bobines', 'Coche les profils qui correspondent aux bobines de PrintLab (marque, matière, finition)'],
    after: () => renderFilaments(), all: 'Tous les filaments sont proposés',
  },
  machine: {
    title: 'Mes imprimantes', what: 'imprimante', endpoint: '/slicer/api/machine-favorites', key: 'mfavs', list: () => S.machines,
    group: (m) => m.vendor, label: (m) => m.name, extra: (m) => m.nozzle ? `buse ${m.nozzle}` : '',
    hint: "L'imprimante sélectionnée reste toujours proposée.", placeholder: 'Rechercher (ex. qidi max 4, 0.4…)',
    mine: ["Cocher l'imprimante actuelle", "Coche l'imprimante sélectionnée et tes profils d'imprimante"],
    after: () => { fillMachineSelect(); $('sel-machine').value = S.machine; }, all: 'Toutes les imprimantes sont proposées',
  },
};

// choix des profils proposés dans les menus (équivalent de « Sélectionner des filaments / imprimantes » d'Orca),
// enregistré dans PrintLab
function favsModal(kind = 'filament') {
  const K = FAVK[kind];
  const sel = new Set(S[K.key]);
  const wrap = document.createElement('div');
  wrap.className = 'favs';
  wrap.innerHTML = `<p class="muted small" style="margin:0 0 8px">Coche les profils à proposer dans le menu. Rien de coché = tous (${K.list().length}). ${K.hint}</p>
    <div class="row gap" style="margin-bottom:8px"><input type="search" placeholder="${K.placeholder}" style="flex:1">
      <label class="small"><input type="checkbox" data-only> cochés seulement</label></div>
    <div class="favl" style="max-height:55vh;overflow:auto"></div>
    <div class="row gap" style="justify-content:space-between;margin-top:10px"><span class="muted small" data-count></span>
      <span class="row gap"><button class="btn" data-mine title="${K.mine[1]}">${K.mine[0]}</button><button class="btn" data-none>Tout décocher</button><button class="btn primary" data-ok>Enregistrer</button></span></div>`;
  const list = wrap.querySelector('.favl'), search = wrap.querySelector('input[type=search]'), only = wrap.querySelector('[data-only]');
  const count = () => { wrap.querySelector('[data-count]').textContent = sel.size ? `${sel.size} coché(s)` : 'Aucun coché : tous seront proposés'; };
  const render = () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const items = K.list().filter((f) => (!only.checked || sel.has(f.name)) && words.every((w) => (f.name + ' ' + K.group(f) + ' ' + K.extra(f)).toLowerCase().includes(w)));
    const groups = {};
    for (const f of items.slice(0, 600)) (groups[K.group(f)] ||= []).push(f);
    list.innerHTML = Object.entries(groups).map(([g, fs]) => `<div class="favg"><b>${esc(g)}</b> <span class="muted small">${fs.length}</span>${fs.map((f) =>
      `<label class="favi" title="${esc(f.name)}"><input type="checkbox" value="${esc(f.name)}" ${sel.has(f.name) ? 'checked' : ''}> ${esc(K.label(f))}${K.extra(f) ? ` <span class="muted small">${esc(K.extra(f))}</span>` : ''}</label>`).join('')}</div>`).join('')
      + (items.length > 600 ? `<p class="muted small">… ${items.length - 600} de plus : précise la recherche.</p>` : '') || '<p class="muted">Rien ne correspond.</p>';
    list.querySelectorAll('input[type=checkbox]').forEach((c) => c.onchange = () => { if (c.checked) sel.add(c.value); else sel.delete(c.value); count(); });
    count();
  };
  search.oninput = render; only.onchange = render;
  wrap.querySelector('[data-none]').onclick = () => { sel.clear(); render(); };
  wrap.querySelector('[data-mine]').onclick = async () => {
    try {
      const before = sel.size;
      if (kind === 'machine') {
        sel.add(S.machine);
        S.machines.filter((m) => m.vendor === 'Utilisateur').forEach((m) => sel.add(m.name));
        only.checked = true; search.value = ''; render();
        toast(`${sel.size - before} imprimante(s) cochée(s)`);
        return;
      }
      const spools = (await api('/api/spools')).filter((x) => !x.archived);
      const none = new Set();
      for (const sp of spools) {
        const fs = profilesForSpool(sp, S.filamentChoices);
        if (!fs.length) none.add(`${sp.vendor_name || ''} ${sp.material || ''}`.trim());
        fs.forEach((f) => sel.add(f.name));
      }
      only.checked = true; search.value = ''; render();
      toast(`${sel.size - before} profil(s) coché(s) pour ${spools.length} bobine(s)` + (none.size ? ` — rien trouvé pour : ${[...none].join(', ')}` : ''), none.size ? 'warn' : '', 7000);
    } catch (e) { toast(e.message, 'err'); }
  };
  const m = modal(K.title, wrap);
  wrap.querySelector('[data-ok]').onclick = async () => {
    try {
      const r = await api(K.endpoint, { method: 'PUT', json: { names: [...sel] } });
      S[K.key] = r.names || []; m.close(); K.after();
      toast(S[K.key].length ? `${S[K.key].length} ${K.what}(s) proposé(s) dans le menu` : K.all);
    } catch (e) { toast(e.message, 'err'); }
  };
  render();
  search.focus();
}

function editProfileModal(kind, filIdx = 0) {
  const wrap = document.createElement('div');
  const name = kind === 'machine' ? S.machine : S.filaments[filIdx].profile;
  wrap.innerHTML = `<div class="row gap" style="margin-bottom:8px"><b style="flex:1">${esc(name)}</b>
    <input type="search" placeholder="Rechercher…" style="width:180px">
    <button class="btn small" data-save>💾 Enregistrer comme profil</button></div>
    <div class="seg pages"></div><div class="body" style="max-height:60vh;overflow:auto"></div>`;
  const ovs = kind === 'machine' ? S.ov.machine : S.ov.filament[filIdx];
  const r = kind === 'machine' ? S.resolved.machine[S.machine] : S.resolved.filament[name];
  let page = 0, search = '';
  const render = () => renderSettings({
    kind, container: wrap.querySelector('.body'), pagesBar: wrap.querySelector('.pages'), advanced: true, level: Math.max(1, S.level), search, page,
    onPage: (i) => { page = i; render(); },
    base: (k) => (k in r ? r[k] : undefined),
    get: (k) => ovs[k],
    set: async (k, v) => {
      if (v === undefined) delete ovs[k]; else ovs[k] = v;
      render(); saveLocal();
      if (kind === 'machine' && /printable_area|printable_height|bed_exclude_area/.test(k)) await setMachine(S.machine, snapshot());
    },
  });
  wrap.querySelector('input[type=search]').oninput = (e) => { search = e.target.value; render(); };
  wrap.querySelector('[data-save]').onclick = async () => {
    const n = await prompt2('Enregistrer le profil', 'Nom du nouveau profil utilisateur', name.replace(/ \(.*\)$/, '') + ' (perso)');
    if (!n) return;
    try {
      await api('/slicer/api/profiles/' + kind, { json: { name: n, inherits: name, settings: { ...r, ...ovs } } });
      toast('Profil enregistré : ' + n);
      delete S.resolved[kind][n];
      if (kind === 'machine') {
        S.machines = await api('/slicer/api/profiles/machines'); fillMachineSelect(); S.ov.machine = {}; await setMachine(n, { ...snapshot(), machine: n, ov: { ...S.ov, machine: {} } });
      } else {
        S.filamentChoices = await api('/slicer/api/profiles/filaments?machine=' + encodeURIComponent(S.machine));
        S.filaments[filIdx].profile = n; S.ov.filament[filIdx] = {}; await resolveProfile('filament', n); renderFilaments(); saveLocal();
      }
    } catch (e) { toast(e.message, 'err'); }
  };
  render();
  modal(kind === 'machine' ? 'Profil imprimante' : `Filament ${filIdx + 1}`, wrap);
}

async function saveProcessProfile() {
  const base = S.process;
  const n = await prompt2('Enregistrer les réglages', 'Nom du profil utilisateur', base.replace(/ \(.*\)$/, '') + ' (perso)');
  if (!n) return;
  try {
    const r = S.resolved.process[base];
    await api('/slicer/api/profiles/process', { json: { name: n, inherits: base, settings: { ...r, ...S.ov.process } } });
    S.processes = await api('/slicer/api/profiles/processes?machine=' + encodeURIComponent(S.machine));
    $('sel-process').innerHTML = groupOptions(S.processes, (p) => p.vendor === 'Utilisateur' ? 'Utilisateur' : 'Système');
    delete S.resolved.process[n];
    await setProcess(n);
    toast('Profil enregistré : ' + n);
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- volumes de purge ----------
// Matrice calculée côté serveur, exactement comme le bouton « Auto-calc » d'Orca
async function flushAuto() {
  const r = await api('/slicer/api/flush-matrix', { json: { machine: S.machine, filaments: S.filaments.map((f) => f.profile), colours: S.filaments.map((f) => f.colour), mixed: S.filaments.map((f) => !!f.mixed) } });
  return r.matrix;
}

async function flushModal() {
  const cols = S.filaments.map((f) => f.colour);
  const n = cols.length;
  if (n < 2) { toast('Il faut au moins 2 filaments'); return; }
  let auto;
  try { auto = await flushAuto(); } catch (e) { toast(e.message, 'err'); return; }
  const m = S.flush && S.flush.length === n * n ? [...S.flush] : [...auto];
  const mult = S.flushMult ?? '0.3';
  const wrap = document.createElement('div');
  const sw = (c, i) => `<span class="swatch" style="background:${c}"></span> ${i + 1}`;
  wrap.innerHTML = `<p class="muted small">Volume purgé (mm³) en passant du filament de la ligne à celui de la colonne, calculé comme Orca d'après les couleurs, le volume de la buse et le type de filament.
      Le volume réellement purgé = valeur du tableau × multiplicateur.</p>
    <table class="flush"><tr><th>de \\ vers</th>${cols.map((c, j) => `<th>${sw(c, j)}</th>`).join('')}</tr>
    ${cols.map((c, i) => `<tr><th>${sw(c, i)}</th>${cols.map((_, j) => `<td><input type="number" min="0" data-k="${i * n + j}" value="${m[i * n + j]}" ${i === j ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}</table>
    <div class="row gap" style="margin-top:10px;align-items:center"><label class="small">Multiplicateur <input type="number" step="0.05" min="0" max="3" id="flush-mult" value="${esc(mult)}" style="width:70px"></label>
      <span style="flex:1"></span><button class="btn" data-auto>Recalculer (Auto-calc)</button><button class="btn primary" data-ok>Valider</button></div>`;
  const md = modal('Volumes de purge', wrap);
  wrap.querySelector('[data-auto]').onclick = () => { wrap.querySelectorAll('input[data-k]').forEach((i) => i.value = auto[i.dataset.k]); };
  wrap.querySelector('[data-ok]').onclick = () => {
    const out = [...m]; wrap.querySelectorAll('input[data-k]').forEach((i) => out[i.dataset.k] = String(Math.max(0, parseInt(i.value) || 0)));
    // une matrice identique au calcul automatique reste « automatique » (recalculée si les couleurs changent)
    S.flush = out.every((v, k) => k % (n + 1) === 0 || v === String(auto[k])) ? null : out;
    const mv = Math.min(3, Math.max(0, parseFloat(wrap.querySelector('#flush-mult').value)));
    S.flushMult = Number.isFinite(mv) ? String(mv) : null;
    saveLocal(); md.close();
  };
}

// ---------- plateau ----------
// Rayon d'élargissement de la zone de dégagement autour de chaque objet (séquence « par objet »), 0 si inactive.
// Orca : extruder_clearance_max_radius / 2 (réglage de l'imprimante), séquence propre au plateau prioritaire.
function clearanceRadius(pi) {
  const seq = S.plateSettings[pi]?.print_sequence || scalar(effective('process', 'print_sequence'));
  if (seq !== 'by object') return 0;
  const r = parseFloat(scalar(effective('machine', 'extruder_clearance_max_radius')));
  return (Number.isFinite(r) && r > 0 ? r : 40) / 2;
}

const plate = new Plate($('viewport'), {
  colourOf: (ext) => S.filaments[(ext || 1) - 1]?.colour || '#cccccc',
  onSelect: (obj) => { if (PAINT.active && !obj) paintToggle(false); if (BRIM.active && obj !== BRIM.obj) brimToggle(false); S.selectedPart = null; if (!obj && S.scope === 'object') S.scope = 'global'; renderObjectPanel(); renderObjectList(); renderPanel(); },
  onChange: () => { renderObjectList(); saveLocal(); updatePlateInfo(); },
  onTransform: () => renderObjectPanel(),
  onLayFlatDone: () => $('t-layflat').classList.remove('active'),
  onPlate: () => { renderPlates(); renderObjectList(); showJob(); saveLocal(); },
  onTowerMove: (pi, x, y) => { S.wipeTower[pi] = [x, y]; saveLocal(); toast(`Tour de purge du plateau ${pi + 1} : X ${x.toFixed(1)} · Y ${y.toFixed(1)}`, '', 2500); },
  onMeasure: (m) => toast(`Distance ${m.d.toFixed(2)} mm — X ${m.dx.toFixed(2)} · Y ${m.dy.toFixed(2)} · Z ${m.dz.toFixed(2)}`, '', 12000),
  onPaint: () => onPaintChanged(),
  onBrim: () => { onPaintChanged(); renderBrimPanel(); },
  clearance: (pi) => clearanceRadius(pi),
  onTowerSelect: (t) => { if (t) toast('Tour de purge : fais-la glisser pour la déplacer (comme dans Orca)', '', 3000); },
});
const preview = new Preview($('preview-viewport'));
window.__plate = plate; window.__preview = preview;   // accès pour les tests automatiques (navigateur sans interface)

// ---------- type de plateau ----------
function fillBedTypes(mcfg) {
  const d = optDef('curr_bed_type');
  const sel = $('sel-bed');
  if (!d?.enum) { sel.closest('.bed-row').classList.add('hidden'); return; }
  sel.innerHTML = d.enum.map((v, i) => `<option value="${esc(v)}">${esc(d.enum_labels?.[i] || v)}</option>`).join('');
  // comme Orca : le type de plateau par défaut de l'imprimante, sinon le premier accepté par le filament
  const def = d.enum.find((v) => v === scalar(mcfg?.default_bed_type)) || (d.enum.includes('Textured PEI Plate') ? 'Textured PEI Plate' : d.default);
  if (!S.bedType || !d.enum.includes(S.bedType)) S.bedType = def;
  sel.value = S.bedType;
  bedTypeWarning();
}

const BED_TEMP_KEY = { 'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp',
  'Textured PEI Plate': 'textured_plate_temp', 'Textured Cool Plate': 'textured_cool_plate_temp', 'Supertack Plate': 'supertack_plate_temp' };

// vignettes d'Orca (Plater.cpp, bed_type_thumbnails)
const BED_ICON = { 'Cool Plate': 'bed_cool', 'Engineering Plate': 'bed_engineering', 'High Temp Plate': 'bed_high_templ',
  'Textured PEI Plate': 'bed_pei', 'Textured Cool Plate': 'bed_pei_cool', 'Supertack Plate': 'bed_cool_supertack' };

function bedTypeWarning() {
  // appelée à chaque changement de type de plateau : on met aussi la vignette à jour
  const img = $('bed-icon'), ic = BED_ICON[S.bedType];
  if (ic) img.src = `/slicer/static/img/bed/${ic}.png`;
  img.classList.toggle('hidden', !ic);
  const opt = $('sel-bed').selectedOptions[0];
  $('sel-bed').closest('.bed-pick').title = `Plateau : ${opt ? opt.textContent : S.bedType} — détermine la température de plateau (réglages du filament)`;
  const k = BED_TEMP_KEY[S.bedType];
  const bad = k ? S.filaments.map((f, i) => (+scalar(effective('filament', k, i)) === 0 ? i + 1 : 0)).filter(Boolean) : [];
  const el = $('bed-warn');
  el.textContent = bad.length ? `⚠ Filament ${bad.join(', ')} : température à 0 pour ce plateau (non imprimable selon le profil)` : '';
  el.classList.toggle('hidden', !bad.length);
}

// ---------- réglages du plateau (boîte « Réglages du plateau » d'Orca) ----------
function plateSettingsModal(i) {
  const cur = S.plateSettings[i] || {};
  const bt = optDef('curr_bed_type'), seq = optDef('print_sequence');
  const opts = (d, v) => `<option value="">Comme le projet</option>` + (d?.enum || []).map((x, k) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(d.enum_labels?.[k] || x)}</option>`).join('');
  const wrap = document.createElement('form');
  wrap.innerHTML = `<p class="muted small">Réglages propres à ${esc(plateLabel(i))}, enregistrés dans le projet .3mf comme dans Orca.</p>
    <label>Type de plateau<select name="bed_type">${opts(bt, cur.bed_type)}</select></label>
    <label style="margin-top:8px">Séquence d'impression<select name="print_sequence">${opts(seq, cur.print_sequence)}</select></label>
    <label style="margin-top:8px">Vase spirale<select name="spiral_mode"><option value="">Comme le projet</option><option value="1" ${cur.spiral_mode === '1' ? 'selected' : ''}>Oui</option><option value="0" ${cur.spiral_mode === '0' ? 'selected' : ''}>Non</option></select></label>
    <div class="row gap" style="justify-content:flex-end;margin-top:12px"><button class="btn primary">Enregistrer</button></div>`;
  const md = modal('Réglages du plateau', wrap);
  wrap.onsubmit = (e) => {
    e.preventDefault();
    const v = {};
    for (const k of ['bed_type', 'print_sequence', 'spiral_mode']) if (wrap[k].value) v[k] = wrap[k].value;
    if (Object.keys(v).length) S.plateSettings[i] = v; else delete S.plateSettings[i];
    if (S.jobs[i]) S.jobs[i].stale = true;
    md.close(); renderPlates(); saveLocal();
  };
}

// ---------- modificateurs par plage de hauteur (« Height range modifier » d'Orca) ----------
function rangesModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  const keys = [...objectOptionKeys()].filter((k) => optDef(k));
  const list = (o.layer_ranges || []).map((r) => ({ min_z: r.min_z, max_z: r.max_z, settings: { ...r.settings } }));
  const H = +(plate.worldBox(o).max.z).toFixed(2);
  const wrap = document.createElement('div');
  const draw = () => {
    wrap.innerHTML = `<p class="muted small">Comme « Modificateur par plage de hauteur » d'Orca : des réglages différents entre deux hauteurs de l'objet (hauteur ${H} mm).</p>
      ${list.map((r, i) => `<div class="card" style="padding:8px;margin:6px 0" data-r="${i}">
        <div class="row gap"><label>De <input type="number" step="0.1" data-k="min_z" value="${r.min_z}" style="width:80px"> mm</label>
          <label>à <input type="number" step="0.1" data-k="max_z" value="${r.max_z}" style="width:80px"> mm</label>
          <button class="icon" data-del title="Supprimer la plage">✕</button></div>
        ${Object.entries(r.settings).map(([k, v]) => `<div class="row gap small" style="margin-top:4px"><span style="flex:1">${esc(optDef(k)?.label || k)}</span>
          <input data-opt="${esc(k)}" value="${esc(String(v))}" style="width:110px"><button class="icon" data-rmopt="${esc(k)}">✕</button></div>`).join('')}
        <div class="row gap" style="margin-top:6px"><select data-add style="flex:1"><option value="">+ Ajouter un réglage…</option>${keys.map((k) => `<option value="${esc(k)}">${esc(optDef(k).label || k)}</option>`).join('')}</select></div>
      </div>`).join('')}
      <div class="row gap" style="justify-content:space-between;margin-top:8px"><button class="btn" data-new>+ Nouvelle plage</button><button class="btn primary" data-ok>Enregistrer</button></div>`;
    wrap.querySelectorAll('[data-r]').forEach((el) => {
      const r = list[+el.dataset.r];
      el.querySelectorAll('[data-k]').forEach((inp) => inp.onchange = () => { r[inp.dataset.k] = +inp.value; });
      el.querySelectorAll('[data-opt]').forEach((inp) => inp.onchange = () => { r.settings[inp.dataset.opt] = inp.value; });
      el.querySelectorAll('[data-rmopt]').forEach((b) => b.onclick = () => { delete r.settings[b.dataset.rmopt]; draw(); });
      el.querySelector('[data-del]').onclick = () => { list.splice(+el.dataset.r, 1); draw(); };
      el.querySelector('[data-add]').onchange = (e) => { const k = e.target.value; if (k) { r.settings[k] = String(scalar(effective('process', k)) ?? ''); draw(); } };
    });
    wrap.querySelector('[data-new]').onclick = () => {
      const last = list.length ? list[list.length - 1].max_z : 0;
      // comme Orca, une plage porte toujours sa hauteur de couche
      list.push({ min_z: +Math.min(last, H).toFixed(2), max_z: +Math.min(last + 5, H).toFixed(2), settings: { layer_height: String(scalar(effective('process', 'layer_height')) ?? '0.2') } }); draw();
    };
    wrap.querySelector('[data-ok]').onclick = () => {
      if (list.some((r) => !(r.max_z > r.min_z))) { toast('Chaque plage doit aller d\'une hauteur à une hauteur plus grande', 'warn'); return; }
      o.layer_ranges = list.filter((r) => Object.keys(r.settings).length);
      md.close(); onPaintChanged(); renderObjectList();
      toast(`${o.layer_ranges.length} plage(s) de hauteur sur « ${o.name} »`);
    };
  };
  const md = modal('Plages de hauteur', wrap);
  draw();
}

// ---------- export STL (Fichier → Exporter d'Orca) ----------
async function exportStl(all = false) {
  const objs = all ? plate.serialize(null, false) : plate.serialize(plate.current, true);
  if (!objs.length) { toast('Rien à exporter'); return; }
  busy('Export STL…');
  try {
    const r = await fetch('/slicer/api/export-stl', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sliceBody(objs, all ? (S.projectName || 'projet') : (plate.plateNames[plate.current] || S.projectName || `plateau-${plate.current + 1}`))) });
    if (!r.ok) throw new Error('Export impossible (' + r.status + ')');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'plateau.stl';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message, 'err'); }
  busy(false);
}

// ---------- plateaux ----------
function plateLabel(i) { return plate.plateNames[i] || `Plateau ${i + 1}`; }

function renderPlates() {
  const el = $('plates');
  const n = plate.plateCount;
  el.innerHTML = Array.from({ length: n }, (_, i) => {
    const cnt = plate.objectsOf(i).length;
    return `<button class="plate-chip ${i === plate.current ? 'active' : ''}" data-i="${i}" title="${esc(plateLabel(i))} — ${cnt} objet(s)${S.jobs[i] ? ' — découpé' : ''}. Double-clic : renommer">
      <b>${i + 1}</b>${plate.plateNames[i] ? `<span>${esc(plate.plateNames[i])}</span>` : ''}${Object.keys(S.plateSettings[i] || {}).length ? '<i class="ps" title="Réglages propres à ce plateau">⚙</i>' : ''}${S.jobs[i] ? '<i class="ok">✓</i>' : ''}</button>`;
  }).join('') + `<button class="plate-chip add" id="plate-add" title="Ajouter un plateau">+</button>` +
    `<button class="plate-chip add" id="plate-set" title="Réglages du plateau actif (type de plateau, séquence, vase) — comme Orca">⚙</button>` +
    `<button class="plate-chip add" id="plate-del" title="Supprimer le plateau actif et ses objets">${icon('trash', 13)}</button>`;
  el.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => { plate.setCurrent(+b.dataset.i); plate.view('iso'); };
    b.ondblclick = async () => {
      const i = +b.dataset.i;
      const v = await prompt2('Nom du plateau', `Nom du plateau ${i + 1} (« - » pour retirer le nom)`, plate.plateNames[i] || '');
      if (v === null || v === undefined) return;
      plate.plateNames[i] = String(v).trim() === '-' ? '' : String(v).trim(); renderPlates(); renderObjectList(); saveLocal();
    };
  });
  $('plate-add').onclick = () => { plate.addPlate(); };
  $('plate-set').onclick = () => plateSettingsModal(plate.current);
  $('plate-del').onclick = async () => {
    const i = plate.current, cnt = plate.objectsOf(i).length;
    if (plate.plateCount <= 1 && !cnt) return;
    const msg = plate.plateCount > 1 ? `Supprimer « ${esc(plateLabel(i))} »${cnt ? ` et ses ${cnt} objet(s)` : ''} ?` : `Retirer les ${cnt} objet(s) du plateau ?`;
    if (cnt && !await confirm2('Supprimer le plateau', msg, 'Supprimer', true)) return;
    const jobs = {};
    for (const [k, v] of Object.entries(S.jobs)) { if (+k < i) jobs[k] = v; else if (+k > i) jobs[+k - 1] = v; }
    S.jobs = plate.plateCount > 1 ? jobs : {};
    if (plate.plateCount > 1) S.wipeTower.splice(i, 1); else S.wipeTower = [];
    const lg = {};
    for (const [k, v] of Object.entries(S.layerGcodes)) { if (+k < i) lg[k] = v; else if (+k > i) lg[+k - 1] = v; }
    S.layerGcodes = plate.plateCount > 1 ? lg : {};
    plate.removePlate(i);
  };
  $('btn-slice-all').classList.toggle('hidden', n < 2);
}

// ---------- tour de purge ----------
// Position par défaut d'Orca (PartPlateList::set_default_wipe_tower_pos_for_plate) : (165, 250), ou (0, 250) pour une
// imprimante « i3 », ramenée sur le plateau avec une marge de 15 mm + bordure.
function towerDefault(w, d) {
  const b = plate.base || { minX: 0, maxX: 256, minY: 0, maxY: 256 };
  const i3 = scalar(effective('machine', 'printer_structure')) === 'i3';
  let x = i3 ? 0 : 165, y = 250;
  const brim = Math.max(0, parseFloat(scalar(effective('process', 'prime_tower_brim_width'))) || 3);
  const m = 15 + brim;
  const xmax = b.maxX - b.minX, ymax = b.maxY - b.minY;
  if (x + m + w > xmax) x = xmax - w - m; else if (x < m) x = m;
  if (y + m + d > ymax) y = ymax - d - m; else if (y < m) y = m;
  return [b.minX + x, b.minY + y];
}

function towerSize() {
  const w = parseFloat(scalar(effective('process', 'prime_tower_width'))) || 35;
  return [w, w];   // profondeur réelle calculée par Orca à la découpe (dépend des volumes purgés)
}

function plateNeedsTower(i) {
  if (scalar(effective('process', 'enable_prime_tower')) !== '1') return false;
  const mine = plate.objectsOf(i);
  if (!mine.length) return false;
  if (scalar(effective('process', 'print_sequence')) === 'by object' && mine.length > 1) return false;
  const ext = new Set();
  const addE = (e) => { const f = S.filaments[e - 1]; if (f?.mixed) f.mixed.components.forEach((c) => ext.add(c)); else ext.add(e); };
  for (const o of mine) { addE(o.extruder); for (const pt of o.parts) if ((pt.subtype === 'modifier_part' || pt.subtype === 'normal_part') && pt.extruder > 0) addE(pt.extruder); }
  return ext.size > 1;
}

function towerPos(i) {
  const [w, d] = towerSize();
  return S.wipeTower[i] || towerDefault(w, d);
}

function updateTowers() {
  const [w, d] = towerSize();
  const list = [];
  for (let i = 0; i < plate.plateCount; i++) {
    if (!plateNeedsTower(i)) continue;
    const h = Math.max(1, ...plate.objectsOf(i).map((o) => plate.worldBox(o).max.z));
    const [x, y] = towerPos(i);
    list.push({ plate: i, x, y, w, d, h });
  }
  const sig = JSON.stringify(list);
  if (sig !== S._towerSig) { S._towerSig = sig; plate.setTowers(list); }
}

// wipe_tower_x / wipe_tower_y pour tous les plateaux (options de projet d'Orca)
function towerOverrides() {
  const xs = [], ys = [];
  for (let i = 0; i < plate.plateCount; i++) { const [x, y] = towerPos(i); xs.push(String(+x.toFixed(3))); ys.push(String(+y.toFixed(3))); }
  return { wipe_tower_x: xs, wipe_tower_y: ys };
}

function updatePlateInfo() {
  updateTowers();
  const mine = plate.objectsOf(plate.current);
  const n = mine.length;
  const stray = plate.objects.filter((o) => o.plate < 0).length;
  const out = mine.filter((o) => o.outside).length + stray;
  $('plate-info').textContent = n ? `${n} objet(s)` + (out ? ` — ${out} hors du plateau !` : '') : 'Plateau vide';
  $('plate-info').style.color = out ? 'var(--warn)' : '';
  $('obj-count').textContent = plate.objects.length ? `(${plate.objects.length})` : '';
  if ($('plates').dataset.sig !== `${plate.plateCount}/${plate.current}/${plate.objects.map((o) => o.plate).join('')}/${Object.keys(S.jobs).join('')}`) {
    $('plates').dataset.sig = `${plate.plateCount}/${plate.current}/${plate.objects.map((o) => o.plate).join('')}/${Object.keys(S.jobs).join('')}`;
    renderPlates();
  }
}

function renderObjectList() {
  const el = $('object-list');
  const opts = (sel, allowDefault) => (allowDefault ? `<option value="0" ${!sel ? 'selected' : ''}>—</option>` : '') +
    S.filaments.map((f, i) => `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('');
  const multi = plate.plateCount > 1 || plate.objects.some((o) => o.plate < 0);
  const order = multi ? [...Array.from({ length: plate.plateCount }, (_, i) => i), -1] : [null];
  const rowHtml = (o) => {
    const nset = Object.keys(o.settings).length;
    const parts = o.parts.map((p) => `<div class="obj-row part ${S.selectedPart === p ? 'selected' : ''}" data-obj="${o.id}" data-part="${p.id}">
      <span>${{ normal_part: '▣', modifier_part: '◫', support_blocker: '⊘', support_enforcer: '✚', negative_part: '◌' }[p.subtype] || '◫'}</span>
      <span class="name">${esc(p.name)}</span>${Object.keys(p.settings).length ? `<span class="flag">⚙${Object.keys(p.settings).length}</span>` : ''}
      ${p.subtype === 'modifier_part' || p.subtype === 'normal_part' ? `<select data-pext title="${p.subtype === 'normal_part' ? 'Filament de la pièce (— = celui de l\'objet)' : 'Filament de la zone'}">${opts(p.extruder, true)}</select>` : ''}
      <button class="icon" data-pdel title="Supprimer">✕</button></div>`).join('');
    return `<div class="obj-row ${plate.selected === o && !S.selectedPart ? 'selected' : ''} ${S.multi.has(o.id) ? 'multi' : ''}" data-obj="${o.id}">
      <span class="swatch" style="background:${esc(S.filaments[o.extruder - 1]?.colour || '#ccc')}"></span>
      <span class="name" title="${esc(o.name)}">${o.outside ? '⚠ ' : ''}${esc(o.name)}</span>
      ${nset ? `<span class="flag" title="Réglages propres à l'objet">⚙${nset}</span>` : ''}
      ${o.layer_profile?.length ? '<span class="flag" title="Hauteur de couche variable">≋</span>' : ''}${o.brim_points?.length ? `<span class="flag" title="${o.brim_points.length} oreille(s) de bordure">◔</span>` : ''}${o.layer_ranges?.length ? `<span class="flag" title="${o.layer_ranges.length} plage(s) de hauteur">☰</span>` : ''}
      ${Object.keys(o.paint || {}).length ? `<span class="flag" title="Peinture : ${Object.keys(o.paint).map((k) => PAINT_MODES[k]).join(', ')}">🖌</span>` : ''}
      <select data-ext title="Filament">${opts(o.extruder, false)}</select></div>${parts}`;
  };
  el.innerHTML = order.map((pi) => {
    const objs = pi === null ? plate.objects : plate.objects.filter((o) => o.plate === pi);
    if (pi === -1 && !objs.length) return '';
    const head = pi === null ? '' : `<div class="plate-head ${pi === plate.current ? 'active' : ''}" data-plate="${pi}">${pi === -1 ? '⚠ Hors plateau' : esc(plateLabel(pi))} <span class="muted small">(${objs.length})</span></div>`;
    return head + objs.map(rowHtml).join('');
  }).join('') || '<p class="muted small" style="padding:4px">Ajoute des modèles avec 📂 ou par glisser-déposer.</p>';
  if (!plate.objects.length && !multi) el.innerHTML = '<p class="muted small" style="padding:4px">Ajoute des modèles avec 📂 ou par glisser-déposer.</p>';
  el.querySelectorAll('.plate-head[data-plate]').forEach((h) => { if (+h.dataset.plate >= 0) h.onclick = () => { plate.setCurrent(+h.dataset.plate); plate.view('iso'); }; });
  el.querySelectorAll('.obj-row').forEach((row) => {
    const o = plate.objects.find((x) => x.id === +row.dataset.obj);
    const p = row.dataset.part ? o.parts.find((x) => x.id === +row.dataset.part) : null;
    row.onclick = (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      // Ctrl/Maj + clic : sélection multiple (pour « Assembler »)
      if ((e.ctrlKey || e.metaKey || e.shiftKey) && !p) {
        if (plate.selected && plate.selected !== o) S.multi.add(plate.selected.id);
        if (S.multi.has(o.id)) S.multi.delete(o.id); else S.multi.add(o.id);
        renderObjectList();
        return;
      }
      S.multi.clear();
      if (plate.selected !== o) plate.select(o);
      S.selectedPart = p;
      if (p) S.scope = 'object';
      renderObjectList(); renderPanel();
    };
    row.querySelector('[data-ext]')?.addEventListener('change', (e) => { o.extruder = +e.target.value; plate.refreshColours(); renderObjectList(); saveLocal(); });
    row.querySelector('[data-pext]')?.addEventListener('change', (e) => { p.extruder = +e.target.value; plate.refreshColours(); updateTowers(); saveLocal(); });
    row.querySelector('[data-pdel]')?.addEventListener('click', () => { plate.removePart(o, p); if (S.selectedPart === p) S.selectedPart = null; renderPanel(); });
  });
  updatePlateInfo();
}

function renderObjectPanel() {
  const o = plate.selected;
  $('object-panel').classList.toggle('hidden', !o);
  if (!o) return;
  const g = o.group;
  const bb = o.mesh.geometry.boundingBox;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = Number(v).toFixed(2).replace(/\.?0+$/, ''); };
  $('obj-name').textContent = o.name;
  $('obj-plate-row').classList.toggle('hidden', plate.plateCount < 2);
  if (plate.plateCount > 1 && document.activeElement !== $('obj-plate')) {
    $('obj-plate').innerHTML = (o.plate < 0 ? '<option value="-1">Hors plateau</option>' : '') + Array.from({ length: plate.plateCount }, (_, i) => `<option value="${i}">${esc(plateLabel(i))}</option>`).join('');
    $('obj-plate').value = o.plate;
  }
  set('pos-x', g.position.x); set('pos-y', g.position.y); set('pos-z', g.position.z);
  const rad2deg = 180 / Math.PI;
  set('rot-x', g.rotation.x * rad2deg); set('rot-y', g.rotation.y * rad2deg); set('rot-z', g.rotation.z * rad2deg);
  set('scl-x', g.scale.x * 100); set('scl-y', g.scale.y * 100); set('scl-z', g.scale.z * 100);
  set('size-x', (bb.max.x - bb.min.x) * g.scale.x); set('size-y', (bb.max.y - bb.min.y) * g.scale.y); set('size-z', (bb.max.z - bb.min.z) * g.scale.z);
}

function bindObjectPanel() {
  const num = (id) => parseFloat($(id).value) || 0;
  const uni = () => $('uniform').checked;
  ['pos-x', 'pos-y'].forEach((id) => $(id).onchange = () => plate.applyTransform(plate.selected, { pos: [num('pos-x'), num('pos-y')] }));
  $('pos-z').disabled = true;
  $('obj-plate').onchange = (e) => { const o = plate.selected; if (o && +e.target.value >= 0) { plate.moveToPlate(o, +e.target.value); plate.view('iso'); renderObjectPanel(); } };
  ['rot-x', 'rot-y', 'rot-z'].forEach((id) => $(id).onchange = () => plate.applyTransform(plate.selected, { rot: [num('rot-x'), num('rot-y'), num('rot-z')] }));
  ['scl-x', 'scl-y', 'scl-z'].forEach((id) => $(id).onchange = () => {
    const v = num(id);
    const s = uni() ? [v, v, v] : [num('scl-x'), num('scl-y'), num('scl-z')];
    if (s.some((x) => x <= 0)) return;
    plate.applyTransform(plate.selected, { scale: s });
  });
  ['size-x', 'size-y', 'size-z'].forEach((id, k) => $(id).onchange = () => {
    const o = plate.selected; const bb = o.mesh.geometry.boundingBox;
    const base = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    let size = [num('size-x'), num('size-y'), num('size-z')];
    if (uni()) { const f = size[k] / base[k]; size = base.map((b) => b * f); }
    if (size.some((x) => x <= 0)) return;
    plate.applyTransform(o, { size });
  });
  $('obj-close').onclick = (e) => { e.stopPropagation(); plate.select(null); };
  $('obj-head').onclick = () => $('object-panel').classList.toggle('collapsed');
  // petits écrans (mobile, tablette) : panneaux repliés par défaut, dépliés d'un toucher sur leur titre
  const narrow = matchMedia('(max-width: 900px)');
  const fold = () => { $('object-panel').classList.toggle('collapsed', narrow.matches); $('objects-panel').classList.toggle('collapsed', narrow.matches); };
  fold(); narrow.addEventListener('change', fold);
  document.querySelector('#objects-panel .panel-title').onclick = (e) => { if (!e.target.closest('button, select, input')) $('objects-panel').classList.toggle('collapsed'); };
  // sections du panneau de gauche repliables (clic sur le titre), état mémorisé par navigateur
  let folded = {};
  try { folded = JSON.parse(localStorage.getItem('slicer-folded') || '{}') || {}; } catch { /* stockage indisponible */ }
  for (const p of document.querySelectorAll('#sidebar .panel[data-fold]')) {
    const k = p.dataset.fold;
    p.classList.toggle('folded', !!folded[k]);
    p.querySelector('.panel-title').addEventListener('click', (e) => {
      if (e.target.closest('.actions, button, select, input')) return;
      folded[k] = p.classList.toggle('folded');
      try { localStorage.setItem('slicer-folded', JSON.stringify(folded)); } catch { /* idem */ }
    });
  }
}

// ---------- import de modèles ----------
async function importFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const added = [];
  for (let k = 0; k < list.length; k++) {
    const f = list[k];
    busy(`Import de ${f.name} (${k + 1}/${list.length})…`);
    try {
      const fd = new FormData(); fd.append('file', f);
      const meta = await api('/slicer/api/models', { method: 'POST', body: fd });
      for (const o of meta.objects) {
        const keepPos = meta.from_project && insideBed(o);
        const obj = await plate.addObject({ model_id: meta.id, index: o.index, name: o.name, position: keepPos ? o.position : null });
        added.push({ obj, keepPos });
      }
      const warn = meta.objects.filter((o) => !o.watertight).length;
      if (warn) toast(`${f.name} : maillage non fermé (${warn} objet(s)), Orca tentera de le réparer`, 'warn', 6000);
    } catch (e) { toast(`${f.name} : ${e.message}`, 'err', 7000); }
  }
  busy(false);
  if (added.some((a) => !a.keepPos)) plate.arrange();
  if (added.length) plate.select(added.at(-1).obj);
  saveLocal();
}

function insideBed(o) {
  const b = plate.bedBox;
  return o.position[0] - o.size[0] / 2 >= b.minX && o.position[0] + o.size[0] / 2 <= b.maxX &&
         o.position[1] - o.size[1] / 2 >= b.minY && o.position[1] + o.size[1] / 2 <= b.maxY;
}

async function restoreObjects(objs, plates = null) {
  plate.setPlates(plates?.count || 1, plates?.names || [''], plates?.current || 0);
  S.jobs = {}; showJob();
  for (const o of objs) {
    try { await plate.addObject(o); } catch { /* modèle supprimé du serveur */ }
  }
  renderObjectList();
}

// ---------- séparer / assembler (objets à plusieurs pièces) ----------
// ---------- booléen (GLGizmoMeshBoolean d'Orca) : entre deux volumes d'un objet ----------
async function booleanModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  const vols = [{ key: 'main', name: o.name, model_id: o.model_id, index: o.index, matrix: null },
    ...o.parts.filter((p) => p.subtype === 'normal_part' || p.subtype === 'negative_part')
      .map((p) => ({ key: p.id, name: `${p.name}${p.subtype === 'negative_part' ? ' (volume négatif)' : ''}`, part: p, model_id: p.model_id, index: p.index, matrix: p.mesh.matrix.toArray() }))];
  if (vols.length < 2) { toast('Il faut au moins deux pièces dans l\'objet : ajoute une pièce (Modif. → Pièce) ou assemble deux objets (Ctrl+clic puis Assembler)', 'warn', 7000); return; }
  const wrap = document.createElement('div');
  let op = 'union';
  const opts = vols.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join('');
  wrap.innerHTML = `<p class="muted small">Comme l'outil Booléen d'Orca : l'opération remplace la première pièce par le résultat. Les pièces doivent être des solides fermés.</p>
    <div class="seg" id="bo-op"><button data-op="union" class="active">Union</button><button data-op="difference">Différence</button><button data-op="intersection">Intersection</button></div>
    <label class="row gap" style="margin-top:10px"><span id="bo-l1" style="width:130px">Pièce 1</span><select id="bo-a">${opts}</select></label>
    <label class="row gap" style="margin-top:6px"><span id="bo-l2" style="width:130px">Pièce 2</span><select id="bo-b">${opts}</select></label>
    <label class="row gap" style="margin-top:8px" id="bo-delw"><input type="checkbox" id="bo-del"> Supprimer la pièce d'entrée</label>
    <div class="row gap" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="bo-go">Union</button></div>`;
  const md = modal('Booléen', wrap);
  wrap.querySelector('#bo-b').value = '1';
  const label = { union: 'Union', difference: 'Différence', intersection: 'Intersection' };
  const sync = () => {
    wrap.querySelectorAll('[data-op]').forEach((b) => b.classList.toggle('active', b.dataset.op === op));
    wrap.querySelector('#bo-l1').textContent = op === 'difference' ? 'Soustraire de' : 'Pièce 1';
    wrap.querySelector('#bo-l2').textContent = op === 'difference' ? 'Soustraire avec' : 'Pièce 2';
    wrap.querySelector('#bo-delw').classList.toggle('hidden', op === 'union');   // l'union supprime toujours la 2e pièce
    wrap.querySelector('#bo-go').textContent = label[op];
  };
  wrap.querySelectorAll('[data-op]').forEach((b) => b.onclick = () => { op = b.dataset.op; sync(); });
  wrap.querySelector('#bo-go').onclick = async () => {
    const A = vols[+wrap.querySelector('#bo-a').value], B = vols[+wrap.querySelector('#bo-b').value];
    if (A === B) { toast('Choisis deux pièces différentes'); return; }
    const del = op === 'union' || wrap.querySelector('#bo-del').checked;
    md.close(); busy('Opération booléenne…');
    try {
      const r = await api('/slicer/api/boolean', { json: { op, a: { model_id: A.model_id, index: A.index, matrix: A.matrix }, b: { model_id: B.model_id, index: B.index, matrix: B.matrix } } });
      const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const suffix = { union: 'union', difference: 'différence', intersection: 'intersection' }[op];
      const parts = [];
      for (const p of o.parts) {
        if (B.part === p && del) continue;
        if (A.part === p) { parts.push({ model_id: r.model_id, index: r.index, name: `${p.name} - ${suffix}`, subtype: p.subtype, settings: p.settings, extruder: p.extruder, matrix: ident }); continue; }
        parts.push({ model_id: p.model_id, index: p.index, name: p.name, subtype: p.subtype, settings: p.settings, extruder: p.extruder, matrix: p.mesh.matrix.toArray(), paint: p.paint });
      }
      const base = A.key === 'main' ? { model_id: r.model_id, index: r.index, paint: {}, name: o.name } : { model_id: o.model_id, index: o.index, paint: o.paint, name: o.name };
      // pièce principale soustraite / supprimée : la pièce restante devient le maillage principal
      let m = plate.matrixOf(o);
      if (B.key === 'main' && del) {
        const i = parts.findIndex((p) => p.subtype === 'normal_part');
        if (i < 0) throw new Error('Il ne resterait aucune pièce solide');
        const [first] = parts.splice(i, 1);
        Object.assign(base, { model_id: first.model_id, index: first.index, paint: first.paint || {}, name: first.name });
        // nouveau repère d'objet = celui de cette pièce ; les autres pièces sont ré-exprimées dedans
        const F = new THREE.Matrix4().fromArray(first.matrix), Fi = F.clone().invert();
        m = new THREE.Matrix4().fromArray(m).multiply(F).toArray();
        for (const p of parts) p.matrix = Fi.clone().multiply(new THREE.Matrix4().fromArray(p.matrix)).toArray();
      }
      const pl = o.plate;
      plate.remove(o);
      const n = await plate.addObject({ ...base, extruder: o.extruder, settings: { ...o.settings }, matrix: m, parts, layer_profile: o.layer_profile, brim_points: o.brim_points });
      n.plate = pl;
      plate.select(n); renderObjectList(); saveLocal();
      toast(`${label[op]} : ${r.triangles} triangles${A.key === 'main' && Object.keys(o.paint || {}).length ? ' (peinture de la pièce effacée)' : ''}`);
    } catch (e) { toast(e.message, 'err', 7000); }
    busy(false);
  };
}

// ---------- texture en relief (texture displacement d'Orca 2.5) ----------
const TEX = { name: 'Knurl', depth: 0.4, tile: 12.5, rotation: 0, invert: false, midlevel: 0, smoothing: 0, zone: 'sides', keep_bottom: true, custom: null };
async function textureModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  let names = [];
  try { names = await api('/slicer/api/textures'); } catch { /* liste indisponible */ }
  if (!names.includes(TEX.name)) TEX.name = names[0] || '';
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">Relief appliqué à la surface de « ${esc(o.name)} », avec les textures d'Orca 2.5 (clair = en relief). Le maillage est recalculé (plus de triangles) ; la peinture de l'objet est effacée.</p>
    <div class="tex-grid">${names.map((n) => `<button data-tex="${esc(n)}" class="${n === TEX.name && !TEX.custom ? 'active' : ''}" title="${esc(n)}"><img loading="lazy" src="/slicer/api/textures/${encodeURIComponent(n)}" alt=""><span>${esc(n)}</span></button>`).join('')}
      <button data-tex="" class="${TEX.custom ? 'active' : ''}" title="Image personnelle (PNG, JPEG)"><span style="font-size:24px;line-height:72px">＋</span><span>Mon image…</span></button></div>
    <input type="file" id="tx-file" accept="image/png,image/jpeg" hidden>
    <div class="tex-opts">
      <label>Profondeur (mm) <input type="number" id="tx-depth" min="0.05" max="5" step="0.05" value="${TEX.depth}"></label>
      <label>Taille du motif (mm) <input type="number" id="tx-tile" min="0.5" max="500" step="0.5" value="${TEX.tile}"></label>
      <label>Rotation (°) <input type="number" id="tx-rot" step="5" value="${TEX.rotation}"></label>
      <label>Niveau neutre <input type="number" id="tx-mid" min="0" max="1" step="0.1" value="${TEX.midlevel}" title="0 : le relief ne fait que sortir ; 0,5 : le gris moyen ne bouge pas, le sombre se creuse"></label>
      <label>Adoucir <input type="number" id="tx-smooth" min="0" max="1" step="0.1" value="${TEX.smoothing}"></label>
      <label>Zone <select id="tx-zone"><option value="sides">Côtés</option><option value="all">Tout l'objet</option><option value="top">Dessus</option></select></label>
      <label><span><input type="checkbox" id="tx-inv" ${TEX.invert ? 'checked' : ''}> Inverser</span></label>
      <label><span><input type="checkbox" id="tx-bottom" ${TEX.keep_bottom ? 'checked' : ''}> Base plane (adhérence)</span></label>
    </div>
    <div class="row gap" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="tx-go">Appliquer la texture</button></div>`;
  const md = modal('Texture en relief', wrap);
  wrap.querySelector('#tx-zone').value = TEX.zone;
  const pick = (btn) => { wrap.querySelectorAll('[data-tex]').forEach((b) => b.classList.toggle('active', b === btn)); };
  wrap.querySelectorAll('[data-tex]').forEach((b) => b.onclick = () => {
    if (!b.dataset.tex) { wrap.querySelector('#tx-file').click(); return; }
    TEX.name = b.dataset.tex; TEX.custom = null; pick(b);
  });
  wrap.querySelector('#tx-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    TEX.custom = btoa(bin); pick(wrap.querySelector('[data-tex=""]'));
    toast(`Image « ${f.name} » choisie`);
  };
  wrap.querySelector('#tx-go').onclick = async () => {
    Object.assign(TEX, { depth: +wrap.querySelector('#tx-depth').value, tile: +wrap.querySelector('#tx-tile').value, rotation: +wrap.querySelector('#tx-rot').value,
      midlevel: +wrap.querySelector('#tx-mid').value, smoothing: +wrap.querySelector('#tx-smooth').value, zone: wrap.querySelector('#tx-zone').value,
      invert: wrap.querySelector('#tx-inv').checked, keep_bottom: wrap.querySelector('#tx-bottom').checked });
    md.close(); busy('Calcul du relief…');
    try {
      const r = await api('/slicer/api/texture', { json: { model_id: o.model_id, index: o.index, texture: TEX.custom ? '' : TEX.name, image_b64: TEX.custom || '',
        depth: TEX.depth, tile: TEX.tile, rotation: TEX.rotation, invert: TEX.invert, midlevel: TEX.midlevel, smoothing: TEX.smoothing, zone: TEX.zone, keep_bottom: TEX.keep_bottom } });
      const m = plate.matrixOf(o), pl = o.plate;
      const parts = o.parts.map((p) => ({ model_id: p.model_id, index: p.index, name: p.name, subtype: p.subtype, settings: p.settings, extruder: p.extruder, matrix: p.mesh.matrix.toArray(), paint: p.paint }));
      plate.remove(o);
      const n = await plate.addObject({ model_id: r.model_id, index: r.index, name: o.name, extruder: o.extruder, settings: { ...o.settings }, matrix: m, parts, layer_profile: o.layer_profile, brim_points: o.brim_points });
      n.plate = pl; plate.select(n); renderObjectList(); saveLocal();
      toast(`Texture appliquée : ${r.before.toLocaleString('fr-FR')} → ${r.triangles.toLocaleString('fr-FR')} triangles (Ctrl+Z pour annuler)`);
    } catch (e) { toast(e.message, 'err', 7000); }
    busy(false);
  };
}

// ---------- assemblage face contre face (GLGizmoAssembly d'Orca) ----------
const ASM = { centered: true, gap: 0 };
function assemblyModal() {
  if (!plate.objects.length) { toast('Ajoute d\'abord des objets'); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">Comme l'outil Assemblage d'Orca (« face contre face ») : clique d'abord la face de la pièce à déplacer, puis la face sur laquelle la plaquer.
      Conseil d'Orca : assemble d'abord les objets en un seul (Ctrl+clic puis Assembler), car un objet reste posé sur le plateau alors qu'une pièce peut monter.</p>
    <label class="row gap"><input type="checkbox" id="as-c" ${ASM.centered ? 'checked' : ''}> Faire coïncider les points cliqués</label>
    <label class="row gap" style="margin-top:6px">Écart entre les faces <input type="number" id="as-g" value="${ASM.gap}" step="0.1" style="width:80px"> mm</label>
    <div class="row gap" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" id="as-go">Choisir les faces</button></div>`;
  const md = modal('Assemblage', wrap);
  wrap.querySelector('#as-go').onclick = async () => {
    ASM.centered = wrap.querySelector('#as-c').checked; ASM.gap = +wrap.querySelector('#as-g').value || 0;
    md.close();
    $('t-assembly').classList.add('active');
    const a = await pickFace('Assemblage : clique la face de la pièce à DÉPLACER (Échap pour annuler)');
    if (!a) { $('t-assembly').classList.remove('active'); return; }
    const b = await pickFace('Assemblage : clique maintenant la face de RÉFÉRENCE');
    $('t-assembly').classList.remove('active');
    if (!b) return;
    if (a.obj === b.obj && a.part === b.part) { toast('Choisis deux pièces différentes', 'warn'); return; }
    plate.assembleFaces(a, b, ASM);
    renderObjectPanel(); renderObjectList(); saveLocal();
    toast(a.part || a.obj !== b.obj ? 'Pièces assemblées' : 'Assemblé');
  };
}

// ---------- alignement (GLGizmoAlignment d'Orca) : boîtes englobantes dans le repère du plateau ----------
function alignAction(kind, toPlate) {
  const objs = selection();
  if (!objs.length) { toast('Sélectionne des objets (Ctrl+clic dans la liste)'); return; }
  const ax = kind[0] === 'x' ? 'x' : 'y';
  const box = (o) => plate.worldBox(o);
  const move = (o, d) => { o.group.position[ax] += d; plate._afterTransform(o, true); };
  if (kind.startsWith('d')) {                       // répartir : centres équidistants entre les deux extrêmes
    const a = kind[1];
    if (objs.length < 3) { toast('Il faut au moins 3 objets pour répartir'); return; }
    const e = objs.map((o) => { const b = box(o); return { o, b, c: (b.min[a] + b.max[a]) / 2 }; }).sort((p, q) => p.c - q.c);
    const lo = Math.min(...e.map((x) => x.b.min[a])), hi = Math.max(...e.map((x) => x.b.max[a]));
    const minC = lo + (e[0].b.max[a] - e[0].b.min[a]) / 2, maxC = hi - (e.at(-1).b.max[a] - e.at(-1).b.min[a]) / 2;
    const step = (maxC - minC) / (e.length - 1);
    e.forEach((x, i) => { if (i && i < e.length - 1) { x.o.group.position[a] += minC + i * step - x.c; plate._afterTransform(x.o, true); } });
  } else {
    const side = kind.slice(1);                       // min | center | max
    let ref;
    if (toPlate || objs.length === 1) {               // référence : le plateau de l'objet
      const pb = plate.plateBox(objs[0].plate >= 0 ? objs[0].plate : plate.current);
      ref = { min: pb['min' + ax.toUpperCase()], max: pb['max' + ax.toUpperCase()] };
      // tout le groupe sélectionné bouge d'un bloc, comme Orca (« aligner sur le parent »)
      const bb = objs.map(box).reduce((p, q) => p.union(q));
      const cur = side === 'min' ? bb.min[ax] : side === 'max' ? bb.max[ax] : (bb.min[ax] + bb.max[ax]) / 2;
      const tgt = side === 'min' ? ref.min : side === 'max' ? ref.max : (ref.min + ref.max) / 2;
      objs.forEach((o) => move(o, tgt - cur));
    } else {
      const bs = objs.map(box);
      const tgt = side === 'min' ? Math.min(...bs.map((b) => b.min[ax])) : side === 'max' ? Math.max(...bs.map((b) => b.max[ax]))
        : bs.map((b) => b).reduce((p, q) => p.clone().union(q)).getCenter(new THREE.Vector3())[ax];
      objs.forEach((o, i) => { const b = bs[i]; const cur = side === 'min' ? b.min[ax] : side === 'max' ? b.max[ax] : (b.min[ax] + b.max[ax]) / 2; move(o, tgt - cur); });
    }
  }
  renderObjectPanel(); renderObjectList(); saveLocal();
}

function alignModal() {
  const n = selection().length;
  if (!n) { toast('Sélectionne des objets (Ctrl+clic dans la liste)'); return; }
  const wrap = document.createElement('div');
  const B = (k, l) => `<button class="btn small" data-al="${k}">${l}</button>`;
  wrap.innerHTML = `<p class="muted small">${n} objet(s) sélectionné(s). Comme l'outil Alignement d'Orca : ${n === 1 ? 'un objet seul s\'aligne sur le plateau' : 'les objets s\'alignent entre eux, ou ensemble sur le plateau'}.</p>
    <p><b>X</b> ${B('xmin', 'Gauche')} ${B('xcenter', 'Centre')} ${B('xmax', 'Droite')} ${n >= 3 ? B('dx', 'Répartir') : ''}</p>
    <p><b>Y</b> ${B('ymin', 'Avant')} ${B('ycenter', 'Centre')} ${B('ymax', 'Arrière')} ${n >= 3 ? B('dy', 'Répartir') : ''}</p>
    ${n > 1 ? '<label class="row gap"><input type="checkbox" id="al-plate"> Aligner l\'ensemble sur le plateau</label>' : ''}`;
  modal('Aligner', wrap);
  wrap.querySelectorAll('[data-al]').forEach((b) => b.onclick = () => alignAction(b.dataset.al, wrap.querySelector('#al-plate')?.checked));
}

// ---------- simplification (GLGizmoSimplify d'Orca) ----------
async function simplifyModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  const tri = o.mesh.geometry.attributes.position.count / 3;
  const LEVELS = [['Très élevé', 0.1], ['Élevé', 0.25], ['Moyen', 0.5], ['Bas', 0.75], ['Très bas', 0.9]];
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">« ${esc(o.name)} » : ${tri.toLocaleString('fr-FR')} triangles. Réduit le nombre de triangles en gardant la forme, comme Simplifier d'Orca (contraction d'arêtes quadrique). La peinture de l'objet est effacée.</p>
    <label class="row gap"><input type="radio" name="sm" value="level" checked> Niveau de détail <select id="sm-level">${LEVELS.map(([l], i) => `<option value="${i}" ${i === 2 ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="row gap" style="margin-top:6px"><input type="radio" name="sm" value="ratio"> Taux de réduction <input type="number" id="sm-ratio" min="1" max="99" value="50" style="width:70px"> %</label>
    <p class="small" id="sm-est"></p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn primary" id="sm-go">Simplifier</button></div>`;
  const md = modal('Simplifier', wrap);
  const ratio = () => wrap.querySelector('[name=sm]:checked').value === 'level' ? LEVELS[+wrap.querySelector('#sm-level').value][1] : Math.min(99, Math.max(1, +wrap.querySelector('#sm-ratio').value || 50)) / 100;
  const est = () => { wrap.querySelector('#sm-est').textContent = `≈ ${Math.round(tri * (1 - ratio())).toLocaleString('fr-FR')} triangles après simplification`; };
  wrap.querySelectorAll('input, select').forEach((i) => i.oninput = est); est();
  wrap.querySelector('#sm-go').onclick = async () => {
    const r0 = ratio();
    md.close(); busy('Simplification…');
    try {
      const r = await api('/slicer/api/simplify', { json: { model_id: o.model_id, index: o.index, reduction: r0 } });
      const m = plate.matrixOf(o), pl = o.plate;
      const parts = o.parts.map((p) => ({ model_id: p.model_id, index: p.index, name: p.name, subtype: p.subtype, settings: p.settings, extruder: p.extruder, matrix: p.mesh.matrix.toArray(), paint: p.paint }));
      plate.remove(o);
      const n = await plate.addObject({ model_id: r.model_id, index: r.index, name: o.name, extruder: o.extruder, settings: { ...o.settings }, matrix: m, parts, layer_profile: o.layer_profile, brim_points: o.brim_points });
      n.plate = pl; plate.select(n); renderObjectList(); saveLocal();
      toast(`Simplifié : ${r.before.toLocaleString('fr-FR')} → ${r.triangles.toLocaleString('fr-FR')} triangles`);
    } catch (e) { toast(e.message, 'err'); }
    busy(false);
  };
}

async function splitAction() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">Sépare « ${esc(o.name)} » selon ses parties non reliées entre elles, comme « Séparer » d'Orca.</p>
    <div class="row gap"><button class="btn" data-k="objects">En objets</button><button class="btn" data-k="parts">En pièces (un seul objet)</button></div>`;
  const md = modal('Séparer', wrap);
  wrap.querySelectorAll('[data-k]').forEach((b) => b.onclick = async () => {
    md.close(); busy('Séparation…');
    try {
      // objet à plusieurs pièces → « En objets » : chaque pièce devient un objet (comme Orca)
      if (b.dataset.k === 'objects' && o.parts.some((pt) => pt.subtype === 'normal_part')) {
        o.group.updateMatrixWorld(true);
        const M = o.group.matrixWorld.clone();
        const normals = o.parts.filter((pt) => pt.subtype === 'normal_part');
        for (const pt of normals) {
          const wm = M.clone().multiply(pt.mesh.matrix);
          await plate.addObject({ model_id: pt.model_id, index: pt.index, name: pt.name, extruder: pt.extruder || o.extruder, settings: { ...o.settings }, matrix: wm.toArray(), parts: [] });
          plate.removePart(o, pt);
        }
        plate._afterTransform(o);
        renderObjectList(); saveLocal();
        toast(`${normals.length + 1} objets créés`);
        busy(false);
        return;
      }
      const meta = await api(`/slicer/api/models/${o.model_id}/split/${o.index}`, { method: 'POST' });
      const m = plate.matrixOf(o);
      const pl = o.plate;
      const others = o.parts.map((pt) => ({ model_id: pt.model_id, index: pt.index, name: pt.name, subtype: pt.subtype, settings: pt.settings, extruder: pt.extruder, matrix: pt.mesh.matrix.toArray() }));
      plate.remove(o);
      let first = null;
      if (b.dataset.k === 'objects') {
        for (const c of meta.objects) {
          const n = await plate.addObject({ model_id: meta.id, index: c.index, name: `${o.name.replace(/\.[^.]+$/, '')} (${c.index + 1})`, extruder: o.extruder, settings: { ...o.settings },
            matrix: m, parts: c.index === 0 ? others : [] });
          first ||= n;
        }
      } else {
        const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        first = await plate.addObject({ model_id: meta.id, index: 0, name: o.name, extruder: o.extruder, settings: { ...o.settings }, matrix: m,
          parts: [...meta.objects.slice(1).map((c) => ({ model_id: meta.id, index: c.index, name: `pièce ${c.index + 1}`, subtype: 'normal_part', settings: {}, extruder: 0, matrix: ident })), ...others] });
      }
      if (first && pl >= 0) plate.setCurrent(pl, true);
      plate.select(first);
      renderObjectList(); saveLocal();
      toast(`${meta.objects.length} ${b.dataset.k === 'objects' ? 'objets' : 'pièces'} créé(e)s`);
    } catch (e) { toast(e.message, 'err', 6000); }
    busy(false);
  });
}

async function mergeAction() {
  const ids = new Set(S.multi);
  if (plate.selected) ids.add(plate.selected.id);
  const objs = plate.objects.filter((x) => ids.has(x.id));
  if (objs.length < 2) { toast('Sélectionne au moins 2 objets : Ctrl+clic dans la liste des objets'); return; }
  const THREE = await import('three');
  const base = objs[0];
  base.group.updateMatrixWorld(true);
  const inv = base.group.matrixWorld.clone().invert();
  const parts = [];
  let dropped = 0;
  for (const o of objs.slice(1)) {
    o.group.updateMatrixWorld(true);
    const rel = inv.clone().multiply(o.group.matrixWorld);
    parts.push({ model_id: o.model_id, index: o.index, name: o.name, subtype: 'normal_part', settings: {}, extruder: o.extruder, matrix: rel.toArray() });
    for (const pt of o.parts) parts.push({ model_id: pt.model_id, index: pt.index, name: pt.name, subtype: pt.subtype, settings: pt.settings, extruder: pt.extruder,
      matrix: rel.clone().multiply(pt.mesh.matrix).toArray() });
    if (Object.keys(o.settings).length) dropped++;
  }
  for (const p of parts) await plate.addPart(base, p);
  for (const o of objs.slice(1)) plate.remove(o);
  plate._afterTransform(base);
  S.multi.clear();
  plate.select(base);
  renderObjectList(); saveLocal();
  toast(`${objs.length} objets assemblés dans « ${base.name} »` + (dropped ? ` — réglages propres de ${dropped} objet(s) non repris` : ''), dropped ? 'warn' : '', 6000);
}

// ---------- disposition (options comme la fenêtre « Disposer » d'Orca) ----------
async function doArrange() {
  const o = S.arrangeOpts || { distance: 0, rotate: false, engine: 'orca' };
  const pi = plate.current, mine = plate.objectsOf(pi);
  if ((o.engine || 'orca') === 'orca' && mine.length) {
    // disposition par le vrai moteur d'Orca (imbrication libnest2d), comme le bouton « Disposer » d'Orca
    busy('Disposition par Orca…');
    try {
      const r = await api('/slicer/api/arrange', { json: { ...sliceBody(plate.serialize(pi, true), plate.plateNames[pi] || 'Plateau'), rotate: !!o.rotate } });
      const [ox, oy] = plate.plateOrigin(pi);
      const extra = Math.max(0, ...r.objects.map((x) => x.plate));
      const first = plate.plateCount;
      if (extra) plate.setPlates(plate.plateCount + extra, null, pi);
      mine.forEach((obj, i) => {
        const res = r.objects[i]; if (!res) return;
        const [px, py] = res.plate ? plate.plateOrigin(first + res.plate - 1) : [ox, oy];
        const m = new THREE.Matrix4().fromArray(res.matrix);
        m.elements[12] += px; m.elements[13] += py;
        m.decompose(obj.group.position, obj.group.quaternion, obj.group.scale);
        obj.plate = res.plate ? first + res.plate - 1 : pi;
        plate._afterTransform(obj, true);
      });
      plate.setCurrent(pi, true);
      renderObjectList(); renderPlates(); saveLocal();
      if (extra) toast(`Tout ne tenait pas : ${extra} plateau(x) ajouté(s), comme Orca`, 'warn', 6000);
      busy(false);
      return;
    } catch (e) { busy(false); toast('Disposition Orca indisponible (' + e.message + ') : rangement simple', 'warn', 6000); }
  }
  // repli : rangement en rangées (distance 0 = automatique : 6 mm)
  plate.arrange(o.distance > 0 ? o.distance : 6, o.rotate);
  saveLocal();
}

function arrangeModal() {
  const o = S.arrangeOpts || { distance: 0, rotate: false, engine: 'orca' };
  const wrap = document.createElement('form');
  wrap.innerHTML = `<div class="grid3"><label>Moteur<select name="e"><option value="orca">Orca (identique, imbrication libnest2d)</option><option value="rows">Rangées simples (local)</option></select></label>
      <label>Espacement (mm, 0 = auto, rangées seulement)<input name="d" type="number" step="0.5" min="0" value="${o.distance}"></label>
      <label class="check" style="align-self:end"><input type="checkbox" name="r" ${o.rotate ? 'checked' : ''}> Autoriser la rotation</label></div>
    <p class="muted small">Clic droit ou Maj+clic sur « Disposer » pour rouvrir ces options. Par défaut, la disposition est calculée par le vrai moteur
      d'Orca (même placement que le bouton Disposer d'Orca, espacement automatique) ; s'il ne répond pas, rangement en rangées.</p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn primary">Disposer</button></div>`;
  const md = modal('Options de disposition', wrap);
  wrap.e.value = o.engine || 'orca';
  wrap.onsubmit = (e) => { e.preventDefault(); S.arrangeOpts = { distance: Math.max(0, +wrap.d.value || 0), rotate: wrap.r.checked, engine: wrap.e.value }; md.close(); doArrange(); };
}

// ---------- orientation automatique (Orient.cpp d'Orca) ----------
async function orientAction() {
  const list = plate.selected ? [plate.selected] : plate.objectsOf(plate.current);
  if (!list.length) { toast('Rien à orienter sur ce plateau'); return; }
  const THREE = await import('three');
  // ventilateur auxiliaire (OrientJob::get_orient_mesh) : flux d'air vers la droite (1,0,0) ou sinon (-1,0,0)
  const fan = scalar(effective('machine', 'fan_direction')), aux = scalar(effective('machine', 'auxiliary_fan'));
  const cooling = fan && fan !== 'undefine' && ['1', 'true'].includes(String(aux)) ? (fan === 'right' ? [1, 0, 0] : [-1, 0, 0]) : null;
  busy(`Orientation de ${list.length} objet(s)…`);
  let n = 0;
  for (const o of list) {
    try {
      const angle = parseFloat(o.settings.support_threshold_angle ?? scalar(effective('process', 'support_threshold_angle'))) || 30;
      const parts = o.parts.filter((pt) => pt.subtype === 'normal_part').map((pt) => ({ model_id: pt.model_id, index: pt.index, matrix: pt.mesh.matrix.toArray() }));
      const r = await api('/slicer/api/orient', { json: { model_id: o.model_id, index: o.index, parts, overhang_angle: angle, min_area: true, cooling_direction: cooling } });
      const R = new THREE.Matrix4().set(...r.rotation[0], 0, ...r.rotation[1], 0, ...r.rotation[2], 0, 0, 0, 0, 1);
      const pos = o.group.position.clone();
      const rot = new THREE.Matrix4().makeRotationFromQuaternion(o.group.quaternion);
      new THREE.Matrix4().multiplyMatrices(R, rot).decompose(new THREE.Vector3(), o.group.quaternion, new THREE.Vector3());
      o.group.position.copy(pos);
      plate._afterTransform(o, true);
      n++;
    } catch (e) { toast(`${o.name} : ${e.message}`, 'err'); }
  }
  plate.arrangeIfOverlap(list.at(-1));
  plate.hooks.onChange?.();
  renderObjectPanel(); saveLocal();
  busy(false);
  toast(`${n} objet(s) orienté(s)`);
}

// ---------- texte 3D et SVG (outils Texte / SVG d'Orca) ----------
function pickFace(msg) {
  toast(msg, '', 6000);
  return new Promise((resolve) => { plate.picking = resolve; });
}

// Place un maillage (z = 0 sur la face, z+ vers l'extérieur) sur la face cliquée, comme pièce de l'objet
async function placeOnFace(meta, kind, hitInfo, depth, label) {
  const THREE = await import('three');
  const { obj, point, normal } = hitInfo;
  const n = normal.clone().normalize();
  const upW = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const y = upW.clone().sub(n.clone().multiplyScalar(upW.dot(n))).normalize();
  const x = y.clone().cross(n).normalize();
  // creux : enfoncé de toute son épaisseur ; relief et modificateur : posés sur la face
  const sink = kind === 'negative_part' ? depth : 0;
  const W = new THREE.Matrix4().makeBasis(x, y, n).setPosition(point.clone().sub(n.clone().multiplyScalar(sink)));
  obj.group.updateMatrixWorld(true);
  const rel = obj.group.matrixWorld.clone().invert().multiply(W);
  const part = await plate.addPart(obj, { model_id: meta.id, index: 0, name: label, subtype: kind, settings: {}, extruder: 0, matrix: rel.toArray() });
  plate._afterTransform(obj);
  plate.select(obj);
  S.selectedPart = part;
  renderObjectList(); saveLocal();
  return part;
}

const EMBOSS_KINDS = `<option value="normal_part">En relief (pièce)</option><option value="negative_part">En creux (volume négatif)</option><option value="modifier_part">Modificateur</option>`;

async function textModal() {
  if (!plate.objects.length) { toast('Ajoute d\'abord un objet'); return; }
  let fonts = [];
  try { fonts = await api('/slicer/api/fonts'); } catch {}
  const wrap = document.createElement('form');
  wrap.innerHTML = `<label class="muted small">Texte (plusieurs lignes possibles)</label><textarea name="text" rows="2" style="width:100%">PrintLab</textarea>
    <div class="grid3"><label>Police<select name="font">${fonts.map((f) => `<option value="${esc(f.file)}" ${f.file === 'DejaVuSans.ttf' ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>Hauteur (mm)<input name="size" type="number" step="0.5" value="10"></label><label>Épaisseur (mm)<input name="depth" type="number" step="0.1" value="1"></label>
      <label>Écart lettres<input name="cg" type="number" step="10" value="0"></label><label>Écart lignes<input name="lg" type="number" step="10" value="0"></label>
      <label>Type<select name="kind">${EMBOSS_KINDS}</select></label></div>
    <p class="muted small">Valeurs par défaut de l'outil Texte d'Orca. Après « Placer », clique sur la face de l'objet où poser le texte.</p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn primary">Placer…</button></div>`;
  const md = modal('Texte 3D', wrap);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const f = wrap;
    const body = { text: f.text.value, font: f.font.value, size: +f.size.value || 10, depth: +f.depth.value || 1, char_gap: +f.cg.value || 0, line_gap: +f.lg.value || 0 };
    md.close();
    const hit = await pickFace('Clique sur la face de l\'objet où poser le texte (Échap pour annuler)');
    if (!hit) { toast('Placement annulé'); return; }
    busy('Création du texte…');
    try {
      const meta = await api('/slicer/api/text', { json: body });
      await placeOnFace(meta, f.kind.value, hit, body.depth, 'Texte « ' + body.text.split('\n')[0].slice(0, 24) + ' »');
    } catch (err) { toast(err.message, 'err'); }
    busy(false);
  };
}

async function svgModal() {
  if (!plate.objects.length) { toast('Ajoute d\'abord un objet'); return; }
  const wrap = document.createElement('form');
  wrap.innerHTML = `<label class="muted small">Fichier SVG</label><input type="file" name="file" accept=".svg,image/svg+xml">
    <div class="grid3"><label>Largeur (mm)<input name="width" type="number" step="1" value="30"></label><label>Épaisseur (mm)<input name="depth" type="number" step="0.1" value="1"></label>
      <label>Type<select name="kind">${EMBOSS_KINDS}</select></label></div>
    <p class="muted small">Après « Placer », clique sur la face de l'objet où poser la forme.</p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn primary">Placer…</button></div>`;
  const md = modal('Forme SVG', wrap);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const file = wrap.file.files[0];
    if (!file) { toast('Choisis un fichier SVG'); return; }
    const width = +wrap.width.value || 30, depth = +wrap.depth.value || 1, kind = wrap.kind.value;
    md.close();
    const hit = await pickFace('Clique sur la face de l\'objet où poser la forme (Échap pour annuler)');
    if (!hit) { toast('Placement annulé'); return; }
    busy('Création de la forme…');
    try {
      const fd = new FormData(); fd.append('file', file);
      const meta = await api(`/slicer/api/svg?width=${width}&depth=${depth}`, { method: 'POST', body: fd });
      await placeOnFace(meta, kind, hit, depth, 'SVG ' + file.name.replace(/\.svg$/i, ''));
    } catch (err) { toast(err.message, 'err'); }
    busy(false);
  };
}

// ---------- peinture (outils de peinture d'Orca) ----------
const PAINT = { active: false, mode: 'supports', state: 1, tool: 'brush', radius: 2, angle: 30, overhang: 30 };
const PAINT_MODES = { supports: 'Supports', seam: 'Couture', color: 'Couleurs', fuzzy: 'Fuzzy skin' };
const PAINT_STATES = { supports: [[1, 'Forcer', '#3fb950'], [2, 'Bloquer', '#e5534b']], seam: [[1, 'Forcer', '#3fb950'], [2, 'Bloquer', '#e5534b']], fuzzy: [[1, 'Fuzzy skin', '#d29922']] };

function paintToggle(on = !PAINT.active) {
  if (on && !plate.selected) { toast('Sélectionne d\'abord l\'objet à peindre'); return; }
  PAINT.active = on;
  $('t-paint').classList.toggle('active', on);
  $('paint-panel').classList.toggle('hidden', !on);
  $('object-panel').classList.toggle('hidden', on || !plate.selected);
  plate.setPaint({ ...PAINT });
  if (on) renderPaintPanel();
}

function renderPaintPanel() {
  const el = $('paint-panel');
  const states = PAINT.mode === 'color' ? S.filaments.map((f, i) => [i + 1, `${i + 1}`, f.colour]) : PAINT_STATES[PAINT.mode];
  if (!states.some(([n]) => n === PAINT.state)) PAINT.state = states[0][0];
  el.innerHTML = `<div class="panel-title">Peinture <span class="actions"><button class="icon" data-close title="Quitter (Échap)">✕</button></span></div>
    <div class="seg">${Object.entries(PAINT_MODES).map(([k, l]) => `<button data-mode="${k}" class="${k === PAINT.mode ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="states">${states.map(([n, l, c]) => `<button class="btn small ${n === PAINT.state ? 'active' : ''}" data-state="${n}"><span class="swatch" style="background:${esc(c)}"></span>${esc(l)}</button>`).join('')}</div>
    <div class="seg"><button data-tool="brush" class="${PAINT.tool === 'brush' ? 'active' : ''}">Pinceau</button><button data-tool="fill" class="${PAINT.tool === 'fill' ? 'active' : ''}">Remplissage</button></div>
    ${PAINT.tool === 'brush' ? `<label>Rayon <input type="range" min="0.2" max="20" step="0.1" value="${PAINT.radius}" data-k="radius"><b>${PAINT.radius} mm</b></label>`
      : `<label>Angle de remplissage <input type="range" min="0" max="90" step="1" value="${PAINT.angle}" data-k="angle"><b>${PAINT.angle}°</b></label>`}
    ${PAINT.mode === 'supports' ? `<label>Surplombs au-delà de <input type="number" min="0" max="90" value="${PAINT.overhang}" data-k="overhang" style="width:56px">° <button class="btn small" data-overhang>Peindre les surplombs</button></label>` : ''}
    <p class="muted small">Clic gauche : peindre · Maj + clic : effacer · clic droit : tourner la vue · molette : zoom</p>
    <div class="row gap"><button class="btn small" data-clear>Tout effacer (${esc(PAINT_MODES[PAINT.mode])})</button></div>`;
  el.querySelector('[data-close]').onclick = () => paintToggle(false);
  el.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => { PAINT.mode = b.dataset.mode; PAINT.state = PAINT.mode === 'color' ? 1 : 1; plate.setPaint({ ...PAINT }); renderPaintPanel(); });
  el.querySelectorAll('[data-state]').forEach((b) => b.onclick = () => { PAINT.state = +b.dataset.state; plate.setPaint({ ...PAINT }); renderPaintPanel(); });
  el.querySelectorAll('[data-tool]').forEach((b) => b.onclick = () => { PAINT.tool = b.dataset.tool; plate.setPaint({ ...PAINT }); renderPaintPanel(); });
  el.querySelectorAll('[data-k]').forEach((i) => i.oninput = () => { PAINT[i.dataset.k] = +i.value; if (i.nextElementSibling?.tagName === 'B') i.nextElementSibling.textContent = i.value + (i.dataset.k === 'radius' ? ' mm' : '°'); plate.paint = { ...PAINT }; });
  el.querySelector('[data-overhang]')?.addEventListener('click', () => { const n = plate.paintOverhangs(PAINT.overhang, PAINT.state); onPaintChanged(); toast(`${n} triangle(s) en surplomb peint(s)`); });
  el.querySelector('[data-clear]').onclick = () => { plate.clearPaint(PAINT.mode); onPaintChanged(); };
}

function onPaintChanged() {
  for (const j of Object.values(S.jobs)) j.stale = true;
  saveLocal(); renderObjectList();
}

// ---------- oreilles de bordure (GLGizmoBrimEars d'Orca) ----------
const BRIM = { active: false, obj: null, radius: null, maxAngle: 125, detection: 1, detectionMax: 100 };

function brimDefaultRadius() {
  // get_brim_default_radius : largeur de ligne de la 1re couche × 8 (largeur en % = du diamètre de buse)
  const nd = parseFloat(scalar(effective('machine', 'nozzle_diameter'))) || 0.4;
  const w = String(scalar(effective('process', 'initial_layer_line_width')) ?? '');
  const lw = w.endsWith('%') ? nd * parseFloat(w) / 100 : parseFloat(w) || nd;
  return Math.min(100, Math.max(0.1, Math.round(lw * 8 * 100) / 100));
}

function brimToggle(on = !BRIM.active) {
  if (on && !plate.selected) { toast('Sélectionne d\'abord l\'objet'); return; }
  if (on && PAINT.active) paintToggle(false);
  BRIM.active = on;
  BRIM.obj = on ? plate.selected : null;
  if (on && BRIM.radius == null) BRIM.radius = brimDefaultRadius();
  $('t-brim').classList.toggle('active', on);
  $('brim-panel').classList.toggle('hidden', !on);
  $('object-panel').classList.toggle('hidden', on || !plate.selected);
  plate.startBrim(on ? BRIM.obj : null, BRIM.radius);
  if (on) renderBrimPanel();
}

function brimTypeOf(o) {
  return o.settings?.brim_type ?? scalar(effective('process', 'brim_type'));
}

function renderBrimPanel() {
  if (!BRIM.active || !BRIM.obj) return;
  const o = BRIM.obj, el = $('brim-panel');
  const painted = brimTypeOf(o) === 'painted';
  el.innerHTML = `<div class="panel-title">Oreilles de bordure <span class="actions"><button class="icon" data-close title="Terminer (Échap)">✕</button></span></div>
    <label>Rayon <input type="range" min="0.1" max="20" step="0.1" value="${BRIM.radius}" data-k="radius"><b>${BRIM.radius} mm</b></label>
    <label>Angle max <input type="range" min="0" max="180" step="1" value="${BRIM.maxAngle}" data-k="maxAngle"><b>${BRIM.maxAngle}°</b></label>
    <label>Rayon de détection <input type="range" min="0" max="${BRIM.detectionMax}" step="0.1" value="${BRIM.detection}" data-k="detection"><b>${BRIM.detection} mm</b></label>
    <div class="row gap"><button class="btn small" data-auto>Générer automatiquement</button><button class="btn small" data-clear>Tout supprimer (${o.brim_points.length})</button></div>
    ${painted ? '' : `<p class="warn">⚠ Le type de bordure de cet objet n'est pas « Peinte » : les oreilles n'auront pas d'effet. <button class="btn small" data-painted>Passer en « Peinte »</button></p>`}
    <p class="muted small">Clic sur la première couche : ajouter · Maj + clic : supprimer · Ctrl + molette : rayon. Les oreilles sont posées au niveau du plateau, comme dans Orca.</p>`;
  el.querySelector('[data-close]').onclick = () => brimToggle(false);
  el.querySelectorAll('[data-k]').forEach((i) => i.oninput = () => {
    BRIM[i.dataset.k] = +i.value; i.nextElementSibling.textContent = i.value + (i.dataset.k === 'maxAngle' ? '°' : ' mm');
    if (i.dataset.k === 'radius') plate.brim && (plate.brim.radius = BRIM.radius);
  });
  el.querySelector('[data-clear]').onclick = () => { plate.setBrimPoints(o, []); };
  el.querySelector('[data-painted]')?.addEventListener('click', () => { o.settings.brim_type = 'painted'; renderPanel(); renderBrimPanel(); saveLocal(); });
  el.querySelector('[data-auto]').onclick = async () => {
    busy('Génération des oreilles…');
    try {
      const r = await api('/slicer/api/brim-ears/auto', { json: { model_id: o.model_id, index: o.index, matrix: plate.matrixOf(o),
        parts: o.parts.map((p) => ({ model_id: p.model_id, index: p.index, matrix: p.mesh.matrix.toArray(), subtype: p.subtype })),
        detection_radius: BRIM.detection, max_angle: BRIM.maxAngle } });
      BRIM.detectionMax = Math.round(r.detection_max * 10) / 10;
      const inv = new THREE.Matrix4().fromArray(plate.matrixOf(o)).invert();
      const pts = [...o.brim_points];
      for (const [x, y] of r.points) {
        const l = new THREE.Vector3(x, y, -0.0001).applyMatrix4(inv);
        if (!pts.some((q) => Math.abs(q[0] - l.x) < 1e-6 && Math.abs(q[1] - l.y) < 1e-6)) pts.push([l.x, l.y, l.z, BRIM.radius]);
      }
      plate.setBrimPoints(o, pts);
      toast(`${r.points.length} oreille(s) générée(s)`);
    } catch (e) { toast(e.message, 'err'); }
    busy(false);
  };
}

// ---------- hauteur de couche variable (Slicing.cpp / SlicingAdaptive.cpp d'Orca) ----------
function layerParams(o) {
  const num = (v, d) => { const x = parseFloat(scalar(v)); return Number.isFinite(x) ? x : d; };
  return {
    layer_height: num(o.settings.layer_height ?? effective('process', 'layer_height'), 0.2),
    first_layer: num(effective('process', 'initial_layer_print_height'), 0.2),
    nozzle_min: num(effective('machine', 'min_layer_height'), 0.07),
    nozzle_max: num(effective('machine', 'max_layer_height'), 0),
  };
}

async function layerModal() {
  const o = plate.selected;
  if (!o) return;
  const lp = layerParams(o);
  const H = plate.worldBox(o).max.z - plate.worldBox(o).min.z;
  const mn = Math.min(Math.max(0.01, lp.nozzle_min || 0.07), lp.layer_height), mx = Math.max(lp.nozzle_max || lp.layer_height, lp.layer_height);
  // profil uniforme de départ (comme Orca quand aucun profil n'est défini)
  const uniform = () => { const p = [0, lp.first_layer, lp.first_layer, lp.first_layer]; for (let z = lp.first_layer; z < H - 1e-4; z += lp.layer_height) p.push(+z.toFixed(4), lp.layer_height); return p; };
  let prof = o.layer_profile?.length ? [...o.layer_profile] : null;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="row gap" style="align-items:flex-start">
      <canvas width="300" height="420" style="background:var(--bg2);border:1px solid var(--line);border-radius:6px;cursor:crosshair"></canvas>
      <div style="flex:1;min-width:220px">
        <p class="muted small">Objet de ${H.toFixed(2)} mm · couche ${lp.layer_height} mm · limites de la buse ${mn}–${mx} mm.</p>
        <label class="small">Qualité adaptative <input type="range" min="0" max="1" step="0.05" value="0.5" data-q style="width:100%"></label>
        <div class="row gap"><button class="btn small" data-adapt>Adaptatif</button><button class="btn small" data-smooth>Lisser</button><button class="btn small" data-reset>Réinitialiser</button></div>
        <label class="small" style="margin-top:8px;display:block">Rayon de lissage <input type="number" min="1" max="10" value="5" data-r style="width:50px"></label>
        <label class="check small"><input type="checkbox" data-keep> Garder le minimum</label>
        <label class="small" style="margin-top:8px;display:block">Rayon d'édition (mm) <input type="number" min="0.5" max="50" step="0.5" value="5" data-er style="width:60px"></label>
        <p class="muted small">Glisse sur le graphique pour fixer la hauteur de couche (gauche = plus fin, droite = plus épais) autour de la hauteur pointée.</p>
        <div class="row gap" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" data-ok>Valider</button></div>
      </div></div>`;
  const md = modal(`Hauteur de couche variable — ${o.name}`, wrap);
  const cv = wrap.querySelector('canvas'), cx = cv.getContext('2d');
  const W = cv.width, Hc = cv.height, pad = 28;
  const X = (h) => pad + (h - mn) / Math.max(1e-6, mx - mn) * (W - 2 * pad), Y = (z) => Hc - pad - z / Math.max(1e-6, H) * (Hc - 2 * pad);
  const css = getComputedStyle(document.documentElement);
  const draw = () => {
    cx.clearRect(0, 0, W, Hc);
    cx.strokeStyle = css.getPropertyValue('--line'); cx.fillStyle = css.getPropertyValue('--mut'); cx.font = '10px system-ui';
    for (const h of [mn, lp.layer_height, mx]) { cx.beginPath(); cx.moveTo(X(h), pad); cx.lineTo(X(h), Hc - pad); cx.stroke(); cx.fillText(h.toFixed(2), X(h) - 10, Hc - 10); }
    cx.fillText(H.toFixed(1) + ' mm', 2, pad - 6); cx.fillText('0', 6, Hc - pad);
    const p = prof || uniform();
    cx.strokeStyle = css.getPropertyValue('--pri') || '#e08a57'; cx.lineWidth = 2; cx.beginPath();
    for (let i = 0; i < p.length; i += 2) { const z0 = p[i], z1 = i + 2 < p.length ? p[i + 2] : H; cx.lineTo(X(p[i + 1]), Y(z0)); cx.lineTo(X(p[i + 1]), Y(z1)); }
    cx.stroke(); cx.lineWidth = 1;
    if (!prof) { cx.fillStyle = css.getPropertyValue('--mut'); cx.fillText('profil uniforme (aucun profil variable)', pad, pad + 12); }
  };
  const body = (extra) => ({ ...lp, ...extra });
  wrap.querySelector('[data-adapt]').onclick = async () => {
    try {
      const parts = o.parts.filter((pt) => pt.subtype === 'normal_part').map((pt) => ({ model_id: pt.model_id, index: pt.index, matrix: pt.mesh.matrix.toArray() }));
      const r = await api('/slicer/api/layer-profile/adaptive', { json: body({ model_id: o.model_id, index: o.index, matrix: plate.matrixOf(o), parts, quality: +wrap.querySelector('[data-q]').value }) });
      prof = r.profile; draw();
    } catch (e) { toast(e.message, 'err'); }
  };
  wrap.querySelector('[data-smooth]').onclick = async () => {
    try { const r = await api('/slicer/api/layer-profile/smooth', { json: body({ profile: prof || uniform(), radius: +wrap.querySelector('[data-r]').value || 5, keep_min: wrap.querySelector('[data-keep]').checked }) }); prof = r.profile; draw(); }
    catch (e) { toast(e.message, 'err'); }
  };
  wrap.querySelector('[data-reset]').onclick = () => { prof = null; draw(); };
  // édition à la souris : hauteur cible = abscisse, appliquée en douceur autour de la hauteur z pointée
  let dragging = false;
  const edit = (e) => {
    const r = cv.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width), py = (e.clientY - r.top) * (Hc / r.height);
    const h = Math.min(mx, Math.max(mn, mn + (px - pad) / (W - 2 * pad) * (mx - mn)));
    const z = Math.min(H, Math.max(0, (Hc - pad - py) / (Hc - 2 * pad) * H));
    const band = +wrap.querySelector('[data-er]').value || 5;
    prof ||= uniform();
    for (let i = 4; i < prof.length; i += 2) {        // première couche intacte (comme Orca)
      const d = Math.abs(prof[i] - z);
      if (d > band) continue;
      const w = 0.5 * (1 + Math.cos(Math.PI * d / band));
      prof[i + 1] = +(prof[i + 1] + (h - prof[i + 1]) * w).toFixed(4);
    }
    // recalcul des hauteurs z à partir des épaisseurs (le profil reste continu)
    let zz = prof[2];
    const out = prof.slice(0, 4);
    for (let i = 4; i < prof.length && zz < H - 1e-4; i += 2) { out.push(+zz.toFixed(4), prof[i + 1]); zz += prof[i + 1]; }
    prof = out;
    draw();
  };
  cv.onpointerdown = (e) => { dragging = true; cv.setPointerCapture(e.pointerId); edit(e); };
  cv.onpointermove = (e) => { if (dragging) edit(e); };
  cv.onpointerup = () => { dragging = false; };
  wrap.querySelector('[data-ok]').onclick = () => {
    o.layer_profile = prof || [];
    for (const j of Object.values(S.jobs)) j.stale = true;
    md.close(); saveLocal(); renderObjectList();
    toast(prof ? `Profil de ${prof.length / 2} couches enregistré` : 'Hauteur de couche uniforme rétablie');
  };
  draw();
}

// ---------- calibrations (menu Calibration d'Orca) ----------
const CALIBS = {
  temp: { label: 'Température (tour)', fields: [['start', 'Température de départ (°C)', 230], ['end', 'Température de fin (°C)', 190]],
    presets: { PLA: [230, 190], 'ABS/ASA': [270, 230], PETG: [250, 230], PCTG: [280, 240], TPU: [240, 210], 'PA-CF / PET-CF': [320, 280] },
    help: 'Tour par paliers de 5 °C (10 mm par palier). Garde la température dont le palier est le plus propre.' },
  flow1: { label: 'Débit — passe 1', fields: [], help: '9 carrés de −20 % à +20 % de débit. Note le carré au dessus le plus lisse, puis fais la passe 2.' },
  flow2: { label: 'Débit — passe 2', fields: [], help: '10 carrés de −9 % à 0 %, autour du meilleur résultat de la passe 1.' },
  yolo1: { label: 'Débit — YOLO (recommandé)', fields: [], help: '11 carrés de −0,05 à +0,05 sur le débit du filament (pas de 0,01). Note le plus lisse et ajoute sa valeur au débit actuel.' },
  yolo2: { label: 'Débit — YOLO perfectionniste', fields: [], help: '16 carrés de −0,035 à +0,04 (pas de 0,005) pour affiner.' },
  pa_tower: { label: 'Pressure advance (tour)', fields: [['start', 'PA de départ', 0], ['end', 'PA de fin', 0.1], ['step', 'Pas par mm', 0.002]],
    help: 'La valeur change à chaque millimètre de hauteur : mesure la hauteur où les angles sont les plus nets.' },
  pa_line: { label: 'Pressure advance (lignes)', fields: [['start', 'PA de départ', 0], ['end', 'PA de fin', 0.1], ['step', 'Pas', 0.002]],
    help: 'Une ligne lente / rapide / lente par valeur, numérotée : garde la ligne la plus régulière (pas de surépaisseur ni de manque aux changements de vitesse).' },
  pa_pattern: { label: 'Pressure advance (motif)', fields: [['start', 'PA de départ', 0], ['end', 'PA de fin', 0.08], ['step', 'Pas', 0.005]],
    help: 'Chevrons imprimés sur 4 couches, un par valeur : garde celui dont la pointe est la plus nette.' },
  retraction: { label: 'Rétraction (tour)', fields: [['start', 'Longueur de départ (mm)', 0], ['end', 'Longueur de fin (mm)', 2], ['step', 'Pas par mm (mm)', 0.1]],
    help: 'La longueur de rétraction augmente avec la hauteur : retiens celle où les fils disparaissent.' },
  max_flow: { label: 'Débit volumétrique max', fields: [['start', 'Départ (mm³/s)', 5], ['end', 'Fin (mm³/s)', 20], ['step', 'Pas (mm³/s par mm)', 0.5]],
    help: 'Vase à une paroi dont la vitesse augmente avec la hauteur : la limite est là où la paroi se dégrade.' },
  vfa: { label: 'VFA (artefacts de vitesse)', fields: [['start', 'Vitesse de départ (mm/s)', 40], ['end', 'Vitesse de fin (mm/s)', 200], ['step', 'Pas (mm/s)', 10]],
    help: 'Vase dont la vitesse de paroi monte par blocs de 5 mm : repère les vitesses qui laissent des stries verticales.' },
  is_freq: { label: 'Input shaping — fréquence', fields: [['start', 'Fréquence de départ (Hz)', 15], ['end', 'Fréquence de fin (Hz)', 110], ['damp', 'Amortissement', 0.1]],
    help: 'La fréquence du shaper monte avec la hauteur : retiens celle où les échos (ringing) disparaissent, en X et en Y.' },
  is_damp: { label: 'Input shaping — amortissement', fields: [['freq', 'Fréquence (Hz)', 50], ['start', 'Amortissement de départ', 0], ['end', 'Amortissement de fin', 0.4]],
    help: "À la fréquence trouvée, l'amortissement monte avec la hauteur : retiens la hauteur la plus nette." },
  cornering: { label: 'Jerk / SCV (angles)', fields: [['start', 'SCV de départ (mm/s)', 1], ['end', 'SCV de fin (mm/s)', 15]],
    help: 'Le square_corner_velocity de Klipper monte avec la hauteur : garde la plus haute valeur sans angle arrondi ni écho.' },
};

function calibModal() {
  const wrap = document.createElement('form');
  const render = (kind) => {
    const c = CALIBS[kind];
    const type = String(scalar(effective('filament', 'filament_type', 0)) || '').toUpperCase();
    const preset = c.presets ? Object.entries(c.presets).find(([k]) => k.split(/[ /]+/).some((x) => type.startsWith(x)))?.[1] : null;
    wrap.innerHTML = `<label>Calibration <select name="kind">${Object.entries(CALIBS).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <div class="grid3" style="margin-top:8px">${c.fields.map(([k, l, d], i) => `<label>${l}<input name="${k}" type="number" step="any" value="${preset && i < 2 ? preset[i] : d}"></label>`).join('')}</div>
      ${c.presets ? `<p class="muted small">Préréglages d'Orca : ${Object.entries(c.presets).map(([k, v]) => `${k} ${v[0]}→${v[1]} °C`).join(' · ')}</p>` : ''}
      <p class="muted small">${c.help}<br>Filament utilisé : ${esc(S.filaments[0]?.profile || '')}. Le projet actuel est remplacé.</p>
      <div class="row gap" style="justify-content:flex-end"><button class="btn primary">Préparer</button></div>`;
    wrap.kind.onchange = () => render(wrap.kind.value);
  };
  render('temp');
  const md = modal('Calibration (comme le menu Calibration d\'Orca)', wrap);
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const kind = wrap.kind.value;
    const params = Object.fromEntries(CALIBS[kind].fields.map(([k]) => [k, parseFloat(wrap[k].value)]));
    md.close();
    busy('Préparation de la calibration…');
    try {
      const r = await api('/slicer/api/calib/' + kind, { json: { machine: S.machine, process: S.process, filament: S.filaments[0].profile, params } });
      plate.clear(); plate.setPlates(1, ['']); S.jobs = {}; S.wipeTower = []; showJob();
      S.filaments = [S.filaments.find((f) => !f.mixed) || S.filaments[0]];
      S.ov = { machine: { ...r.machine }, process: { ...r.process }, filament: [{ ...r.filament }] };
      S.flush = null;
      S.layerGcodes = r.layer_gcodes.length ? { 0: r.layer_gcodes.map((g) => ({ z: g.z, type: 4, extruder: 1, color: '', extra: g.extra })) } : {};
      S.calibPost = r.post || null;
      await setProcess(S.process, true);
      renderFilaments();
      const b = plate.base || { cx: 128, cy: 128 };
      // un objet : centré ; plusieurs (tests de débit) : disposition d'origine recentrée sur le plateau
      const cs = r.objects.map((o) => o.center);
      const gx = cs.reduce((a, c) => a + c[0], 0) / cs.length, gy = cs.reduce((a, c) => a + c[1], 0) / cs.length;
      for (const o of r.objects) {
        let x = r.objects.length > 1 ? b.cx + o.center[0] - gx : b.cx, y = r.objects.length > 1 ? b.cy + o.center[1] - gy : b.cy;
        if (o.abs_xy) [x, y] = o.abs_xy;          // position imposée (poignée du test PA en motif)
        await plate.addObject({ model_id: r.model_id, index: o.index, name: o.name, extruder: 1, settings: o.settings, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1] });
      }
      plate.view('iso');
      S.projectName = r.name;
      renderObjectList(); renderPanel(); saveLocal();
      toast(`${r.name} prêt : découpe le plateau pour l'imprimer`, '', 6000);
    } catch (err) { toast('Calibration : ' + err.message, 'err', 8000); }
    busy(false);
  };
}

// ---------- coupe (outil Coupe d'Orca) ----------
async function cutModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  if (o.parts.some((pt) => pt.subtype !== 'normal_part') || o.parts.length) {
    toast('Coupe : seul le maillage principal est coupé ; les pièces de l\'objet ne sont pas reprises (sépare-les d\'abord si besoin)', 'warn', 7000);
  }
  const THREE = await import('three');
  const b = plate.worldBox(o);
  const c = new THREE.Vector3(); b.getCenter(c);
  const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * 1.3;
  // valeurs par défaut d'Orca (GLGizmoCut3D) : plan horizontal au milieu de l'objet, haut posé sur la coupe
  const st = { z: +(c.z).toFixed(2), rx: 0, ry: 0, keep_upper: true, keep_lower: true, place_upper: true, place_lower: false, flip_upper: false, flip_lower: false,
    parts: false, ctype: 'none', style: 'prism', shape: 'circle', csize: 2.5, depth: 3, stol: 0, dtol: 0.1, count: 1, positions: [] };
  const normal = () => new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(st.rx), THREE.MathUtils.degToRad(st.ry), 0, 'XYZ')).toArray();
  const point = () => [c.x, c.y, st.z];
  const wrap = document.createElement('form');
  wrap.innerHTML = `<div class="grid3">
      <label>Hauteur du plan (mm)<input name="z" type="number" step="0.1" value="${st.z}"></label>
      <label>Inclinaison X°<input name="rx" type="number" step="1" value="0"></label>
      <label>Inclinaison Y°<input name="ry" type="number" step="1" value="0"></label></div>
    <input name="zr" type="range" min="${b.min.z.toFixed(2)}" max="${b.max.z.toFixed(2)}" step="0.1" value="${st.z}" style="width:100%">
    <table class="cmp" style="margin-top:6px"><tr><th>Après la coupe</th><th>Garder</th><th>Poser sur la coupe</th><th>Retourner</th></tr>
      <tr><td>Partie haute</td><td><input type="checkbox" name="keep_upper" checked></td><td><input type="checkbox" name="place_upper" checked></td><td><input type="checkbox" name="flip_upper"></td></tr>
      <tr><td>Partie basse</td><td><input type="checkbox" name="keep_lower" checked></td><td><input type="checkbox" name="place_lower"></td><td><input type="checkbox" name="flip_lower"></td></tr></table>
    <label class="check"><input type="checkbox" name="parts"> Couper en pièces (un seul objet, deux pièces)</label>
    <div class="panel-title" style="margin-top:8px">Connecteurs</div>
    <div class="grid3">
      <label>Type<select name="ctype"><option value="none">Aucun</option><option value="plug">Tenon</option><option value="dowel">Goujon</option></select></label>
      <label>Forme<select name="shape"><option value="circle">Cercle</option><option value="square">Carré</option><option value="hexagon">Hexagone</option><option value="triangle">Triangle</option></select></label>
      <label>Style<select name="cstyle"><option value="prism">Prisme</option><option value="frustum">Tronc de cône</option></select></label>
      <label>Taille (mm)<input name="csize" type="number" step="0.1" value="2.5"></label>
      <label>Profondeur (mm)<input name="depth" type="number" step="0.1" value="3"></label>
      <label>Nombre<input name="count" type="number" min="1" max="12" value="1"></label>
      <label>Tolérance taille (mm)<input name="stol" type="number" step="0.05" value="0"></label>
      <label>Tolérance profondeur (mm)<input name="dtol" type="number" step="0.05" value="0.1"></label>
      <span class="muted small" id="cut-pos" style="align-self:end"></span></div>
    <div class="row gap" style="margin-top:10px;justify-content:flex-end"><button type="button" class="btn" data-cancel>Annuler</button><button class="btn primary">Couper</button></div>`;
  const md = modal(`Couper « ${o.name} »`, wrap);
  const close = () => { plate.showCutPlane(null); md.close(); };
  wrap.querySelector('[data-cancel]').onclick = close;
  document.getElementById('modal-close').addEventListener('click', () => plate.showCutPlane(null), { once: true });
  let posTimer = null, pending = null;
  const body = (extra = {}) => ({ model_id: o.model_id, index: o.index, matrix: plate.matrixOf(o), point: point(), normal: normal(), ...extra });
  const placeConnectors = () => {
    clearTimeout(posTimer);
    if (st.ctype === 'none') { st.positions = []; draw(); $('cut-pos').textContent = ''; return; }
    posTimer = setTimeout(() => { pending = run(); }, 250);
    const run = async () => {
      try {
        const r = await api('/slicer/api/cut/section', { json: body({ count: st.count, size: st.csize }) });
        st.positions = r.positions;
        if (!document.body.contains(wrap)) return;
        $('cut-pos').textContent = r.positions.length ? `${r.positions.length} connecteur(s) placé(s) dans la section (${r.area.toFixed(0)} mm²)` : 'Section trop petite pour ces connecteurs';
        draw();
      } catch (e) { if (document.getElementById('cut-pos')) $('cut-pos').textContent = e.message; }
    };
  };
  const draw = () => {
    const h = st.ctype === 'dowel' && st.style === 'prism' ? st.depth * 2 : st.depth;
    plate.showCutPlane(point(), normal(), size, st.positions.map(([x, y]) => ({ x, y, z: st.ctype === 'dowel' ? 0 : h / 2, r: st.csize / 2, h })));
  };
  const read = () => {
    const f = wrap;
    st.z = +f.z.value; st.rx = +f.rx.value; st.ry = +f.ry.value;
    for (const k of ['keep_upper', 'keep_lower', 'place_upper', 'place_lower', 'flip_upper', 'flip_lower', 'parts']) st[k] = f[k].checked;
    st.ctype = f.ctype.value; st.style = f.cstyle.value; st.shape = f.shape.value;
    st.csize = +f.csize.value || 2.5; st.depth = +f.depth.value || 3; st.stol = +f.stol.value || 0; st.dtol = +f.dtol.value || 0; st.count = Math.max(1, +f.count.value || 1);
    if (st.parts) { for (const k of ['place_upper', 'place_lower', 'flip_upper', 'flip_lower']) { st[k] = false; f[k].checked = false; } st.keep_upper = st.keep_lower = true; f.keep_upper.checked = f.keep_lower.checked = true; }
  };
  wrap.addEventListener('input', (e) => {
    if (e.target.name === 'zr') wrap.z.value = e.target.value;
    if (e.target.name === 'z') wrap.zr.value = e.target.value;
    read(); draw(); placeConnectors();
  });
  read(); draw();
  wrap.onsubmit = async (e) => {
    e.preventDefault(); read();
    if (st.ctype !== 'none') { clearTimeout(posTimer); busy('Placement des connecteurs…'); await (pending = (async () => { const r = await api('/slicer/api/cut/section', { json: body({ count: st.count, size: st.csize }) }); st.positions = r.positions; })()).catch(() => {}); busy(false); }
    if (!st.keep_upper && !st.keep_lower) { toast('Garde au moins une des deux parties'); return; }
    const connectors = st.ctype === 'none' ? [] : st.positions.map(([x, y]) => ({ type: st.ctype, style: st.style, shape: st.shape, x, y, size: st.csize, depth: st.depth, size_tolerance: st.stol, depth_tolerance: st.dtol }));
    busy('Coupe…');
    try {
      const r = await api('/slicer/api/cut', { json: body({ options: { keep_upper: st.keep_upper, keep_lower: st.keep_lower, place_upper: st.place_upper, place_lower: st.place_lower,
        flip_upper: st.flip_upper, flip_lower: st.flip_lower, connectors } }) });
      close();
      const pl = o.plate;
      plate.remove(o);
      const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const P = point();
      const mk = (ob) => ({ model_id: r.model_id, index: ob.index, name: `${o.name.replace(/\.[^.]+$/, '')} — ${{ upper: 'haut', lower: 'bas', dowel: 'goujon' }[ob.kind]}`,
        extruder: o.extruder, settings: { ...o.settings },
        parts: ob.parts.map((pt) => ({ model_id: r.model_id, index: pt.index, name: pt.name, subtype: pt.subtype, settings: {}, extruder: 0, matrix: ident })) });
      const at = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
      const made = [];
      if (st.parts) {
        // un seul objet : la partie basse porte la haute en pièce, chacune à sa place d'origine
        const lo = r.objects.find((x) => x.kind === 'lower'), up = r.objects.find((x) => x.kind === 'upper');
        const base = lo || up, other = lo && up ? up : null;
        const bo = base.offset;
        const obj = await plate.addObject({ ...mk(base), name: o.name, matrix: at(P[0] + bo[0], P[1] + bo[1], P[2] + bo[2]) });
        if (other) {
          const oo = other.offset;
          await plate.addPart(obj, { model_id: r.model_id, index: other.index, name: 'partie haute', subtype: 'normal_part', settings: {}, extruder: 0,
            matrix: at(oo[0] - bo[0], oo[1] - bo[1], oo[2] - bo[2]) });
          for (const pt of other.parts) await plate.addPart(obj, { model_id: r.model_id, index: pt.index, name: pt.name, subtype: pt.subtype, settings: {}, extruder: 0, matrix: at(oo[0] - bo[0], oo[1] - bo[1], oo[2] - bo[2]) });
        }
        plate._afterTransform(obj);
        made.push(obj);
      } else {
        let dx = 0;
        for (const ob of r.objects) {
          const off = ob.offset || [0, 0, 0];
          const m = ob.kind !== 'dowel' && !ob.placed ? at(P[0] + off[0], P[1] + off[1], 0) : at(c.x + dx, c.y + (ob.kind === 'dowel' ? -(b.max.y - b.min.y) : 0), 0);
          dx += (ob.size?.[0] || 10) + 5;
          made.push(await plate.addObject({ ...mk(ob), matrix: m }));
        }
      }
      if (pl >= 0) plate.setCurrent(pl, true);
      plate.arrangeIfOverlap(made.at(-1));
      plate.select(made[0]);
      renderObjectList(); saveLocal();
      toast(`Coupe réalisée : ${r.objects.length} pièce(s)`);
    } catch (err) { toast('Coupe impossible : ' + err.message, 'err', 8000); }
    busy(false);
  };
}

async function addModifierModal() {
  const o = plate.selected;
  if (!o) { toast('Sélectionne d\'abord un objet'); return; }
  const b = plate.worldBox(o);
  const s = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => Math.max(5, Math.round(v / 2)));
  const wrap = document.createElement('form');
  wrap.innerHTML = `<div class="grid3">
    <label>Type<select name="sub"><option value="modifier_part">Modificateur (réglages locaux)</option><option value="support_blocker">Bloqueur de support</option>
      <option value="support_enforcer">Forceur de support</option><option value="negative_part">Volume négatif (trou)</option><option value="normal_part">Pièce (solide)</option></select></label>
    <label>Forme<select name="shape"><option value="box">Cube</option><option value="cylinder">Cylindre</option><option value="sphere">Sphère</option><option value="file">Depuis un fichier…</option></select></label>
    <label class="hidden" data-file>Fichier<input type="file" name="file" accept=".stl,.obj,.3mf,.step,.stp,.ply,.amf"></label>
    <label>X mm<input name="x" type="number" value="${s[0]}"></label><label>Y mm<input name="y" type="number" value="${s[1]}"></label><label>Z mm<input name="z" type="number" value="${s[2]}"></label>
  </div><p class="muted small">La pièce est placée au centre de l'objet. Sélectionne-la ensuite dans la liste des objets pour régler sa position (via ses réglages) ou ses paramètres.</p>
  <div class="row" style="justify-content:flex-end"><button class="btn primary">Ajouter</button></div>`;
  const md = modal('Ajouter une pièce', wrap);
  wrap.shape.onchange = () => { const f = wrap.shape.value === 'file'; wrap.querySelector('[data-file]').classList.toggle('hidden', !f); ['x', 'y', 'z'].forEach((k) => { wrap[k].disabled = f; }); };
  wrap.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(wrap);
    try {
      let meta;
      if (fd.get('shape') === 'file') {
        const file = wrap.file.files[0];
        if (!file) { toast('Choisis un fichier'); return; }
        const up = new FormData(); up.append('file', file);
        meta = await api('/slicer/api/models', { method: 'POST', body: up });   // centré sur sa base, à sa taille d'origine
        fd.set('z', String(meta.objects[0].size[2]));
      } else {
        meta = await api('/slicer/api/models/primitive', { json: { shape: fd.get('shape'), size: [+fd.get('x'), +fd.get('y'), +fd.get('z')] } });
      }
      // position au centre de l'objet, exprimée dans le repère de l'objet
      const THREE = await import('three');
      const c = new THREE.Vector3(); b.getCenter(c); c.z = b.min.z + (b.max.z - b.min.z) / 2 - (+fd.get('z')) / 2;
      const inv = o.group.matrixWorld.clone().invert();
      const local = c.clone().applyMatrix4(inv);
      const scl = o.group.scale;
      const m = new THREE.Matrix4().compose(local, o.group.quaternion.clone().invert(), new THREE.Vector3(1 / scl.x, 1 / scl.y, 1 / scl.z));
      const labels = { modifier_part: 'Modificateur', support_blocker: 'Bloqueur', support_enforcer: 'Forceur', negative_part: 'Négatif', normal_part: 'Pièce' };
      const part = await plate.addPart(o, { model_id: meta.id, index: 0, name: `${labels[fd.get('sub')]} ${meta.objects[0].name.toLowerCase()}`, subtype: fd.get('sub'), matrix: m.toArray() });
      S.selectedPart = part; S.scope = 'object';
      md.close(); renderObjectList(); renderPanel(); saveLocal();
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ---------- découpe ----------
function buildOverrides() {
  const ov = { ...S.ov.machine, ...S.ov.process };
  if (S.bedType) ov.curr_bed_type = S.bedType;
  if (S.flushMult != null) ov.flush_multiplier = [S.flushMult];
  Object.assign(ov, mixedOverrides());
  Object.assign(ov, towerOverrides());
  const n = S.filaments.length;
  const keys = new Set(S.ov.filament.flatMap((f) => Object.keys(f || {})));
  for (const k of keys) {
    ov[k] = S.filaments.map((_, i) => scalar(effective('filament', k, i)));
  }
  return ov;
}

function sliceBody(objects, plateName) {
  return {
    machine: S.machine, process: S.process,
    filaments: S.filaments.map((f) => f.profile), colours: S.filaments.map((f) => f.colour),
    objects, overrides: buildOverrides(), flush: S.flush, plate_name: plateName, layer_gcodes: S.layerGcodes, post: S.calibPost,
  };
}

// Découpe un plateau (par défaut le plateau actif). Renvoie true si la découpe a réussi.
async function slice(pi = plate.current, { show = true, ask = true } = {}) {
  if (typeof pi !== 'number') pi = plate.current;
  const mine = plate.objectsOf(pi);
  if (!mine.length) { if (ask) toast(plate.plateCount > 1 ? `${plateLabel(pi)} est vide` : 'Le plateau est vide'); return false; }
  const outside = mine.filter((o) => o.outside);
  if (ask && outside.length && !await confirm2('Objets hors du plateau', `${outside.length} objet(s) dépassent du volume d'impression. Découper quand même ?`, 'Découper')) return false;
  const maxExt = Math.max(...mine.map((o) => o.extruder));
  if (maxExt > S.filaments.length) { toast('Un objet utilise un filament qui n\'existe plus', 'err'); return false; }
  // objets envoyés dans la grille de plateaux, comme dans un projet Orca : même G-code qu'Orca, au point de départ près
  const body = { ...sliceBody(plate.serialize(pi, false), plate.plateNames[pi] || S.projectName || `Plateau ${pi + 1}`), plate_index: pi, plate_count: plate.plateCount, plate_settings: S.plateSettings[pi] || {} };
  const label = plate.plateCount > 1 ? `Découpe de ${plateLabel(pi)}` : 'Découpe en cours';
  busy(label + '…');
  const t0 = Date.now();
  let ok = false;
  try {
    const { id } = await api('/slicer/api/slice', { json: body });
    let job;
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      job = await api('/slicer/api/jobs/' + id);
      $('busy-text').textContent = `${label}… ${Math.round((Date.now() - t0) / 1000)} s`;
      if (job.state === 'done' || job.state === 'error') break;
    }
    if (job.state === 'error') throw new Error(job.error);
    $('busy-text').textContent = 'Chargement de l\'aperçu…';
    const text = await api(`/slicer/api/jobs/${id}/gcode`, { raw: 'text' });
    await new Promise((r) => setTimeout(r, 30));
    S.jobs[pi] = { job, gcodeData: parseGcode(text) };
    ok = true;
    if (show) { if (plate.current !== pi) plate.setCurrent(pi); showJob(); showTab('preview'); }
    for (const w of job.info?.warnings || []) toast('Orca : ' + w, 'warn', 8000);
  } catch (e) {
    toast(`Découpe impossible${plate.plateCount > 1 ? ` (${plateLabel(pi)})` : ''} : ` + e.message, 'err', 10000);
  }
  busy(false);
  renderPlates();
  return ok;
}

async function sliceAll() {
  const todo = Array.from({ length: plate.plateCount }, (_, i) => i).filter((i) => plate.objectsOf(i).length);
  if (!todo.length) { toast('Tous les plateaux sont vides'); return; }
  let done = 0;
  for (const i of todo) if (await slice(i, { show: false, ask: false })) done++;
  showJob();
  if (S.jobs[plate.current]) showTab('preview');
  toast(`${done}/${todo.length} plateau(x) découpé(s)`, done === todo.length ? '' : 'warn', 6000);
}

// Affiche dans l'aperçu la découpe du plateau actif (ou l'état vide s'il n'est pas découpé).
function showJob() {
  const j = S.jobs[plate.current];
  S.job = j?.job || null; S.gcodeData = j?.gcodeData || null;
  if (!j) {
    $('preview-empty').classList.remove('hidden');
    ['layer-slider-wrap', 'move-slider-wrap', 'legend', 'stats', 'ticks'].forEach((id) => $(id).classList.add('hidden'));
    preview.clear?.();
    return;
  }
  preview.toolColours = S.filaments.map((f) => f.colour);
  preview.setGhost(plate.objectsOf(plate.current), plate.plateOrigin(plate.current));
  preview.load(S.gcodeData);
  setupPreviewUI();
}

// ---------- changements par couche (curseur de l'aperçu) ----------
const TICK = { COLOR: 0, PAUSE: 1, TOOL: 2, TEMPLATE: 3, CUSTOM: 4 };

function plateExtruders(i) {
  const ext = new Set();
  for (const o of plate.objectsOf(i)) { ext.add(o.extruder); for (const pt of o.parts) if ((pt.subtype === 'modifier_part' || pt.subtype === 'normal_part') && pt.extruder > 0) ext.add(pt.extruder); }
  return [...ext];
}

function tickLabel(t) {
  if (t.type === TICK.TOOL) return `Changer pour le filament ${t.extruder}`;
  if (t.type === TICK.PAUSE) return 'Pause';
  if (t.type === TICK.TEMPLATE) return 'Modèle de G-code personnalisé';
  if (t.type === TICK.COLOR) return `Changement de couleur (M600)`;
  return 'G-code : ' + (t.extra || '').split('\n')[0].slice(0, 40);
}

function markStale() {
  const j = S.jobs[plate.current];
  if (j) j.stale = true;
  renderTicks();
}

function renderTicks() {
  const d = S.gcodeData, el = $('ticks-list');
  const list = (S.layerGcodes[plate.current] || []).slice().sort((a, b) => a.z - b.z);
  $('ticks').classList.toggle('hidden', !d || (!list.length && !S.jobs[plate.current]?.stale));
  const layerOf = (z) => (d ? d.layers.findIndex((L) => Math.abs(L.z - z) < 1e-3) : -1);
  el.innerHTML = list.map((t, k) => `<div class="tick-row"><span class="z">couche ${layerOf(t.z) + 1 || '?'} · ${t.z.toFixed(2)} mm</span>
      ${t.type === TICK.TOOL ? `<span class="swatch" style="background:${esc(S.filaments[t.extruder - 1]?.colour || t.color)}"></span>` : ''}
      <span class="what">${esc(tickLabel(t))}</span><button class="icon" data-go="${k}" title="Aller à cette couche">↕</button><button class="icon" data-del="${k}" title="Supprimer">✕</button></div>`).join('')
    + (S.jobs[plate.current]?.stale ? '<div id="stale">⚠ Modifié depuis la découpe : redécoupe le plateau pour appliquer.</div>' : '');
  el.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    const t = list[+b.dataset.del];
    S.layerGcodes[plate.current] = (S.layerGcodes[plate.current] || []).filter((x) => x !== t);
    saveLocal(); markStale(); drawTickMarks();
  });
  el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => {
    const i = layerOf(list[+b.dataset.go].z);
    if (i >= 0) { $('layer-top').value = i; $('layer-top').oninput(); }
  });
}

function drawTickMarks() {
  const wrap = $('layer-slider-wrap'), d = S.gcodeData;
  wrap.querySelectorAll('.tick-mark').forEach((m) => m.remove());
  if (!d) return;
  const top = $('layer-top'), r = top.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const n = d.layers.length;
  for (const t of S.layerGcodes[plate.current] || []) {
    const i = d.layers.findIndex((L) => Math.abs(L.z - t.z) < 1e-3);
    if (i < 0) continue;
    const m = document.createElement('div');
    m.className = 'tick-mark';
    m.style.top = `${r.top - wr.top + (1 - i / Math.max(1, n - 1)) * (r.height - 8) + 4}px`;
    m.style.background = t.type === TICK.TOOL ? (S.filaments[t.extruder - 1]?.colour || 'var(--accent)') : t.type === TICK.PAUSE ? 'var(--warn)' : 'var(--accent)';
    m.title = tickLabel(t);
    wrap.appendChild(m);
  }
}

async function addTick() {
  const d = S.gcodeData;
  if (!d) return;
  const L = d.layers[+$('layer-top').value];
  const z = Math.round(L.z * 1000) / 1000;
  const cur = S.layerGcodes[plate.current] || [];
  if (cur.some((t) => Math.abs(t.z - z) < 1e-3)) { toast('Il y a déjà un changement à cette couche (supprime-le d\'abord)'); return; }
  // comme Orca : « Changer de filament » seulement si le plateau n'utilise qu'un filament
  const ext = plateExtruders(plate.current);
  const canChange = S.filaments.length > 1 && ext.length === 1;
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="muted small">Couche ${+$('layer-top').value + 1} · ${z.toFixed(2)} mm — inséré au début de cette couche.</p>
    <div class="list-pick">
      <button class="btn" data-t="pause" style="display:block;width:100%;text-align:left;margin-bottom:6px">⏸ Ajouter une pause</button>
      ${S.filaments.length > 1 ? `<div class="muted small" style="margin:8px 0 4px">Changer de filament${canChange ? '' : ' (indisponible : ce plateau utilise déjà plusieurs filaments, comme dans Orca)'}</div>
        ${S.filaments.map((f, i) => `<button class="btn" data-f="${i + 1}" ${canChange && i + 1 !== ext[0] ? '' : 'disabled'} style="display:block;width:100%;text-align:left;margin-bottom:4px"><span class="swatch" style="background:${esc(f.colour)}"></span> Filament ${i + 1} — ${esc(f.profile.split('@')[0])}</button>`).join('')}` : ''}
      <div class="muted small" style="margin:8px 0 4px">G-code</div>
      <button class="btn" data-t="custom" style="display:block;width:100%;text-align:left;margin-bottom:6px">Ajouter un G-code personnalisé…</button>
      <button class="btn" data-t="template" style="display:block;width:100%;text-align:left">Ajouter le modèle de G-code personnalisé (réglage de l'imprimante)</button>
    </div>`;
  const md = modal('Ajouter à cette couche', wrap);
  const push = (t) => { S.layerGcodes[plate.current] = [...cur, { z, color: '', extra: '', extruder: ext[0] || 1, ...t }]; saveLocal(); md.close(); markStale(); drawTickMarks(); };
  wrap.querySelector('[data-t=pause]').onclick = () => push({ type: TICK.PAUSE });
  wrap.querySelector('[data-t=template]').onclick = () => push({ type: TICK.TEMPLATE });
  wrap.querySelector('[data-t=custom]').onclick = async () => {
    md.close();
    const g = await prompt2('G-code personnalisé', `Inséré au début de la couche à ${z.toFixed(2)} mm (une ligne ; plusieurs commandes séparées par « \\n »)`, '');
    if (g) { S.layerGcodes[plate.current] = [...cur, { z, type: TICK.CUSTOM, extruder: ext[0] || 1, color: '', extra: g.replace(/\\n/g, '\n') }]; saveLocal(); markStale(); drawTickMarks(); }
  };
  wrap.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => push({ type: TICK.TOOL, extruder: +b.dataset.f, color: S.filaments[+b.dataset.f - 1].colour }));
}

// ---------- lecture animée (comme le bouton lecture de l'aperçu d'Orca) ----------
let playTimer = null;
function togglePlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; $('play-btn').textContent = '▶'; return; }
  const d = S.gcodeData; if (!d) return;
  const top = $('layer-top'), mv = $('move-slider');
  if (+top.value >= d.layers.length - 1 && +mv.value >= +mv.max) { top.value = 0; top.oninput(); mv.value = 0; mv.oninput(); }
  $('play-btn').textContent = '⏸';
  playTimer = setInterval(() => {
    const step = Math.max(1, Math.round(+$('play-speed').value * 2));
    if (+mv.value < +mv.max) { mv.value = Math.min(+mv.max, +mv.value + step); mv.oninput(); return; }
    if (+top.value < d.layers.length - 1) { top.value = +top.value + 1; top.oninput(); mv.value = 0; mv.oninput(); return; }
    togglePlay();
  }, 30);
}

function setupPreviewUI() {
  const d = S.gcodeData;
  $('preview-empty').classList.add('hidden');
  ['layer-slider-wrap', 'move-slider-wrap', 'legend', 'stats'].forEach((id) => $(id).classList.remove('hidden'));
  const top = $('layer-top'), bot = $('layer-bottom'), mv = $('move-slider');
  const n = d.layers.length;
  top.min = 0; top.max = n - 1; top.value = n - 1;
  bot.min = 0; bot.max = n - 1; bot.value = 0;
  const updMove = () => {
    const L = d.layers[+top.value];
    mv.min = 0; mv.max = L.end - L.start; mv.value = mv.max;
  };
  const upd = (fromMove = false) => {
    let t = +top.value, b = +bot.value;
    if (b > t) { b = t; bot.value = b; }
    if (!fromMove) updMove();
    const L = d.layers[t];
    const mEnd = +mv.value >= +mv.max ? null : +mv.value;
    preview.setRange(b, t, mEnd);
    $('layer-top-label').innerHTML = `${t + 1}<br>${L.z.toFixed(2)}`;
    $('layer-bottom-label').innerHTML = `${b + 1}<br>${d.layers[b].z.toFixed(2)}`;
  };
  top.oninput = () => upd(); bot.oninput = () => upd(); mv.oninput = () => upd(true);
  upd();
  renderLegend();
  renderStats();
  renderTicks();
  requestAnimationFrame(drawTickMarks);
}

function renderLegend() {
  $('legend-items').innerHTML = preview.legend();
  $('legend-items').querySelectorAll('[data-type]').forEach((el) => el.onclick = () => { preview.toggleType(el.dataset.type); renderLegend(); });
}

function renderStats() {
  const st = S.job.stats || {};
  const g = st.filament_g || [], m = st.filament_mm || [], cost = st.cost || [];
  const used = S.gcodeData.toolsUsed;
  const chk = Object.fromEntries(spoolCheck(g).map((c) => [c.i, c]));
  const rows = S.filaments.map((f, i) => (used.includes(i) || +g[i] > 0) ? `<tr><td><span class="swatch" style="background:${esc(f.colour)}"></span> ${i + 1} · ${esc(f.profile.split('@')[0])}</td>
    <td>${(+(m[i] || 0) / 1000).toFixed(2)} m</td><td>${(+(g[i] || 0)).toFixed(1)} g</td></tr>
    ${chk[i] ? `<tr class="${chk[i].ok ? 'muted' : ''}" style="${chk[i].ok ? '' : 'color:var(--err)'}"><td colspan="3" class="small">↳ ${esc(spoolName(chk[i].sp))} : ${Math.round(chk[i].sp.remaining_weight)} g restants${chk[i].ok ? ` → ${Math.round(chk[i].sp.remaining_weight - chk[i].need)} g après` : ' — ⚠ pas assez de filament'}</td></tr>` : ''}` : '').join('');
  const secs = parseOrcaTime(st.time);
  $('stats').innerHTML = `<div class="panel-title">Résumé <span class="muted small">découpé en ${S.job.info?.duration ?? '?'} s</span></div>
    <table>
      <tr><td>Temps estimé</td><td colspan="2"><b>${secs ? fmtDuration(secs) : esc(st.time || '?')}</b></td></tr>
      ${secs ? `<tr><td>Fin si lancé maintenant</td><td colspan="2">${new Date(Date.now() + secs * 1000).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td></tr>` : ''}
      <tr><td>Couches</td><td colspan="2">${S.gcodeData.layers.length} · ${esc(st.max_z || '')} mm</td></tr>
      <tr><td>Filament total</td><td colspan="2">${esc(st.total_g || '?')} g${st.total_cost && +st.total_cost > 0 ? ` · ${(+st.total_cost).toFixed(2)} €` : ''}</td></tr>
      ${rows}
      ${st.filament_changes ? `<tr><td>Changements de filament</td><td colspan="2">${esc(st.filament_changes)}</td></tr>` : ''}
      ${(() => {
        // détail par filament : modèle / supports / tour de purge (comme le récapitulatif d'Orca)
        const u = S.gcodeData.use || [];
        const tools = [...new Set(u.map((r) => r.tool))].sort((a, b) => a - b);
        if (!tools.length || (tools.length === 1 && u.every((r) => r.cat === 'model'))) return '';
        const val = (t, c) => u.find((x) => x.tool === t && x.cat === c)?.g || 0;
        const cell = (v) => (v > 0.05 ? `${v.toFixed(1)} g` : '–');
        // purge : ce qu'Orca compte pour le filament (total exact) moins ce qui est déposé sur les pièces, supports et tour
        const flush = (t) => Math.max(0, (+g[t] || 0) - val(t, 'model') - val(t, 'support') - val(t, 'tower'));
        return `<tr><td colspan="3"><table class="cmp" style="margin-top:6px"><tr><th>Filament</th><th>Modèle</th><th>Supports</th><th>Tour</th><th>Purge</th></tr>
          ${tools.map((t) => `<tr><td><span class="swatch" style="background:${esc(S.filaments[t]?.colour || '#ccc')}"></span> ${t + 1}</td><td>${cell(val(t, 'model'))}</td><td>${cell(val(t, 'support'))}</td><td>${cell(val(t, 'tower'))}</td><td>${cell(flush(t))}</td></tr>`).join('')}</table></td></tr>`;
      })()}
    </table>
    <label class="small muted" style="display:block;margin-top:10px">Nom du fichier sur l'imprimante
      <input id="act-name" type="text" style="width:100%" value="${esc(defaultSendName())}"></label>
    <div class="actions">
      <button class="btn primary" id="act-print">${icon('printer', 15)}&nbsp;Imprimer</button>
      <button class="btn" id="act-send">Envoyer sans lancer</button>
      <button class="btn" id="act-queue" title="Envoyer et ajouter à la file d'attente de l'imprimante">Ajouter à la file</button>
      <a class="btn" href="/slicer/api/jobs/${S.job.id}/gcode?download=true">G-code</a>
      <a class="btn" href="/slicer/api/jobs/${S.job.id}/project">3MF</a>
    </div>`;
  $('act-print').onclick = () => sendToPrinter(true);
  $('act-send').onclick = () => sendToPrinter(false);
  $('act-queue').onclick = () => sendToPrinter(false, true);
}

function defaultSendName() {
  const b = (S.projectName || plate.objectsOf(plate.current)[0]?.name || 'plateau').replace(/\.[^.]+$/, '');
  return plate.plateCount > 1 ? `${b}_${plateLabel(plate.current)}` : b;
}

// ---------- fenêtre d'envoi : correspondance filaments du slicer → emplacements de la Box (façon Orca / QIDI Studio) ----------
const EXT_SLOT = 16;   // bobine externe (value_tN = slot16 côté firmware)
const slotLabel = (i) => i === EXT_SLOT ? 'Ext' : `${Math.floor(i / 4) + 1}${'ABCD'[i % 4]}`;
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x808080; return [n >> 16, (n >> 8) & 255, n & 255]; };
const inkOn = (h) => { const [r, g, b] = hexRgb(h); return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1b1b1b' : '#fff'; };
const colDist = (a, b) => { const p = hexRgb(a), q = hexRgb(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const filType = (t) => String(scalar(effective('filament', 'filament_type', t)) || '').toUpperCase();

function defaultSlot(t, slots) {
  const type = filType(t), col = S.filaments[t]?.colour;
  const ok = (s) => s && s.loaded && String(s.type || '').toUpperCase() === type;
  if (ok(slots[t])) return t;
  const cands = slots.filter(ok).sort((a, b) => colDist(a.color, col) - colDist(b.color, col));
  return cands.length ? cands[0].index : t;
}

function printDialog(start, queue, used, box) {
  return new Promise((resolve) => {
    const slots = box?.slots || [];
    const pick = (start || queue) && slots.length > 0 && used.length > 0;
    const map = Object.fromEntries(used.map((t) => [t, pick ? defaultSlot(t, slots) : t]));
    const g = S.job.stats?.filament_g || [];
    const slotInfo = (i) => i === EXT_SLOT ? { index: i, loaded: true, type: '', color: '#F2F2F2', vendor: '', filament: 'Bobine externe' } : slots[i];
    const wrap = document.createElement('div');
    wrap.className = 'pmap';
    wrap.innerHTML = `<p>${start ? 'Envoyer et <b>démarrer</b> l\'impression sur la QIDI ?' : queue ? 'Envoyer le fichier et l\'ajouter à la <b>file d\'attente</b> de la QIDI ?' : 'Envoyer le fichier sur la QIDI sans démarrer ?'}</p>
      ${used.length ? `<div class="pmap-grid"><div class="pmap-lbl"><span>Slicer</span>${pick ? '<span>Box</span>' : ''}</div><div class="pmap-cols"></div></div>` : ''}
      ${pick ? '<p class="muted small pmap-tip">Clique sur une case de la Box pour choisir l\'emplacement utilisé par chaque filament.</p>'
        : (used.length && !(start || queue) ? '<p class="muted small pmap-tip">Envoi sans lancer : l\'emplacement de chaque filament se choisira au lancement, sur l\'écran de l\'imprimante.</p>' : '')}
      <div class="pmap-warn"></div>
      <div class="row gap" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-r="0">Annuler</button>
      <button class="btn primary" data-r="1">${start ? 'Imprimer' : queue ? 'Ajouter' : 'Envoyer'}</button></div>`;
    const cols = wrap.querySelector('.pmap-cols');
    let pop = null;
    const closePop = () => { pop?.remove(); pop = null; };

    const render = () => {
      if (!cols) return;
      cols.innerHTML = used.map((t) => {
        const f = S.filaments[t], s = slotInfo(map[t]);
        return `<div class="pmap-col">
          <div class="pmap-orig" style="background:${esc(f?.colour)};color:${inkOn(f?.colour)}" title="${esc(f?.profile || '')}">${t + 1} ${esc(filType(t) || '?')}</div>
          ${pick ? `<button class="pmap-slot" data-t="${t}" title="${esc(`${s?.vendor || ''} ${s?.filament || ''}`.trim())}">
            <span class="pmap-spool" style="background:${esc(s?.color || '#808080')}"></span><b>${slotLabel(map[t])}</b><span class="pmap-caret">▾</span></button>` : ''}
        </div>`;
      }).join('');
      cols.querySelectorAll('.pmap-slot').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openPop(+b.dataset.t, b); });
      // avertissements
      const w = [];
      if (pick) used.forEach((t) => {
        const s = slotInfo(map[t]), lab = slotLabel(map[t]);
        if (map[t] !== EXT_SLOT && !s?.loaded) w.push(['warn', `Filament ${t + 1} → ${lab} : emplacement vide dans la Box`]);
        else if (map[t] !== EXT_SLOT && s?.type && filType(t) && String(s.type).toUpperCase() !== filType(t)) w.push(['err', `Filament ${t + 1} (${filType(t)}) → ${lab} contient du ${String(s.type).toUpperCase()}`]);
      });
      used.forEach((t) => {
        const id = map[t] === EXT_SLOT ? null : S.slotSpool[map[t]], sp = id ? S.spools[id] : null, need = +(g[t] || 0);
        if (sp && need > 0 && (sp.remaining_weight ?? 0) < need)
          w.push(['err', `${slotLabel(map[t])} — ${spoolName(sp)} : ${sp.weight_src === 'estimated' ? '~' : ''}${Math.round(sp.remaining_weight)} g restants${sp.weight_src === 'estimated' ? ' (poids estimé)' : ''} pour ${need.toFixed(1)} g nécessaires`]);
      });
      wrap.querySelector('.pmap-warn').innerHTML = w.map(([k, m]) => `<p style="color:var(--${k});margin:6px 0 0">⚠ ${esc(m)}</p>`).join('') + relayHtml();
      wrap.querySelectorAll('[data-relay]').forEach((c) => c.onchange = () => { relays[c.dataset.relay].on = c.checked; });
    };
    // relais : bobine trop juste (ou poids seulement estimé) + autre bobine de même matière et couleur proche dans la Box
    const relays = {};
    const relayHtml = () => {
      if (!pick) return '';
      const spAt = (i) => (S.slotSpool[i] ? S.spools[S.slotSpool[i]] : null);
      const mat = (x) => String(x?.material || '').toUpperCase().replace(/\+$/, '');
      const out = [];
      const seen = new Set();
      used.forEach((t) => {
        const m = map[t];
        if (m === EXT_SLOT || seen.has(m)) return;
        seen.add(m);
        const need = used.filter((u) => map[u] === m).reduce((a, u) => a + +(g[u] || 0), 0), sp = spAt(m);
        if (!sp || need <= 0) return;
        const rem = sp.remaining_weight ?? 0, est = sp.weight_src === 'estimated';
        if (!(rem < need * 1.05 || (est && rem < need * 1.5))) { delete relays[m]; return; }
        const active = slots.findIndex((x, c) => c !== m && S.relayOf?.[c] === m);
        if (active >= 0) { out.push(`<div class="pmap-relay"><b>↻ Relais déjà actif</b> : si la ${slotLabel(m)} se vide, la Box continue avec la ${slotLabel(active)}.</div>`); return; }
        const cands = slots.map((x, c) => ({ c, x, s: spAt(c) })).filter(({ c, x, s }) => c !== m && x?.loaded && s && mat(s) === mat(sp)
          && colDist('#' + (s.color_hex || ''), '#' + (sp.color_hex || '')) <= 60 && (s.remaining_weight ?? 0) >= need - Math.max(rem, 0))
          .sort((a, b) => b.s.remaining_weight - a.s.remaining_weight);
        if (!cands.length) { delete relays[m]; return; }
        const c = cands[0];
        if (!relays[m] || relays[m].c !== c.c) relays[m] = { c: c.c, on: true };
        out.push(`<div class="pmap-relay"><b>↻ Relais possible</b> : la ${slotLabel(c.c)} contient aussi ${esc(sp.material || '')} de même couleur (${esc(spoolName(c.s))}, ${Math.round(c.s.remaining_weight)} g).
          <label class="check"><input type="checkbox" data-relay="${m}" ${relays[m].on ? 'checked' : ''}> Si la ${slotLabel(m)} se vide, continuer avec la ${slotLabel(c.c)}</label></div>`);
      });
      return out.join('');
    };

    const openPop = (t, anchor) => {
      closePop();
      pop = document.createElement('div');
      pop.className = 'pmap-pop';
      const tiles = slots.map((s) => {
        const sel = map[t] === s.index;
        return `<button class="pmap-tile${s.loaded ? '' : ' empty'}${sel ? ' sel' : ''}" data-s="${s.index}"
          style="background:${s.loaded ? esc(s.color) : 'transparent'};color:${s.loaded ? inkOn(s.color) : 'var(--muted)'}"
          title="${esc(s.loaded ? `${s.vendor || ''} ${s.filament || s.type || ''}`.trim() : 'Emplacement vide')}">
          <span class="bar" style="background:${esc(s.color)}"></span><b>${slotLabel(s.index)}</b><span>${esc(s.loaded ? s.type || '?' : 'vide')}</span></button>`;
      });
      const boxes = [];
      for (let i = 0; i < tiles.length; i += 4) boxes.push(`<div class="pmap-box"><div class="pmap-tiles">${tiles.slice(i, i + 4).join('')}</div><div class="pmap-boxname">QIDI-BOX${tiles.length > 4 ? ' ' + (i / 4 + 1) : ''}</div></div>`);
      pop.innerHTML = `<div class="pmap-sec">Box</div>${boxes.join('')}
        <div class="pmap-sec">Externe</div>
        <button class="pmap-tile ext${map[t] === EXT_SLOT ? ' sel' : ''}" data-s="${EXT_SLOT}" title="Bobine sur le support externe"><b>Ext</b><span>${esc(filType(t) || '')}</span></button>`;
      document.body.append(pop);   // hors de la fenêtre : elle ne coupe pas le menu
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - 6 - pop.offsetHeight) : r.bottom + 6) + 'px';
      pop.querySelectorAll('[data-s]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); map[t] = +b.dataset.s; closePop(); render(); });
    };
    const outside = (e) => { if (pop && !pop.contains(e.target)) closePop(); };
    document.addEventListener('mousedown', outside, true);

    render();
    const m = modal(start ? 'Lancer l\'impression' : queue ? 'Ajouter à la file d\'attente' : 'Envoyer à l\'imprimante', wrap);
    let done = false;
    const finish = (v) => { if (done) return; done = true; closePop(); document.removeEventListener('mousedown', outside, true); m.close(); resolve(v); };
    wrap.querySelectorAll('[data-r]').forEach((b) => b.onclick = () => finish(b.dataset.r === '1'
      ? { map: pick ? map : {}, relays: Object.entries(relays).filter(([, r]) => r.on).map(([m, r]) => ({ source: +m, slot: r.c })) } : null));
    document.getElementById('modal-close').addEventListener('click', () => finish(null), { once: true });
  });
}

async function sendToPrinter(start, queue = false) {
  const st = lastStatus();
  const state = st?.status?.print_stats?.state;
  if (start && (state === 'printing' || state === 'paused')) { toast('Une impression est déjà en cours', 'err'); return; }
  const used = S.gcodeData.toolsUsed.filter((t) => t < 16);
  const fileName = $('act-name')?.value || '';
  const choice = await printDialog(start, queue, used, st?.box);
  if (!choice) return;
  const mapping = choice.map;
  busy('Envoi à l\'imprimante…');
  try {
    for (const r of choice.relays) {
      busy(`Activation du relais ${slotLabel(r.source)} → ${slotLabel(r.slot)}…`);
      await api(`/api/box/slots/${r.slot}/relay`, { json: { source: r.source } });
      S.relayOf[r.slot] = r.source;
    }
    busy('Envoi à l\'imprimante…');
    const name = fileName.trim() || defaultSendName();
    const thumbs = plate.thumbnails([[32, 32], [300, 300]]);
    const res = await api(`/slicer/api/jobs/${S.job.id}/print`, { json: { start, queue, thumbnails: thumbs, filename: name + '.gcode', mapping } });
    toast(start ? `Impression lancée : ${res.filename}` : queue ? `Ajouté à la file d'attente : ${res.filename}` : `Fichier envoyé : ${res.filename}`);
    if (start) showTab('device');
  } catch (e) { toast(e.message, 'err', 8000); }
  busy(false);
}

// ---------- projets ----------
// ---------- ouverture d'un projet .3mf (Orca / QIDI Studio / Bambu Studio) ----------
function plateOffset(idx, count, w, d) {
  // Orca range les plateaux en grille (colonnes = ceil(sqrt(n))) avec un écart de 20 %
  const cols = Math.ceil(Math.sqrt(count)), col = idx % cols, row = Math.floor(idx / cols);
  return [col * 1.2 * w, -row * 1.2 * d];
}

async function openProject3mf(file) {
  busy(`Lecture du projet ${file.name}…`);
  let d;
  try {
    const fd = new FormData(); fd.append('file', file);
    d = await api('/slicer/api/import-project', { method: 'POST', body: fd });
  } catch (e) { busy(false); toast(e.message, 'err', 8000); return; }
  if (!d.objects.length) { busy(false); toast('Ce projet est vide'); return; }
  busy('Ouverture du projet…');
  try {
    plate.clear();
    S.jobs = {};
    const warn = [];
    // process : on garde celui du projet s'il existe pour cette imprimante, sinon on garde l'actuel
    const procName = S.processes.some((p) => p.name === d.source_process) ? d.source_process : S.process;
    if (procName !== d.source_process) warn.push(`profil de process « ${d.source_process} » absent pour cette imprimante : « ${S.process} » conservé`);
    const known = (k) => !!optDef(k);
    const pov = Object.fromEntries(Object.entries(d.overrides.process || {}).filter(([k]) => known(k)));
    S.ov.process = pov;
    await setProcess(procName, true);
    // filaments du projet
    const po = d.project_opts || {};
    const fils = [];
    const names = d.source_filaments.length ? d.source_filaments : [S.filaments[0]?.profile];
    names.forEach((n, i) => {
      const base = String(n).split('@')[0].trim();
      let prof = S.filamentChoices.find((f) => f.name === n) || S.filamentChoices.find((f) => f.name.split('@')[0].trim() === base);
      if (!prof) { prof = matchFilament({ vendor: 'generic', filament: '', type: (d.source_types || [])[i] || '' }); if (prof) warn.push(`filament « ${n} » remplacé par « ${prof.name} »`); }
      fils.push({ profile: (prof || S.filamentChoices[0]).name, colour: (d.source_colours[i] || '#808080').toUpperCase() });
    });
    const im = (po.filament_is_mixed || []);
    fils.forEach((f, i) => {
      if (!['1', 'true', true, 1].includes(im[i])) return;
      const comps = String((po.filament_mixed_components || [])[i] || '').split(',').map(Number).filter((x) => x > 0);
      const rr = String((po.filament_mixed_sublayer_ratios || [])[i] || '').split(',').map(Number).filter((x) => x > 0);
      const grad = ['1', 'true', true, 1].includes((po.filament_mixed_gradient || [])[i]);
      const range = String((po.filament_mixed_gradient_range || [])[i] || '').split(',').map(Number);
      if (comps.length >= 2) f.mixed = { components: comps, ratios: rr.length === comps.length ? rr.map((x) => Math.round(x * 100)) : comps.map(() => Math.round(100 / comps.length)),
        gradient: grad, dir: range.length === 2 && range[0] > range[1] ? 0 : 1, perPart: ['1', 'true', true, 1].includes((po.filament_mixed_gradient_per_part || [])[i]) };
    });
    S.filaments = fils;
    S.ov.filament = fils.map((_, i) => Object.fromEntries(Object.entries((d.overrides.filament || [])[i] || {}).filter(([k]) => known(k))));
    S.flush = Array.isArray(po.flush_volumes_matrix) && po.flush_volumes_matrix.length === fils.length * fils.length ? po.flush_volumes_matrix.map(String) : null;
    S.flushMult = Array.isArray(po.flush_multiplier) && po.flush_multiplier.length ? String(po.flush_multiplier[0]) : null;
    S.layerGcodes = d.layer_gcodes || {};
    S.wipeTower = Array.isArray(po.wipe_tower_x) ? po.wipe_tower_x.map((x, i) => [+x, +((po.wipe_tower_y || [])[i] ?? 0)]) : [];
    await Promise.all(fils.map((f) => resolveProfile('filament', f.profile)));
    renderFilaments();
    if (d.bed_type && optDef('curr_bed_type')?.enum?.includes(d.bed_type)) { S.bedType = d.bed_type; $('sel-bed').value = S.bedType; }
    bedTypeWarning();
    // plateaux : chaque objet est replacé sur son plateau, dans la grille de cette imprimante
    const np = Math.max(1, d.plates.length);
    plate.setPlates(np, d.plates.map((p) => p.name || ''), 0);
    S.plateSettings = Object.fromEntries(d.plates.map((p, i) => [i, p.settings || {}]).filter(([, v]) => Object.keys(v).length));
    const plateOf = new Map();
    d.plates.forEach((p, i) => p.objects.forEach((g) => plateOf.set(g, i)));
    const W = d.source_bed_width, D = d.source_bed_depth || d.source_bed_width;
    const toFix = new Set();
    for (const o of d.objects) {
      const m = [...o.matrix];
      const pi = plateOf.has(o.gid) ? plateOf.get(o.gid) : (np === 1 ? 0 : -1);
      if (pi >= 0 && W) {
        const [sx, sy] = plateOffset(pi, np, W, D), [tx, ty] = plate.plateOrigin(pi);
        m[12] += tx - sx; m[13] += ty - sy;
      }
      const obj = await plate.addObject({ ...o, matrix: m, parts: o.parts.map((p) => ({ ...p })) });
      if (pi >= 0 && (obj.outside || obj.plate !== pi)) {
        // hors du plateau de cette imprimante : ramené au centre de son plateau puis disposé automatiquement
        const pb = plate.plateBox(pi);
        obj.group.position.x = pb.cx; obj.group.position.y = pb.cy;
        plate._afterTransform(obj, true);
        toFix.add(pi);
      }
    }
    for (const pi of toFix) { plate.setCurrent(pi, true); plate.arrange(); }
    if (toFix.size) warn.push('objets hors du plateau de cette imprimante : disposition automatique');
    plate.setCurrent(0, true); plate.setPlates(np, null, 0);
    plate.view('iso');
    if (d.objects.some((o) => o.multi_part)) warn.push('objet à plusieurs pièces : les pièces sont fusionnées (un seul extrudeur par objet)');
    S.projectName = file.name.replace(/(\.gcode)?\.3mf$/i, '');
    showJob(); renderObjectList(); renderPanel(); saveLocal();
    toast(`Projet ouvert : ${d.objects.length} objet(s), ${np} plateau(x), ${fils.length} filament(s)`, '', 5000);
    if (warn.length) toast(warn.join(' · '), 'warn', 12000);
  } catch (e) { toast('Ouverture du projet : ' + e.message, 'err', 8000); }
  busy(false);
}

// ---------- enregistrement du projet en .3mf (sans découpe) ----------
async function saveProject3mf() {
  if (!plate.objects.length) { toast('Le projet est vide'); return; }
  const all = plate.serialize();
  const name = S.projectName || plate.objects[0].name.replace(/\.[^.]+$/, '') || 'projet';
  const body = {
    ...sliceBody(all, plateLabel(0)), name,
    plates: Array.from({ length: plate.plateCount }, (_, i) => ({ name: plate.plateNames[i] || '', objects: all.map((o, k) => (o.plate === i ? k : -1)).filter((k) => k >= 0), settings: S.plateSettings[i] || {} })),
    modified: { process: Object.keys(S.ov.process), machine: Object.keys(S.ov.machine), filament: S.filaments.map((_, i) => Object.keys(S.ov.filament[i] || {})) },
  };
  busy('Enregistrement du projet…');
  try {
    const r = await fetch('/slicer/api/project3mf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { let m = r.statusText; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name + '.3mf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Projet enregistré : ${name}.3mf`);
  } catch (e) { toast('Enregistrement impossible : ' + e.message, 'err', 8000); }
  busy(false);
}

// ---------- gestion des profils : comparer, importer, exporter, supprimer ----------
const KIND_LABEL = { process: 'Process', filament: 'Filament', machine: 'Imprimante' };

async function profilesModal(kind = 'process') {
  const wrap = document.createElement('div');
  const md = modal('Profils', wrap);
  const reloadLists = async () => {
    if (kind === 'process') { S.processes = await api('/slicer/api/profiles/processes?machine=' + encodeURIComponent(S.machine)); $('sel-process').innerHTML = groupOptions(S.processes, (p) => p.vendor === 'Utilisateur' ? 'Utilisateur' : 'Système'); $('sel-process').value = S.process; markProcessModified(); }
    else if (kind === 'filament') { S.filamentChoices = await api('/slicer/api/profiles/filaments?machine=' + encodeURIComponent(S.machine)); renderFilaments(); }
    else { S.machines = await api('/slicer/api/profiles/machines'); fillMachineSelect(); $('sel-machine').value = S.machine; }
  };
  const render = () => {
    const list = kind === 'process' ? S.processes : kind === 'filament' ? S.filamentChoices : S.machines;
    const users = list.filter((p) => p.user || p.vendor === 'Utilisateur');
    const inUse = kind === 'process' ? [S.process] : kind === 'filament' ? S.filaments.map((f) => f.profile) : [S.machine];
    const cur = inUse[0];
    const opts = (sel) => list.map((p) => `<option ${p.name === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    wrap.innerHTML = `<div class="seg" style="margin-bottom:10px">${Object.entries(KIND_LABEL).map(([k, l]) => `<button data-kind="${k}" class="${k === kind ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="panel-title">Profils utilisateur <span class="actions"><button class="btn small" data-import>Importer un préréglage Orca (.json)…</button></span></div>
      <div class="list-pick" style="margin-bottom:14px">${users.map((u) => `<div class="row gap" style="margin-bottom:4px"><span style="flex:1">${esc(u.name)} <span class="muted small">${u.inherits ? '← ' + esc(u.inherits) : ''}</span></span>
        <a class="btn small" href="/slicer/api/profiles/${kind}/export?name=${encodeURIComponent(u.name)}">Exporter</a>
        <button class="btn small" data-del="${esc(u.name)}" ${inUse.includes(u.name) ? 'disabled title="Profil en cours d\'utilisation"' : ''}>Supprimer</button></div>`).join('') || '<p class="muted small">Aucun profil utilisateur de ce type. Utilise 💾 pour en créer un à partir des réglages en cours.</p>'}</div>
      <div class="panel-title">Comparer deux profils</div>
      <div class="row gap" style="margin-bottom:8px"><select data-a style="flex:1">${opts(cur)}</select><span>↔</span><select data-b style="flex:1">${opts(cur)}</select><button class="btn" data-cmp>Comparer</button></div>
      <div data-out style="max-height:42vh;overflow:auto"></div><input type="file" accept=".json" class="hidden" data-file>`;
    wrap.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => { kind = b.dataset.kind; render(); });
    wrap.querySelector('[data-import]').onclick = () => wrap.querySelector('[data-file]').click();
    wrap.querySelector('[data-file]').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const fd = new FormData(); fd.append('file', f);
        const r = await api(`/slicer/api/profiles/${kind}/import`, { method: 'POST', body: fd });
        toast('Profil importé : ' + r.name); delete S.resolved[kind][r.name]; await reloadLists(); render();
      } catch (err) { toast('Import impossible : ' + err.message, 'err', 8000); }
    };
    wrap.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!await confirm2('Supprimer le profil', `Supprimer le profil utilisateur « ${esc(b.dataset.del)} » ?`, 'Supprimer', true)) { profilesModal(kind); return; }
      try { await api(`/slicer/api/profiles/${kind}?name=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); delete S.resolved[kind][b.dataset.del]; await reloadLists(); toast('Profil supprimé'); }
      catch (err) { toast(err.message, 'err'); }
      profilesModal(kind);
    });
    wrap.querySelector('[data-cmp]').onclick = async () => {
      const a = wrap.querySelector('[data-a]').value, b = wrap.querySelector('[data-b]').value, out = wrap.querySelector('[data-out]');
      if (a === b) { out.innerHTML = '<p class="muted">Choisis deux profils différents.</p>'; return; }
      out.innerHTML = '<p class="muted">Comparaison…</p>';
      try {
        const r = await api(`/slicer/api/profiles/${kind}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        const val = (v) => (v === undefined || v === null ? '<span class="muted">—</span>' : esc(Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 300));
        const lab = (k) => { const d = optDef(k); return d ? esc(d.full_label && d.label && d.label.length < 14 ? d.full_label : (d.label || d.full_label || k)) : esc(k); };
        out.innerHTML = r.diff.length ? `<p class="muted small">${r.diff.length} réglage(s) différent(s)</p><table class="cmp"><tr><th>Réglage</th><th>${esc(a)}</th><th>${esc(b)}</th></tr>
          ${r.diff.map((x) => `<tr><td>${lab(x.key)}<br><code class="muted small">${esc(x.key)}</code></td><td class="v">${val(x.a)}</td><td class="v">${val(x.b)}</td></tr>`).join('')}</table>`
          : '<p class="muted">Ces deux profils sont identiques.</p>';
      } catch (err) { out.innerHTML = `<p style="color:var(--err)">${esc(err.message)}</p>`; }
    };
  };
  render();
  return md;
}

// ---------- réglages modifiés (projet, filaments, objets, pièces) ----------
function modifiedModal() {
  const wrap = document.createElement('div');
  const md = modal('Réglages modifiés', wrap);
  const lab = (k) => { const d = optDef(k); return d ? esc(d.full_label && d.label && d.label.length < 14 ? d.full_label : (d.label || d.full_label || k)) : esc(k); };
  const val = (v) => esc(Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 200);
  const render = () => {
    const groups = [];
    const add = (title, store, base, after) => { if (Object.keys(store || {}).length) groups.push({ title, store, base, after }); };
    add(`Process — ${S.process}`, S.ov.process, (k) => (S.resolved.process[S.process] || {})[k], () => { renderPanel(); });
    S.filaments.forEach((f, i) => add(`Filament ${i + 1} — ${f.profile}`, S.ov.filament[i], (k) => (S.resolved.filament[f.profile] || {})[k], () => { bedTypeWarning(); }));
    add(`Imprimante — ${S.machine}`, S.ov.machine, (k) => (S.resolved.machine[S.machine] || {})[k], () => {});
    for (const o of plate.objects) {
      add(`Objet — ${o.name}`, o.settings, (k) => effective('process', k), () => { renderObjectList(); renderPanel(); });
      for (const pt of o.parts) add(`Pièce — ${o.name} › ${pt.name}`, pt.settings, (k) => effective('process', k), () => { renderObjectList(); renderPanel(); });
    }
    wrap.innerHTML = groups.length ? groups.map((g, gi) => `<div class="panel-title" style="margin-top:8px">${esc(g.title)} <span class="actions"><button class="btn small" data-reset-all="${gi}">Tout rétablir</button></span></div>
      <table class="cmp"><tr><th>Réglage</th><th>Profil</th><th>Valeur modifiée</th><th></th></tr>${Object.entries(g.store).map(([k, v]) => `<tr><td>${lab(k)}<br><code class="muted small">${esc(k)}</code></td>
        <td class="v">${g.base(k) === undefined ? '<span class="muted">—</span>' : val(g.base(k))}</td><td class="v">${val(v)}</td><td><button class="icon" data-reset="${gi}:${esc(k)}" title="Rétablir la valeur du profil">↺</button></td></tr>`).join('')}</table>`).join('')
      : '<p class="muted">Aucun réglage modifié : tout correspond aux profils sélectionnés.</p>';
    wrap.querySelectorAll('[data-reset]').forEach((b) => b.onclick = () => { const [gi, k] = [b.dataset.reset.split(':')[0], b.dataset.reset.split(':').slice(1).join(':')]; const g = groups[+gi]; delete g.store[k]; g.after(); saveLocal(); render(); });
    wrap.querySelectorAll('[data-reset-all]').forEach((b) => b.onclick = () => { const g = groups[+b.dataset.resetAll]; for (const k of Object.keys(g.store)) delete g.store[k]; g.after(); saveLocal(); render(); });
  };
  render();
  return md;
}

async function projectAction(act) {
  if (act === 'open3mf') { $('file-3mf').click(); return; }
  if (act === 'save3mf') { saveProject3mf(); return; }
  if (act === 'calib') { calibModal(); return; }
  if (act === 'lang') { setLang(lang() === 'en' ? 'fr' : 'en'); return; }
  if (act === 'stl') { exportStl(false); return; }
  if (act === 'stlall') { exportStl(true); return; }
  if (act === 'new') {
    if (plate.objects.length && !await confirm2('Nouveau projet', 'Vider le projet actuel (tous les plateaux) ?', 'Vider')) return;
    plate.clear(); plate.setPlates(1, ['']); S.jobs = {}; S.wipeTower = []; S.layerGcodes = {}; S.calibPost = null; S.flush = null; S.flushMult = null; showJob(); S.projectName = null; S.ov.process = {}; renderPanel(); saveLocal();
  } else if (act === 'save' || act === 'saveas') {
    let name = S.projectName;
    if (act === 'saveas' || !name) name = await prompt2('Enregistrer le projet', 'Nom du projet (partagé avec tous les utilisateurs)', name || plate.objects[0]?.name?.replace(/\.[^.]+$/, '') || 'Projet');
    if (!name) return;
    try { await api('/slicer/api/projects/' + encodeURIComponent(name), { method: 'PUT', json: snapshot() }); S.projectName = name; toast('Projet enregistré : ' + name); }
    catch (e) { toast(e.message, 'err'); }
  } else if (act === 'open') {
    const list = await api('/slicer/api/projects');
    const wrap = document.createElement('div');
    wrap.className = 'list-pick';
    wrap.innerHTML = list.map((p) => `<div class="row gap"><button class="btn" style="flex:1" data-open="${esc(p.name)}">${esc(p.name)} <span class="muted small">— ${new Date(p.modified * 1000).toLocaleString('fr-FR')}</span></button>
      <button class="icon" data-del="${esc(p.name)}" title="Supprimer">${icon('trash', 15)}</button></div>`).join('') || '<p class="muted">Aucun projet enregistré.</p>';
    const md = modal('Ouvrir un projet', wrap);
    wrap.querySelectorAll('[data-open]').forEach((b) => b.onclick = async () => {
      md.close(); busy('Ouverture…');
      try {
        const data = await api('/slicer/api/projects/' + encodeURIComponent(b.dataset.open));
        plate.clear();
        await setMachine(data.machine, data);
        await restoreObjects(data.objects || [], data.plates);
        S.projectName = b.dataset.open;
        saveLocal();
      } catch (e) { toast(e.message, 'err'); }
      busy(false);
    });
    wrap.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!await confirm2('Supprimer', `Supprimer le projet ${esc(b.dataset.del)} ?`, 'Supprimer', true)) return;
      await api('/slicer/api/projects/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
      b.parentElement.remove();
    });
  } else if (act === 'export3mf') {
    if (S.job) location.href = `/slicer/api/jobs/${S.job.id}/project`;
    else toast('Découpe d\'abord le plateau pour exporter le projet 3MF');
  } else if (act === 'logout') {
    await api('/api/logout', { method: 'POST' }); location.href = '/login';
  }
}

// ---------- raccourcis clavier ----------
const KEYS = [
  ['Projet', [['Ctrl+N', 'Nouveau projet'], ['Ctrl+O', 'Ouvrir un projet'], ['Ctrl+S', 'Enregistrer le projet (.3mf)'], ['Ctrl+Maj+S', 'Enregistrer sous'],
    ['Ctrl+I', 'Importer des modèles (STL, 3MF, OBJ, STEP…)']]],
  ['Découpe et impression', [['Ctrl+R', 'Découper le plateau'], ['Ctrl+G', 'Exporter le G-code du plateau'], ['Ctrl+Maj+G', 'Imprimer le plateau (avec confirmation)']]],
  ['Édition', [['Ctrl+Z', 'Annuler'], ['Ctrl+Y / Ctrl+Maj+Z', 'Rétablir'], ['Ctrl+A', 'Tout sélectionner (plateau courant)'], ['Ctrl+Maj+A', 'Tout sélectionner (tous les plateaux)'],
    ['Ctrl+C / Ctrl+X / Ctrl+V', 'Copier / couper / coller'], ['Suppr', 'Supprimer la sélection'], ['Ctrl+D', 'Tout supprimer'], ['Ctrl+K ou +', 'Cloner la sélection'],
    ['−', 'Retirer un clone'], ['1 à 9', 'Filament de l\'objet sélectionné'], ['Échap', 'Tout désélectionner / quitter l\'outil']]],
  ['Placement', [['A', 'Disposer tous les objets'], ['Maj+A', 'Disposer le plateau courant'], ['Q', 'Orienter la sélection (ou tout)'], ['Maj+Q', 'Orienter le plateau courant'],
    ['← → ↑ ↓', 'Déplacer la sélection de 10 mm (Maj : 1 mm)'], ['Page ↑ / Page ↓', 'Pivoter de 45° (sens antihoraire / horaire)']]],
  ['Outils', [['M', 'Déplacer'], ['R', 'Pivoter'], ['S', 'Mettre à l\'échelle'], ['F', 'Poser sur une face'], ['C', 'Couper'], ['T', 'Texte'], ['U', 'Mesurer'], ['E', 'Oreilles de bordure'], ['B', 'Booléen'], ['Y', 'Assemblage'], ['D', 'Texture en relief'],
    ['L', 'Peindre les supports'], ['P', 'Peindre la couture'], ['N', 'Peindre les couleurs'], ['H', 'Peindre le fuzzy skin']]],
  ['Peinture', [['S / F', 'Pinceau / remplissage'], ['Ctrl+molette', 'Rayon du pinceau'], ['Maj+clic', 'Effacer'], ['Échap', 'Quitter la peinture']]],
  ['Vue', [['Ctrl+0', 'Vue par défaut'], ['Ctrl+1 … Ctrl+6', 'Dessus, dessous, face, arrière, gauche, droite'], ['Ctrl+7', 'Plateau courant'], ['I / O', 'Zoom avant / arrière'],
    ['Tab', 'Passer de Préparer à Aperçu'], ['Maj+Tab', 'Replier / déplier le panneau latéral'], ['Ctrl+F', 'Chercher un réglage'], ['?', 'Cette liste']]],
  ['Aperçu', [['↑ / ↓', 'Couche suivante / précédente (Maj+Ctrl : ×5)'], ['← / →', 'Mouvement précédent / suivant (Maj+Ctrl : ×5)'], ['Début / Fin', 'Premier / dernier mouvement'],
    ['L', 'Mode une seule couche'], ['Maj+G', 'Aller à la couche…'], ['Espace', 'Lecture animée']]],
];

// ---------- raccourcis personnalisables (comme les préférences de raccourcis d'Orca) ----------
// carte { raccourci d'origine : raccourci choisi }, ex. { "D": "X", "Ctrl+R": "Ctrl+Maj+R" } ; seuls les raccourcis d'une touche
// (avec Ctrl / Maj éventuels) se réaffectent
const KEYMAP_KEY = 'slicer-keymap';
let KEYMAP = {};
try { KEYMAP = JSON.parse(localStorage.getItem(KEYMAP_KEY) || '{}') || {}; } catch { KEYMAP = {}; }
const remappable = (k) => /^(Ctrl\+)?(Maj\+)?[A-Z0-9]$/.test(k);
const comboOf = (e) => {
  const k = e.key.length === 1 ? e.key.toUpperCase() : null;
  return k && /^[A-Z0-9]$/.test(k) ? `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Maj+' : ''}${k}` : null;
};
function onKeyMapped(e) {
  const combo = comboOf(e);
  if (combo && Object.keys(KEYMAP).length) {
    const orig = Object.keys(KEYMAP).find((d) => KEYMAP[d] === combo);
    if (orig) {
      const m = /^(Ctrl\+)?(Maj\+)?(.)$/.exec(orig);
      return onKey({ key: m[3].toLowerCase(), ctrlKey: !!m[1], metaKey: false, shiftKey: !!m[2], preventDefault: () => e.preventDefault() });
    }
    if (KEYMAP[combo]) return;          // raccourci d'origine réaffecté ailleurs : désactivé
  }
  return onKey(e);
}

function shortcutsModal() {
  const w = document.createElement('div');
  const draw = () => {
    w.innerHTML = '<div class="keys-help">' + KEYS.map(([sec, rows]) => `<section><h4>${sec}</h4>${rows.map(([k, l]) => {
      const cur = KEYMAP[k];
      const shown = (cur || k).split(/ (?:\/|ou|…) /).map((x) => `<kbd class="${cur ? 'custom' : ''}">${esc(x)}</kbd>`).join(' ');
      return `<div class="key-row"><span>${l}</span><span>${shown}${remappable(k) ? ` <button class="icon small" data-remap="${esc(k)}" title="Changer ce raccourci">✎</button>` : ''}</span></div>`;
    }).join('')}</section>`).join('') + '</div>'
      + `<p class="muted small">Mêmes raccourcis qu'OrcaSlicer 2.5 ; ✎ pour en changer un (mémorisé dans ce navigateur). Sur Mac, Cmd remplace Ctrl.
         ${Object.keys(KEYMAP).length ? '<button class="btn small" data-reset>Rétablir les raccourcis d\'Orca</button>' : ''}</p>`;
    w.querySelectorAll('[data-remap]').forEach((b) => b.onclick = () => {
      const orig = b.dataset.remap;
      b.textContent = 'appuie…';
      const cap = (e) => {
        e.preventDefault(); e.stopPropagation();
        document.removeEventListener('keydown', cap, true);
        if (e.key === 'Escape') { draw(); return; }
        const c = comboOf(e);
        if (!c) { toast('Choisis une lettre ou un chiffre (avec Ctrl / Maj si tu veux)', 'warn'); draw(); return; }
        const taken = KEYS.flatMap(([, r]) => r).find(([k]) => k !== orig && (KEYMAP[k] || k) === c);
        if (taken) toast(`« ${c} » servait déjà à « ${taken[1]} » : ce raccourci-là est désactivé`, 'warn', 6000);
        if (c === orig) delete KEYMAP[orig]; else KEYMAP[orig] = c;
        try { localStorage.setItem(KEYMAP_KEY, JSON.stringify(KEYMAP)); } catch { /* stockage indisponible */ }
        draw();
      };
      document.addEventListener('keydown', cap, true);
    });
    w.querySelector('[data-reset]')?.addEventListener('click', () => { KEYMAP = {}; try { localStorage.removeItem(KEYMAP_KEY); } catch { /* idem */ } draw(); });
  };
  draw();
  modal('Raccourcis clavier', w);
}

function zoomView(f, v = plate) {
  const c = v.controls, cam = v.camera;
  cam.position.sub(c.target).multiplyScalar(f).add(c.target);
  c.update();
}

function stepSlider(el, d) {
  if (!el || el.closest('.hidden')) return;
  el.value = Math.min(+el.max, Math.max(+el.min, +el.value + d));
  el.oninput?.();
}

async function dropProject(f) {
  const w = document.createElement('div');
  w.innerHTML = `<p class="muted small">« ${esc(f.name)} » : ouvrir le projet complet (plateaux, réglages, filaments) ou seulement importer sa géométrie dans le projet actuel ?</p>
    <div class="row gap" style="justify-content:flex-end"><button class="btn" data-k="geo">Géométrie seule</button><button class="btn primary" data-k="proj">Ouvrir comme projet</button></div>`;
  const md = modal('Fichier 3MF', w);
  w.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => { md.close(); if (b.dataset.k === 'proj') openProject3mf(f); else importFiles([f]); });
}

function onKey(e) {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (!$('modal').classList.contains('hidden') && e.key !== 'Escape') return;
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const prep = $('tab-prepare').classList.contains('active'), prev = $('tab-preview').classList.contains('active');
  const go = (fn) => { e.preventDefault(); fn(); };
  // global
  if (ctrl && k === 'n') return go(() => projectAction('new'));
  if (ctrl && k === 'o') return go(() => $('file-3mf').click());
  if (ctrl && k === 's') return go(() => (e.shiftKey ? projectAction('saveas') : saveProject3mf()));
  if (ctrl && k === 'i') return go(() => $('t-add').click());
  if (ctrl && k === 'r' && !e.shiftKey) return go(() => slice());
  if (ctrl && k === 'g') return go(() => {
    if (!S.job) { toast('Découpe d\'abord le plateau (Ctrl+R)'); return; }
    if (e.shiftKey) { showTab('preview'); sendToPrinter(true); } else location.href = `/slicer/api/jobs/${S.job.id}/gcode?download=true`;
  });
  if (ctrl && k === 'f') return go(() => { showTab('prepare'); $('opt-search').focus(); });
  if (ctrl && /^[0-7]$/.test(k)) return go(() => { const v = ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso'][+k]; (prev ? preview : plate).view?.(v); });
  if (k === '?') return go(shortcutsModal);
  if (k === 'Tab' && !ctrl) return go(() => {
    if (e.shiftKey) { $('sidebar').classList.toggle('collapsed'); plate.resize(); return; }
    showTab(prep ? 'preview' : 'prepare');
  });
  if (prev) {
    const top = $('layer-top'), mv = $('move-slider'), f = e.shiftKey && ctrl ? 5 : 1;
    if (k === ' ') return go(togglePlay);
    if (k === 'ArrowUp') return go(() => { stepSlider(top, f); if ($('layer-bottom').dataset.one) { $('layer-bottom').value = top.value; $('layer-bottom').oninput(); } });
    if (k === 'ArrowDown') return go(() => { stepSlider(top, -f); if ($('layer-bottom').dataset.one) { $('layer-bottom').value = top.value; $('layer-bottom').oninput(); } });
    if (k === 'ArrowRight') return go(() => stepSlider(mv, f));
    if (k === 'ArrowLeft') return go(() => stepSlider(mv, -f));
    if (k === 'Home') return go(() => { mv.value = 0; mv.oninput?.(); });
    if (k === 'End') return go(() => { mv.value = mv.max; mv.oninput?.(); });
    if (k === 'l' && !ctrl) return go(() => {
      const b = $('layer-bottom'); const on = !b.dataset.one;
      if (on) { b.dataset.one = '1'; b.value = top.value; } else { delete b.dataset.one; b.value = 0; }
      b.oninput?.(); toast(on ? 'Mode une seule couche' : 'Toutes les couches');
    });
    if (k === 'g' && e.shiftKey && !ctrl) return go(async () => {
      const d = S.gcodeData; if (!d) return;
      const v = await prompt2('Aller à la couche', `Numéro de couche (1 à ${d.layers.length})`, String(+top.value + 1));
      if (v && +v >= 1) { top.value = Math.min(d.layers.length, +v) - 1; top.oninput(); }
    });
    if (k === 'i') return go(() => zoomView(0.85, preview));
    if (k === 'o') return go(() => zoomView(1 / 0.85, preview));
    return;
  }
  if (!prep) return;
  // préparer
  if (ctrl && (k === 'z' && !e.shiftKey)) return go(() => undoRedo(-1));
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) return go(() => undoRedo(1));
  if (ctrl && k === 'a') return go(() => selectAll(e.shiftKey));
  if (ctrl && k === 'c') return go(() => copySelection(false));
  if (ctrl && k === 'x') return go(() => copySelection(true));
  if (ctrl && k === 'v') return go(pasteClipboard);
  if (ctrl && k === 'k') return go(() => $('t-dup').click());
  if (ctrl && k === 'd') return go(async () => {
    if (!plate.objects.length) return;
    plate.clear(); S.multi.clear(); saveLocal(); toast('Tous les objets supprimés (Ctrl+Z pour annuler)');
  });
  if (ctrl) return;
  if (k === 'Escape') {
    if (plate.picking) { const cb = plate.picking; plate.picking = null; cb(null); }
    if (PAINT.active) { paintToggle(false); return; }
    if (plate.measuring) { plate.startMeasure(false); $('t-measure').classList.remove('active'); }
    if (BRIM.active) { brimToggle(false); return; }
    S.multi.clear(); plate.select(null); renderObjectList(); return;
  }
  if (PAINT.active) {
    if (k === 's' || k === 'f') { PAINT.tool = k === 's' ? 'brush' : 'fill'; plate.setPaint({ ...PAINT }); renderPaintPanel(); }
    return;
  }
  if (k === 'Delete' || k === 'Backspace') return go(removeSelection);
  if (k === '+' || k === '=') return go(() => $('t-dup').click());
  if (k === '-') return go(() => {
    const o = plate.selected; if (!o) return;
    const twin = [...plate.objects].reverse().find((x) => x !== o && x.model_id === o.model_id && x.index === o.index);
    if (twin) { plate.remove(twin); saveLocal(); }
  });
  if (/^[1-9]$/.test(k)) return go(() => {
    const n = +k; if (n > S.filaments.length) { toast(`Pas de filament n° ${n}`); return; }
    for (const o of selection()) o.extruder = n;
    plate.refreshColours(); renderObjectList(); saveLocal();
  });
  const step = e.shiftKey ? 1 : 10;
  if (k === 'ArrowLeft') return go(() => nudgeSelection(-step, 0));
  if (k === 'ArrowRight') return go(() => nudgeSelection(step, 0));
  if (k === 'ArrowUp') return go(() => nudgeSelection(0, step));
  if (k === 'ArrowDown') return go(() => nudgeSelection(0, -step));
  if (k === 'PageUp') return go(() => nudgeSelection(0, 0, 45));
  if (k === 'PageDown') return go(() => nudgeSelection(0, 0, -45));
  if (k === 'a') return go(doArrange);   // Orca : A = tous les objets, Maj+A = plateau sélectionné ; ici la disposition agit sur le plateau courant
  if (k === 'q') return go(() => { if (e.shiftKey) plate.select(null); orientAction(); });
  if (k === 'm') return document.querySelector('[data-mode=translate]').click();
  if (k === 'r') return document.querySelector('[data-mode=rotate]').click();
  if (k === 's') return document.querySelector('[data-mode=scale]').click();
  if (k === 'f') return $('t-layflat').click();
  if (k === 'c') return go(cutModal);
  if (k === 't') return go(textModal);
  if (k === 'u') return $('t-measure').click();
  if (k === 'e') return go(() => brimToggle());
  if (k === 'b') return go(booleanModal);
  if (k === 'y') return go(assemblyModal);
  if (k === 'd') return go(textureModal);
  if (k === 'i') return go(() => zoomView(0.85));
  if (k === 'o') return go(() => zoomView(1 / 0.85));
  const pm = { l: 'supports', p: 'seam', n: 'color', h: 'fuzzy' }[k];
  if (pm) return go(() => { PAINT.mode = pm; paintToggle(true); });
}

// ---------- visite guidée (premier lancement, puis bouton « Aide ») ----------
const TOUR = [
  ['#sel-machine', 'Imprimante', 'Choisis ton imprimante : ses profils, son plateau et ses buses sont ceux d\'OrcaSlicer. Le crayon à côté modifie ses réglages.', 'prepare'],
  ['#filament-list', 'Filaments', 'Un filament par emplacement. « Synchroniser » lit les bobines de la QIDI Box (matière, couleur, marque) ; chaque pastille peut être liée à une bobine de PrintLab.', 'prepare'],
  ['#sel-process', 'Réglages d\'impression', 'Le profil de découpe. Les valeurs modifiées apparaissent en couleur ; le niveau Simple / Avancé / Développeur montre plus ou moins d\'options, comme dans Orca.', 'prepare'],
  ['#toolbar', 'Outils', 'Ajouter des modèles (ou les glisser dans la fenêtre), disposer, pivoter, couper, peindre, texte, mesure… Survole un bouton pour voir son raccourci, et « Raccourcis » pour la liste complète.', 'prepare'],
  ['#objects-panel', 'Objets', 'La liste des objets du plateau : filament de chaque objet, réglages propres à un objet, pièces et modificateurs. Ctrl+clic pour une sélection multiple.', 'prepare'],
  ['#slice-bar', 'Plateaux et découpe', 'Ajoute des plateaux, choisis le plateau courant, puis « Découper » lance le vrai moteur d\'OrcaSlicer sur le serveur.', 'prepare'],
  ['#tabs [data-tab=preview]', 'Aperçu', 'Le G-code découpé couche par couche : vues par type, vitesse, débit, température…, lecture animée, temps et consommation par filament, puis envoi à l\'imprimante.', 'prepare'],
  ['#btn-project', 'Projet', 'Ouvrir / enregistrer un .3mf compatible Orca, projets partagés, et le menu « Calibration… » (température, débit, pressure advance, rétraction…).', 'prepare'],
  ['#t-undo', 'Annuler / rétablir', 'Toute modification peut être annulée (Ctrl+Z) et rétablie (Ctrl+Y), sans limite de nombre.', 'prepare'],
];
function startTour(force = false) {
  try { if (!force && localStorage.getItem('slicer-tour-done')) return; } catch { return; }
  let i = 0;
  const box = document.createElement('div'); box.id = 'tour';
  const hole = document.createElement('div'); hole.id = 'tour-hole';
  document.body.append(hole, box);
  const end = () => { box.remove(); hole.remove(); window.removeEventListener('resize', show); try { localStorage.setItem('slicer-tour-done', '1'); } catch {} };
  const show = () => {
    const [sel, title, text, tab] = TOUR[i];
    if (tab) showTab(tab);
    const el = document.querySelector(sel);
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    if (r) Object.assign(hole.style, { display: 'block', left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px' });
    else hole.style.display = 'none';
    box.innerHTML = `<div class="muted small">${i + 1} / ${TOUR.length}</div><h4>${esc(title)}</h4><p>${esc(text)}</p>
      <div class="row gap" style="justify-content:space-between"><button class="btn small" data-t="end">Passer</button>
      <span class="row gap">${i ? '<button class="btn small" data-t="prev">Précédent</button>' : ''}<button class="btn small primary" data-t="next">${i === TOUR.length - 1 ? 'Terminer' : 'Suivant'}</button></span></div>`;
    const bw = Math.min(340, innerWidth - 32);
    box.style.width = bw + 'px';
    const bh = box.offsetHeight;
    let x = r ? r.left : (innerWidth - bw) / 2, y = r ? r.bottom + 12 : innerHeight / 3;
    if (r && y + bh > innerHeight - 8) y = Math.max(8, r.top - bh - 12);
    if (r && y < 8) { y = Math.min(innerHeight - bh - 8, r.top + 12); x = r.right + 12; }
    box.style.left = Math.max(16, Math.min(x, innerWidth - bw - 16)) + 'px';
    box.style.top = Math.max(8, Math.min(y, innerHeight - bh - 8)) + 'px';
    box.querySelector('[data-t=end]').onclick = end;
    box.querySelector('[data-t=next]').onclick = () => { if (++i >= TOUR.length) end(); else show(); };
    box.querySelector('[data-t=prev]')?.addEventListener('click', () => { i--; show(); });
  };
  window.addEventListener('resize', show);
  show();
}

// ---------- onglets ----------
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  setDeviceActive(name === 'device');
  if (name === 'prepare') plate.resize();
  if (name === 'preview') preview.resize();
}

// ---------- liaisons ----------
function bind() {
  document.querySelectorAll('#tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));
  $('sel-machine').onchange = (e) => { if (e.target.value === '__favs__') { e.target.value = S.machine; favsModal('machine'); return; } S.ov.machine = {}; setMachine(e.target.value); };
  $('sel-process').onchange = (e) => setProcess(e.target.value);
  $('edit-machine').onclick = () => editProfileModal('machine');
  $('save-process').onclick = saveProcessProfile;
  $('add-filament').onclick = () => addFilament();
  $('favs-btn').onclick = () => favsModal('filament');
  $('sync-box').onclick = syncBox;
  $('flush-btn').onclick = flushModal;
  $('opt-search').oninput = (e) => { S.search = e.target.value; renderPanel(); };
  $('scope-seg').querySelectorAll('button').forEach((b) => b.onclick = () => { S.scope = b.dataset.scope; if (S.scope === 'global') S.selectedPart = null; renderPanel(); renderObjectList(); });

  $('t-add').onclick = () => $('file-input').click();
  $('file-3mf').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openProject3mf(f); };
  $('file-input').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
  $('t-del').onclick = () => plate.remove(plate.selected);
  $('t-dup').onclick = () => plate.duplicate(plate.selected).then((c) => c && plate.select(c));
  $('t-arrange').onclick = (e) => { if (e.shiftKey) arrangeModal(); else doArrange(); };
  $('t-arrange').oncontextmenu = (e) => { e.preventDefault(); arrangeModal(); };
  $('t-center').onclick = () => plate.centre(plate.selected);
  $('t-modifier').onclick = addModifierModal;
  $('t-split').onclick = splitAction;
  $('t-bool').onclick = booleanModal;
  $('t-simplify').onclick = simplifyModal;
  $('t-align').onclick = alignModal;
  $('t-assembly').onclick = assemblyModal;
  $('t-texture').onclick = textureModal;
  $('t-ranges').onclick = rangesModal;
  $('t-cut').onclick = cutModal;
  $('t-orient').onclick = orientAction;
  $('t-text').onclick = textModal;
  $('t-paint').onclick = () => paintToggle();
  $('t-brim').onclick = () => brimToggle();
  $('t-svg').onclick = svgModal;
  $('t-measure').onclick = () => {
    const on = !plate.measuring;
    plate.startMeasure(on);
    $('t-measure').classList.toggle('active', on);
    if (on) { plate.select(null); toast('Mesure : clique deux points (sur un objet ou le plateau). Échap pour quitter.', '', 5000); }
  };
  document.querySelectorAll('[data-mirror]').forEach((b) => b.onclick = () => { plate.mirror(plate.selected, +b.dataset.mirror); renderObjectPanel(); saveLocal(); });
  $('obj-layers').onclick = layerModal;
  $('obj-repair').onclick = async () => {
    const o = plate.selected; if (!o) return;
    busy('Réparation du maillage…');
    try {
      const r = await api(`/slicer/api/models/${o.model_id}/repair/${o.index}`, { method: 'POST' });
      await plate.replaceMesh(o, r.meta.id, 0);
      const st = r.stats;
      toast(`Maillage réparé : ${st.welded_vertices} sommet(s) soudé(s), ${st.removed_triangles} triangle(s) retiré(s), ${st.filled_triangles} ajouté(s) pour boucher les trous — ${st.watertight_after ? 'fermé ✓' : 'toujours ouvert ⚠'}`, st.watertight_after ? '' : 'warn', 9000);
      saveLocal(); renderObjectList();
    } catch (e) { toast(e.message, 'err'); }
    busy(false);
  };
  $('t-merge').onclick = mergeAction;
  document.querySelectorAll('.tool.mode').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tool.mode').forEach((x) => x.classList.toggle('active', x === b));
    plate.setMode(b.dataset.mode);
  });
  $('t-layflat').onclick = () => {
    plate.layFlat = !plate.layFlat;
    $('t-layflat').classList.toggle('active', plate.layFlat);
    if (plate.layFlat) toast('Clique sur la face de l\'objet à poser sur le plateau');
  };
  const views = ['iso', 'top', 'front', 'left', 'right', 'back'];
  let vi = 0;
  $('t-view').onclick = () => { vi = (vi + 1) % views.length; plate.view(views[vi]); };
  $('btn-slice').onclick = () => slice();
  $('btn-slice-all').onclick = sliceAll;
  $('tick-add').onclick = addTick;
  window.addEventListener('resize', () => requestAnimationFrame(drawTickMarks));
  $('sel-bed').onchange = (e) => { S.bedType = e.target.value; bedTypeWarning(); saveLocal(); };
  $('level-sel').onchange = (e) => { S.level = +e.target.value; S.advanced = S.level > 0; renderPanel(); saveLocal(); };
  $('profiles-btn').onclick = () => profilesModal('process');
  $('modified-btn').onclick = modifiedModal;

  const pm = $('project-menu');
  $('btn-project').onclick = (e) => { e.stopPropagation(); pm.classList.toggle('open'); };
  document.addEventListener('click', () => pm.classList.remove('open'));
  pm.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => { pm.classList.remove('open'); projectAction(b.dataset.act); });

  $('color-scheme').onchange = (e) => { preview.setScheme(e.target.value); renderLegend(); };
  $('show-travel').onchange = (e) => preview.setTravel(e.target.checked);
  $('show-model').onchange = (e) => { preview.ghostGroup.visible = e.target.checked; };
  document.querySelectorAll('#legend [data-opt]').forEach((c) => c.onchange = () => preview.setOption(c.dataset.opt, c.checked));
  $('play-btn').onclick = togglePlay;

  // glisser-déposer (n'importe où dans la fenêtre, comme Orca) ; un .3mf seul : ouvrir comme projet ou géométrie seule
  const vw = $('viewport-wrap');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); dragDepth++; vw.classList.add('dragover'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; vw.classList.remove('dragover'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; vw.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || e.target.closest?.('#tab-device')) return;
    showTab('prepare');
    if (files.length === 1 && /\.3mf$/i.test(files[0].name)) dropProject(files[0]); else importFiles(files);
  });

  $('t-undo').onclick = () => undoRedo(-1);
  $('t-redo').onclick = () => undoRedo(1);
  $('t-keys').onclick = shortcutsModal;
  $('t-tour').onclick = () => startTour(true);
  $('t-arrange').oncontextmenu = (e) => { e.preventDefault(); arrangeModal(); };

  // raccourcis clavier : liste officielle d'Orca 2.5 (src/slic3r/GUI/Shortcuts.cpp)
  document.addEventListener('keydown', onKeyMapped);
  // Ctrl + molette en mode peinture : rayon du pinceau (Orca)
  $('viewport').addEventListener('wheel', (e) => {
    if (BRIM.active && (e.ctrlKey || e.metaKey)) {   // Ctrl + molette : rayon des oreilles (± 0,1 mm, comme Orca)
      e.preventDefault(); e.stopPropagation();
      BRIM.radius = Math.min(100, Math.max(0.1, +(BRIM.radius + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(1)));
      if (plate.brim) plate.brim.radius = BRIM.radius;
      renderBrimPanel(); return;
    }
    if (!PAINT.active || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); e.stopPropagation();
    PAINT.radius = Math.min(20, Math.max(0.2, +(PAINT.radius * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2)));
    plate.setPaint({ ...PAINT }); renderPaintPanel();
  }, { capture: true, passive: false });
  bindObjectPanel();
  onStatus(() => {});
}

hydrateIcons();
bind();
initDevice();
boot();

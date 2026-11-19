// Éditeur de réglages générique, construit à partir du schéma extrait des sources d'Orca
// (mêmes pages, groupes, libellés, info-bulles et listes de choix que l'application).
import { esc } from './api.js';

let SCHEMA = null;
// Les températures de plateau existent en 5 exemplaires (un par type de plateau) : sans le nom, on ne sait pas laquelle est laquelle.
const PLATE_NAMES = { cool_plate_temp: 'Plateau Cool', textured_cool_plate_temp: 'Plateau Cool texturé', eng_plate_temp: 'Plateau Engineering',
  hot_plate_temp: 'Plateau PEI lisse (haute température)', textured_plate_temp: 'Plateau PEI texturé' };

export function setSchema(s) { SCHEMA = s; }
export function schema() { return SCHEMA; }
export function optDef(key) { return SCHEMA?.options?.[key]; }

const VECTOR_TYPES = new Set(['coFloats', 'coInts', 'coBools', 'coPercents', 'coStrings', 'coEnums', 'coFloatsOrPercents']);
const TEXT_LIST_TYPES = new Set(['coPoints', 'coPointsGroups']);

export function isGcodeKey(key) { return /gcode$|_gcode_|^template_custom_gcode|notes$/.test(key); }

// Valeur "scalaire" éditée pour une option (premier élément pour les vecteurs).
export function scalar(v) {
  if (Array.isArray(v)) return v.length ? v[0] : '';
  return v ?? '';
}

// Applique une valeur scalaire éditée à une valeur de base (vecteur ou non).
export function withScalar(base, val) {
  if (Array.isArray(base)) return base.length > 1 ? base.map(() => val) : [val];
  return val;
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/**
 * Affiche les réglages d'un type de profil.
 * opts: {
 *   kind: 'process' | 'filament' | 'machine',
 *   container, pagesBar (optionnel),
 *   get(key) -> valeur effective, base(key) -> valeur du profil (avant modifications),
 *   set(key, value|undefined)  (undefined = revenir à la valeur du profil),
 *   advanced: bool, search: string, page: index, onPage(i),
 *   only: Set de clés autorisées (ex. réglages par objet)
 * }
 */
export function renderSettings(opts) {
  const { kind, container, pagesBar } = opts;
  const pages = SCHEMA?.tabs?.[kind] || [];
  const search = (opts.search || '').trim().toLowerCase();
  container.innerHTML = '';

  const visible = (key) => {
    const d = optDef(key);
    if (!d) return false;
    if (opts.only && !opts.only.has(key)) return false;
    if (opts.base(key) === undefined && d.default === undefined) return false;
    // niveau : 0 simple, 1 avancé (avancé + expert, comme l'interrupteur d'Orca), 2 développeur (tout)
    const level = opts.level ?? (opts.advanced ? 1 : 0);
    if (d.mode === 'develop' && level < 2) return false;
    if (level < 1 && !search && (d.mode === 'advanced' || d.mode === 'expert')) return false;
    if (search) {
      const hay = `${key} ${d.label || ''} ${d.full_label || ''} ${d.tooltip || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  };

  let pageIdx = opts.page || 0;
  if (pagesBar) {
    pagesBar.innerHTML = '';
    pagesBar.classList.toggle('hidden', !!search);
    pages.forEach((p, i) => {
      const count = p.groups.reduce((n, g) => n + g.options.filter(visible).length, 0);
      if (!count) return;
      const b = document.createElement('button');
      b.textContent = p.title_fr || p.title;
      if (i === pageIdx) b.classList.add('active');
      b.onclick = () => opts.onPage?.(i);
      pagesBar.appendChild(b);
    });
    if (!pagesBar.querySelector('.active') && pagesBar.firstChild) {
      pagesBar.firstChild.click();
      return;
    }
  }

  const shownPages = search ? pages : [pages[pageIdx]].filter(Boolean);
  let any = false;
  const seen = new Set();
  for (const page of shownPages) {
    for (const g of page.groups) {
      const keys = g.options.filter((k) => !seen.has(k) && visible(k));
      if (!keys.length) continue;
      keys.forEach((k) => seen.add(k));
      any = true;
      const gEl = document.createElement('div');
      gEl.className = 'group';
      gEl.innerHTML = `<div class="group-title">${esc(search ? `${page.title_fr} › ${g.title_fr || g.title}` : (g.title_fr || g.title))}</div>`;
      for (const key of keys) gEl.appendChild(optionRow(key, opts));
      container.appendChild(gEl);
    }
  }
  if (!any) container.innerHTML = `<p class="muted" style="padding:10px 0">${search ? 'Aucun réglage ne correspond.' : 'Aucun réglage dans cette page.'}${!(opts.level ?? (opts.advanced ? 1 : 0)) && !search ? ' Passe en mode « Avancé » pour tout afficher.' : ''}</p>`;
}

function optionRow(key, opts) {
  const d = optDef(key);
  const base = opts.base(key) !== undefined ? opts.base(key) : d.default;
  const cur = opts.get(key) !== undefined ? opts.get(key) : base;
  const row = document.createElement('div');
  const gcode = isGcodeKey(key) || d.multiline;
  row.className = 'opt' + (gcode ? ' wide' : '');
  const modified = !same(cur, base);
  if (modified) row.classList.add('modified');

  const label = document.createElement('label');
  label.textContent = d.full_label && d.label && d.label.length < 14 ? d.full_label : (d.label || d.full_label || key);
  const plate = PLATE_NAMES[key.replace(/_initial_layer$/, '')];
  if (plate) label.textContent = `${plate} — ${label.textContent.replace(/^Température du plateau( lors de la couche initiale)?$/, (m, a) => a ? 'Couche initiale' : 'Autres couches')}`;
  row.appendChild(label);
  attachTip(label, key, d);

  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  const val = scalar(cur);
  const commit = (v) => {
    const next = TEXT_LIST_TYPES.has(d.type) ? v.split(',').map((s) => s.trim()).filter(Boolean) : withScalar(base, v);
    opts.set(key, same(next, base) ? undefined : next);
  };

  let input;
  if (d.type === 'coBool' || d.type === 'coBools') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = val === '1' || val === 'true' || val === true;
    input.onchange = () => commit(input.checked ? '1' : '0');
  } else if (d.enum && d.enum.length) {
    input = document.createElement('select');
    d.enum.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = d.enum_labels?.[i] || v;
      input.appendChild(o);
    });
    if (!d.enum.includes(String(val))) {
      const o = document.createElement('option'); o.value = val; o.textContent = val; input.appendChild(o);
    }
    input.value = val;
    input.onchange = () => commit(input.value);
  } else if (gcode) {
    input = document.createElement('textarea');
    input.value = Array.isArray(cur) && TEXT_LIST_TYPES.has(d.type) ? cur.join(',') : val;
    input.spellcheck = false;
    input.onchange = () => commit(input.value);
  } else if (['coFloat', 'coFloats', 'coInt', 'coInts'].includes(d.type)) {
    input = document.createElement('input');
    input.type = 'number';
    input.step = d.type.startsWith('coInt') ? '1' : 'any';
    if (d.min !== undefined) input.min = d.min;
    if (d.max !== undefined && d.max < 1e6) input.max = d.max;
    input.value = val;
    input.onchange = () => commit(input.value);
  } else if (d.type === 'coPercent' || d.type === 'coPercents') {
    input = document.createElement('input');
    input.type = 'number'; input.step = 'any';
    input.value = String(val).replace('%', '');
    input.onchange = () => commit(input.value + '%');
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = Array.isArray(cur) && TEXT_LIST_TYPES.has(d.type) ? cur.join(', ') : val;
    input.onchange = () => commit(input.value);
  }
  if (d.readonly) input.disabled = true;
  ctl.appendChild(input);
  if (d.sidetext && !gcode && input.type !== 'checkbox') {
    const u = document.createElement('span'); u.className = 'unit'; u.textContent = d.sidetext; ctl.appendChild(u);
  }
  row.appendChild(ctl);

  const reset = document.createElement('button');
  reset.className = 'reset'; reset.title = 'Revenir à la valeur du profil'; reset.textContent = '↺';
  reset.onclick = () => opts.set(key, undefined);
  row.appendChild(reset);
  return row;
}

let tipEl = null;
function attachTip(el, key, d) {
  el.addEventListener('mouseenter', () => {
    tipEl = document.createElement('div');
    tipEl.className = 'opt-tip';
    tipEl.innerHTML = `<b>${esc(d.full_label || d.label || key)}</b>${esc(d.tooltip || '')}<br><code>${esc(key)}</code>`;
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, innerHeight - tipEl.offsetHeight - 8);
    tipEl.style.left = Math.min(r.left, innerWidth - tipEl.offsetWidth - 8) + 'px';
    tipEl.style.top = top + 'px';
  });
  el.addEventListener('mouseleave', () => { tipEl?.remove(); tipEl = null; });
}

// Liste des options modifiables par objet (comme dans Orca : clic droit > ajouter des réglages)
export function objectOptionKeys() {
  const keys = new Set();
  for (const p of SCHEMA?.tabs?.process || []) for (const g of p.groups) for (const k of g.options) keys.add(k);
  // les options globales au plateau ne sont pas réglables par objet
  ['print_sequence', 'spiral_mode', 'timelapse_type', 'enable_prime_tower', 'prime_tower_width', 'prime_volume',
   'wipe_tower_x', 'wipe_tower_y', 'filename_format', 'gcode_add_line_number', 'gcode_comments', 'gcode_label_objects',
   'exclude_object', 'post_process', 'reduce_crossing_wall', 'max_travel_detour_distance', 'skirt_loops', 'skirt_distance',
   'skirt_height', 'draft_shield', 'ooze_prevention', 'standby_temperature_delta', 'print_flow_ratio',
   'enable_arc_fitting', 'initial_layer_print_height', 'default_acceleration', 'travel_speed', 'travel_acceleration',
  ].forEach((k) => keys.delete(k));
  return keys;
}

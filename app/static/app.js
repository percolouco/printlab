'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = (n, d = 0) => n == null || isNaN(n) ? '–' : Number(n).toLocaleString((window.PL_LOCALE || 'fr-FR'), {maximumFractionDigits: d, minimumFractionDigits: d});
let S = {currency: 'EUR', round_prices: false, base_url: '', low_threshold: 100, extra_fields_spool: [], extra_fields_filament: [], extra_fields_vendor: []};
const SYM = {EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', CAD: 'CA$', JPY: '¥'};
const eur = n => n == null ? '–' : fmt(S.round_prices ? Math.round(n) : n, S.round_prices ? 0 : 2) + ' ' + (SYM[S.currency] || S.currency);
const exOf = o => { try { return typeof o.extra === 'string' ? JSON.parse(o.extra) || {} : o.extra || {}; } catch { return {}; } };
// thèmes : la palette de chaque thème est dans style.css (:root[data-theme=…])
const THEMES = [['system', 'Système', 'Clair ou sombre selon l\'appareil'], ['light', 'Clair', 'Fiche d\'atelier, cuivre'], ['dark', 'Sombre', 'Ardoise et cuivre'],
  ['nuit', 'Bleu nuit', 'Les couleurs d\'avant, en sombre'], ['bleu', 'Bleu clair', 'Les couleurs d\'avant, en clair'],
  ['atelier', 'Atelier', 'Graphite et ambre'], ['neon', 'Néon', 'Nuit, cyan et magenta'], ['foret', 'Forêt', 'Clair, vert sauge'],
  ['papier', 'Papier', 'Crème et terre cuite'], ['contraste', 'Contraste élevé', 'Noir, blanc et jaune, très lisible']];
const getTheme = () => { try { return localStorage.getItem('pl-theme') || 'system'; } catch { return 'system'; } };
const applyTheme = () => { const t = getTheme(); if (t === 'system' || !THEMES.some(x => x[0] === t)) document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; };
applyTheme();
const g = n => n == null ? '–' : fmt(n, 0) + ' g';
// heure de fin estimée : « 15:09 », précédée de « demain » ou du jour de la semaine quand ce n'est pas aujourd'hui
const endAt = ts => {
  if (!ts) return '–';
  const d = new Date(ts * 1000), now = new Date();
  const hm = d.toLocaleTimeString((window.PL_LOCALE || 'fr-FR'), {hour: '2-digit', minute: '2-digit'});
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  return days <= 0 ? hm : days === 1 ? `demain ${hm}` : `${d.toLocaleDateString((window.PL_LOCALE || 'fr-FR'), {weekday: 'long'})} ${hm}`;
};
const ETA_SRC = {slicer: 'Estimation du slicer', progression: 'Extrapolée depuis la progression', 'slicer+progression': 'Moyenne : estimation du slicer et progression réelle'};
const dur = s => { if (!s) return '–'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const dt = t => t ? new Date(typeof t === 'number' ? t * 1000 : t).toLocaleString((window.PL_LOCALE || 'fr-FR'), {dateStyle: 'short', timeStyle: 'short'}) : '–';

async function api(path, opt = {}) {
  const o = {method: opt.method || 'GET', headers: {}};
  if (opt.body !== undefined) { o.body = JSON.stringify(opt.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  if (r.status === 401) { location = '/login'; throw new Error('401'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || 'Erreur ' + r.status);
  return j;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2500); }
async function act(fn, ok) { try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(e.message); return false; } }

const swatch = (hex, hexes) => hexes && hexes.length > 1
  ? `<span class="sw" style="background:linear-gradient(90deg,${hexes.map(h => '#' + h).join(',')})"></span>`
  : `<span class="sw" style="background:${hex ? '#' + hex : 'transparent'}"></span>`;
const rng = (a, b) => a == null && b == null ? '' : (b == null || a === b ? a : a == null ? b : a + '–' + b);
const temps = o => { const n = rng(o.nozzle_min, o.nozzle_max), b = rng(o.bed_min, o.bed_max); return n || b ? `${n || '?'}° / ${b || '?'}°` : '<span class="mut">–</span>'; };
const bar = (pct, low) => `<div class="pb ${low ? 'low' : pct < 40 ? 'mid' : ''}"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div>`;

// ---------- modales ----------
function modal(html) { const m = $('#modal'); m.innerHTML = `<div class="box">${html}</div>`; m.hidden = false; m.onclick = e => { if (e.target === m) closeModal(); }; }
function closeModal() { $('#modal').hidden = true; }
function formModal(title, fields, values, onSave, extra = '', entity = '') {
  const defs = entity ? S['extra_fields_' + entity] || [] : [];
  const ev = exOf(values || {});
  values = {...values};
  for (const d of defs) { fields = [...fields, ['x_' + d.key, d.name + (d.unit ? ` (${d.unit})` : ''), d.type === 'choice' ? {type: 'select', options: [['', '–'], ...(d.choices || []).map(c => [c, c])]} : d.type === 'number' ? {type: 'number'} : {}]]; values['x_' + d.key] = ev[d.key] ?? ''; }
  const f = (name, label, o = {}) => {
    const v = values[name] ?? '';
    let inp;
    if (o.type === 'select') inp = `<select name="${name}">${o.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (o.type === 'textarea') inp = `<textarea name="${name}" rows="3">${esc(v)}</textarea>`;
    else if (o.type === 'color') inp = `<input type="color" name="${name}" value="#${esc(v || '888888')}">`;
    else if (o.type === 'checkbox') return `<label class="chk ${o.full ? 'full' : ''}"><input type="checkbox" name="${name}" ${v ? 'checked' : ''}> <span id="lbl_${name}">${esc(label)}</span></label>`;
    else inp = `<input name="${name}" type="${o.type || 'text'}" step="any" value="${esc(v)}" ${o.list ? `list="${o.list}"` : ''}>`;
    return `<label class="${o.full ? 'full' : ''}">${esc(label)}${inp}</label>`;
  };
  modal(`<h2>${esc(title)}</h2><form id="mf" class="form">${fields.map(([n, l, o]) => f(n, l, o)).join('')}</form>${extra}
    <div class="acts"><button class="btn" id="mc">Annuler</button><button class="btn primary" id="ms">Enregistrer</button></div>`);
  $('#mc').onclick = closeModal;
  $('#ms').onclick = async () => {
    const out = {};
    for (const [n, , o] of fields) {
      const el = $('#mf').elements[n]; let v = el.value;
      if (o && o.type === 'number') v = v === '' ? null : Number(v);
      if (o && o.type === 'color') v = v.replace('#', '');
      if (o && o.type === 'checkbox') v = el.checked;
      out[n] = v;
    }
    if (defs.length) { out.extra = {...ev}; for (const d of defs) { const v = out['x_' + d.key]; if (v === '' || v == null) delete out.extra[d.key]; else out.extra[d.key] = v; } }
    for (const k of Object.keys(out)) if (k.startsWith('x_')) delete out[k];
    if (await act(() => onSave(out))) closeModal();
  };
}

// ---------- routeur ----------
const routes = {};
async function route() {
  const h = location.hash.slice(2) || '';
  const [name, ...rest] = h.split('/');
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + (name || '') || (!!name && (a.dataset.also || '').split(',').includes(name))));
  document.querySelectorAll('#nav .menu').forEach(m => m.querySelector('.top').classList.toggle('on', !!m.querySelector('.dd a.on')));
  const fn = routes[name || 'dashboard'] || routes.dashboard;
  clearInterval(window._poll); if (name !== 'spools' && name !== 'files') closeDrawer(); const _ci = document.getElementById('camimg'); if (_ci) _ci.src = '';
  try { await fn($('#main'), rest); } catch (e) { if (e.message !== '401') $('#main').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
addEventListener('hashchange', route);
// ---------- appli installée (écran d'accueil iOS / Android) : barre d'onglets en bas ----------
const PWA = (() => { let v = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || /[?&]pwa=1/.test(location.search);
  try { if (v) sessionStorage.setItem('pl-pwa', '1'); else v = sessionStorage.getItem('pl-pwa') === '1'; } catch {} return v; })();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
function tabSync() {
  const tb = $('#tabbar'); if (!tb) return;
  const name = (location.hash.slice(2) || '').split('/')[0], main = ['', 'dashboard', 'printer', 'files', 'box'];
  tb.querySelectorAll('[data-tab]').forEach(a => a.classList.toggle('on', a.dataset.tab === 'more' ? !main.includes(name) : a.dataset.tab === (name === 'dashboard' ? '' : name)));
  $('#tabmore').hidden = true;
}
if (PWA) {
  document.documentElement.classList.add('pwa');
  $('#tabbar').hidden = false;
  $('#tabbar [data-tab="more"]').onclick = () => { $('#tabmore').hidden = !$('#tabmore').hidden; };
  $('#tabmore').onclick = e => { if (e.target.id === 'tabmore' || e.target.closest('a')) $('#tabmore').hidden = true; };
  addEventListener('hashchange', tabSync); tabSync();
}
// Menus masquables (réglage « hidden_menus », copie locale pour éviter le clignotement au chargement)
const MENUS = [['printer', 'Imprimante', 'Fichiers à imprimer, impressions, sauvegardes'], ['box', 'Box', 'QIDI Box'], ['spools', 'Filaments', 'Bobines, filaments, marques'],
  ['invoices', 'Factures', 'Import des factures'], ['models', 'Modèles 3D', 'Recherche de modèles'], ['slicer', 'Slicer', 'Découpe et envoi à l\'imprimante'],
  ['workshop', 'Atelier', 'Entretien, firmware, santé de la machine, mods']];
function applyMenus(list) {
  const h = new Set(list || []);
  document.querySelectorAll('#nav [data-menu]').forEach(e => { e.hidden = h.has(e.dataset.menu); });
  try { localStorage.setItem('pl-hidden-menus', JSON.stringify([...h])); } catch {}
}
try { applyMenus(JSON.parse(localStorage.getItem('pl-hidden-menus') || '[]')); } catch {}

// ---------- tableau de bord ----------
// En haut : bandeau en direct (impression en cours + les emplacements de la Box). En dessous : stats sur la période choisie.
let dashDays = (() => { try { return +localStorage.getItem('pl-dash-days') || 30; } catch { return 30; } })();
const DASH_P = [[30, '30 jours'], [365, '12 mois'], [-1, 'Tout']];
routes.dashboard = async (el) => {
  const [s, live, box, pr] = await Promise.all([api('/stats?days=' + Math.max(dashDays, 0)), api('/spools'), api('/box').catch(() => null), api('/printer').catch(() => ({online: false}))]);
  const empty = live.filter(b => b.remaining_weight <= 0.5);
  const spById = Object.fromEntries(live.map(b => [b.id, b]));
  const long = dashDays !== 30;
  let chart;
  if (!long) {
    const byDay = Object.fromEntries(s.per_day.map(d => [d.day, d.g]));
    chart = Array.from({length: 30}, (_, i) => { const d = new Date(Date.now() - (29 - i) * 864e5); const k = d.toISOString().slice(0, 10); return {g: byDay[k] || 0, lbl: d.toLocaleDateString((window.PL_LOCALE || 'fr-FR'), {day: 'numeric', month: 'short'})}; });
  } else chart = s.per_month.map(m => ({g: m.g, lbl: new Date(m.month + '-01').toLocaleDateString((window.PL_LOCALE || 'fr-FR'), {month: 'short', year: '2-digit'})}));
  const max = Math.max(...chart.map(d => d.g), 1);
  const per = (DASH_P.find(p => p[0] === dashDays) || DASH_P[0])[1].toLowerCase();
  const printing = pr.online && ['printing', 'paused'].includes(pr.state);
  const slots = (box && box.slots) || [];
  const slotCard = x => { const b = x.spool_id ? spById[x.spool_id] : null, col = '#' + (b ? b.color_hex : x.printer_color || '808080');
    return `<a class="dslot ${x.box_inserted === false ? 'empty' : ''} ${box.loaded_slot === x.slot ? 'on' : ''}" href="#/box" title="${esc(b ? (b.vendor_name || '') + ' ' + b.filament_name : x.printer_filament_name || '')}">
      <span class="dsc" style="background:${esc(col)}"></span><span class="dsl"><b>${boxLbl(x.slot)}</b>${x.relay_of != null ? ` <span class="tag" title="Relais de la ${boxLbl(x.relay_of)}">↻ ${boxLbl(x.relay_of)}</span>` : ''}${box.loaded_slot === x.slot ? ' <span class="tag ok">chargée</span>' : ''}
      <span class="ell">${x.box_inserted === false ? 'vide' : esc(b ? fName(b.filament_name) : x.printer_filament_name || '?')}</span>
      <span class="mut">${b ? (b.weight_src === 'estimated' ? '~' : '') + g(b.remaining_weight) + (b.weight_src === 'estimated' ? ' · estimé' : '') : x.box_inserted === false ? '' : 'aucune bobine PrintLab'}</span></span></a>`; };
  const pct = Math.round(100 * (pr.progress || 0));
  el.innerHTML = `<div class="bar"><h1 style="margin:0">Tableau de bord</h1><span class="sp"></span>
    <div class="seg" id="per">${DASH_P.map(([d, l]) => `<button data-d="${d}" class="${d === dashDays ? 'on' : ''}">${l}</button>`).join('')}</div></div>
  <div class="card dlive">
    <div class="dlp">${printing ? `<img class="dcam" src="/api/printer/stream?snapshot=1&t=${Date.now()}" alt="" onerror="this.remove()">
      <div><div class="mut sm">${pr.state === 'paused' ? 'EN PAUSE' : 'IMPRESSION EN COURS'}</div><b class="ell" style="display:block;font-size:17px">${esc((pr.filename || '').split('/').pop().replace(/\.gcode\.3mf$|\.gcode$/, ''))}</b>
        <div class="pb" style="margin:8px 0 6px"><i style="width:${pct}%"></i></div>
        <div class="mut">${pct} %${pr.layer && pr.layer.current_layer ? ` · couche ${pr.layer.current_layer}/${pr.layer.total_layer || '?'}` : ''}${pr.remaining_s != null ? ` · reste ${dur(pr.remaining_s)} · fin vers ${new Date(pr.eta * 1000).toLocaleTimeString((window.PL_LOCALE || 'fr-FR'), {hour: '2-digit', minute: '2-digit'})}` : ''}</div>
        <a class="btn sm" href="#/printer" style="margin-top:8px">Voir l'imprimante</a></div>`
      : `<div><div class="mut sm">IMPRIMANTE</div><b style="font-size:17px">${pr.online ? (pr.state === 'complete' ? 'Impression terminée' : 'Prête') : 'Injoignable'}</b>
        <div class="mut">${pr.online ? `Buse ${fmt((pr.extruder || {}).temperature, 0)} °C · plateau ${fmt((pr.bed || {}).temperature, 0)} °C` : esc(pr.error || '')}</div>
        <div style="margin-top:8px"><a class="btn sm" href="#/files">Fichiers à imprimer</a> <a class="btn sm" href="/slicer/">Slicer</a></div></div>`}</div>
    ${slots.length ? `<div class="dslots">${slots.map(slotCard).join('')}</div>` : ''}
  </div>
  <div class="grid">
    <div class="card stat"><div class="v">${fmt(s.remaining_kg, 2)} kg</div><div class="l">en stock · ${s.spools} bobines · ${eur(s.stock_value)}</div></div>
    <div class="card stat"><div class="v">${g(s.used_g)}</div><div class="l">consommés · ${per}</div></div>
    <div class="card stat"><div class="v">${s.prints}</div><div class="l">impressions · ${s.prints ? Math.round(100 * s.prints_ok / s.prints) + ' % réussies' : '–'} · ${fmt(s.print_hours, 0)} h</div></div>
    <div class="card stat"><div class="v">${eur((s.cost || 0) + (s.elec_eur || 0))}</div><div class="l">coût · matière ${eur(s.cost)}${s.elec_eur != null ? ` · élec. ${eur(s.elec_eur)}` : ''}</div></div>
  </div>
  ${empty.length ? `<div class="card"><h2>Bobines vides à archiver (${empty.length})</h2><p class="mut">Ces bobines sont à 0 g (fin de bobine détectée pendant un print, ou poids mis à zéro). Archive-les une fois retirées : leur historique est conservé.</p>
    ${empty.map(b => `<div class="bar" style="margin:6px 0">${swatch(b.color_hex, b.color_hexes)}<b>#${b.id}</b> ${esc(b.vendor_name)} ${esc(b.filament_name)}${b.slot != null ? ` <span class="tag">Box ${slotName(b.slot)}</span>` : ''}<span class="sp"></span><button class="btn sm" data-arch="${b.id}">Archiver</button></div>`).join('')}</div>` : ''}
  ${s.anomalies.length ? `<div class="card"><h2>⚠ Compteurs incohérents</h2>${s.anomalies.map(b => `<div><a href="#/spools">#${b.id}</a> ${swatch(b.color_hex, b.color_hexes)}${esc(b.vendor_name)} ${esc(b.filament_name)} : ${g(b.used_weight)} utilisés pour ${g(b.initial_weight)}</div>`).join('')}</div>` : ''}
  <div class="grid two">
    <div class="card"><h2>Consommation · ${per}</h2>${chart.length && s.used_g ? `<div class="chart">${chart.map(d => `<div title="${d.lbl} : ${fmt(d.g)} g" style="height:${100 * d.g / max}%"></div>`).join('')}</div><div class="chx"><span>${chart[0].lbl}</span><span>${chart[chart.length - 1].lbl}</span></div>` : '<p class="mut">Aucune consommation.</p>'}
      <h2 style="margin-top:14px">Par matière</h2>${s.by_material.map(m => `<div>${esc(m.material || '?')} : <b>${g(m.g)}</b></div>`).join('') || '<span class="mut">–</span>'}</div>
    <div class="card"><h2>Au rythme actuel</h2><p class="mut sm" style="margin-top:-4px">Consommation des 60 derniers jours, stock de chaque filament (toutes bobines).</p>
      ${s.forecast.filter(f => f.days_left < 365).length ? s.forecast.filter(f => f.days_left < 365).map(f => `<div style="margin:6px 0">${swatch(f.color_hex)}${esc(f.vendor || '')} ${esc(fName(f.name))} <span class="mut">· ${g(f.g)} · ${fmt(f.per_day, 1)} g/j</span> — <b class="${f.days_left < 30 ? 'low' : ''}">${f.days_left < 60 ? 'épuisé dans ~' + f.days_left + ' j' : f.days_left < 730 ? 'épuisé dans ~' + Math.round(f.days_left / 30) + ' mois' : 'plus de 2 ans'}</b></div>`).join('') : '<p class="mut">Pas assez de consommation récente.</p>'}
      <h2 style="margin-top:14px">Stock bas (${s.low.length})</h2>${s.low.length ? s.low.map(b => `<div style="margin:6px 0">${swatch(b.color_hex, b.color_hexes)}<b>#${b.id}</b> ${esc(b.vendor_name)} ${esc(b.filament_name)} <span class="tag bad">${g(b.remaining_weight)}</span></div>`).join('') : '<p class="mut">Rien en stock bas.</p>'}</div>
    <div class="card"><h2>Les plus utilisés · ${per}</h2>${s.top.map(t => `<div>${swatch(t.color_hex)}${esc(t.vendor || '')} ${esc(t.name)} : <b>${g(t.g)}</b></div>`).join('') || '<span class="mut">–</span>'}</div>
  </div>`;
  el.querySelectorAll('#per [data-d]').forEach(b => b.onclick = () => { dashDays = +b.dataset.d; try { localStorage.setItem('pl-dash-days', dashDays); } catch {} route(); });
  el.querySelectorAll('[data-arch]').forEach(b => b.onclick = () => act(async () => {
    const sp = empty.find(x => x.id === +b.dataset.arch);
    await api('/spools/' + sp.id, {method: 'PUT', body: {archived: 1}});
    if (sp.slot != null) await api('/box/slots/' + sp.slot, {method: 'PUT', body: {spool_id: null}});
    route(); }, 'Bobine archivée'));
  // rafraîchit le bandeau pendant une impression
  if (printing) { clearTimeout(window._dashT); window._dashT = setTimeout(() => { if (location.hash === '' || location.hash === '#/' || location.hash === '#/dashboard') route(); }, 30000); }
};

// ---------- visuel de bobine (SVG) ----------
// Bobine vue de face dans sa couleur : l'épaisseur du filament enroulé suit le % restant,
// l'effet dépend de la finition (silk brillant, matte, pailleté, translucide, phosphorescent, marbre/bois, multicolore).
let _art = 0;
const FINISH = [[/silk|soie|satin|shiny|metal|chrome|brillant/, 'silk'], [/galaxy|sparkle|glitter|paillet|starlight|stellar|twinkl/, 'sparkle'], [/glow|lumin|phospho/, 'glow'],
  [/translu|transpar|clear|crystal|cristal/, 'trans'], [/marble|marbre|wood|bois|stone|pierre|granit|terrazzo/, 'speckle'], [/\bmatte?\b/, 'matte']];
const finishKind = t => (FINISH.find(([r]) => r.test((t || '').toLowerCase())) || [0, ''])[1];
function spoolArt(hex, hexes, finish, pct) {
  const id = 'sa' + (++_art), k = finishKind(finish);
  const cols = (hexes && hexes.length > 1 ? hexes : [hex || '9AA0AA']).map(h => '#' + String(h).replace('#', ''));
  const p = Math.max(0, Math.min(100, pct ?? 100)), rh = 17, rf = rh + (44 - rh) * p / 100;
  const pt = (a, r) => `${(50 + r * Math.sin(a)).toFixed(2)} ${(50 - r * Math.cos(a)).toFixed(2)}`;
  const fil = cols.length > 1
    ? cols.map((c, i) => `<path d="M50 50L${pt(i / cols.length * 2 * Math.PI, rf)}A${rf} ${rf} 0 0 1 ${pt((i + 1) / cols.length * 2 * Math.PI, rf)}Z" fill="${c}"/>`).join('')
    : `<circle cx="50" cy="50" r="${rf}" fill="${cols[0]}"/>`;
  let wind = ''; for (let r = rh + 2.4; r < rf - .5; r += 2.4) wind += `<circle cx="50" cy="50" r="${r.toFixed(1)}"/>`;
  let s = parseInt(cols[0].slice(1), 16) % 2147483646 + 1; const rnd = () => (s = s * 16807 % 2147483647) / 2147483647;
  const dots = (n, fill, op, rmin, rmax) => { let o = ''; if (rf - rh < 2) return o; for (let i = 0; i < n; i++) { const a = rnd() * 2 * Math.PI, r = rh + 1 + (rf - rh - 2) * rnd(); o += `<circle cx="${(50 + r * Math.sin(a)).toFixed(1)}" cy="${(50 - r * Math.cos(a)).toFixed(1)}" r="${(rmin + (rmax - rmin) * rnd()).toFixed(2)}" fill="${fill}" opacity="${(op * (.5 + rnd() / 2)).toFixed(2)}"/>`; } return o; };
  const sheen = k === 'silk' ? [[0, 0], [.28, .7], [.42, 0], [.6, .4], [.74, 0]] : k === 'matte' ? [[0, .06], [1, 0]] : [[0, .3], [.45, 0]];
  const ri = (rh / Math.max(rf, rh + .01)).toFixed(3);
  return `<svg viewBox="0 0 100 100" class="art" aria-hidden="true"><defs>
    <radialGradient id="${id}f"><stop offset="0" stop-color="#4b5261"/><stop offset="1" stop-color="#20242c"/></radialGradient>
    <radialGradient id="${id}h"><stop offset="0" stop-color="#f4f6f9"/><stop offset="1" stop-color="#b4bac6"/></radialGradient>
    <radialGradient id="${id}v"><stop offset="${ri}" stop-color="#000" stop-opacity=".38"/><stop offset="${((+ri + 1) / 2).toFixed(3)}" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${k === 'matte' ? .22 : .3}"/></radialGradient>
    <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="1">${sheen.map(([o, a]) => `<stop offset="${o}" stop-color="#fff" stop-opacity="${a}"/>`).join('')}</linearGradient>
    ${k === 'glow' ? `<filter id="${id}g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>` : ''}</defs>
    <circle cx="50" cy="50" r="48" fill="url(#${id}f)" stroke="#000" stroke-opacity=".35"/><circle cx="50" cy="50" r="46.5" fill="none" stroke="#fff" stroke-opacity=".08"/>
    <circle cx="50" cy="50" r="44.6" fill="none" stroke="#fff" stroke-opacity=".06" stroke-dasharray="2 3"/>
    ${k === 'glow' && p > 0 ? `<circle cx="50" cy="50" r="${rf + 1}" fill="${cols[0]}" opacity=".75" filter="url(#${id}g)"/>` : ''}
    <g opacity="${k === 'trans' ? .62 : 1}">${fil}
      <g fill="none" stroke="#000" stroke-opacity="${k === 'matte' ? .07 : .12}" stroke-width=".5">${wind}</g>
      ${p > 0 ? `<circle cx="50" cy="50" r="${rf}" fill="url(#${id}v)"/><circle cx="50" cy="50" r="${rf}" fill="url(#${id}s)"/>` : ''}
      ${k === 'sparkle' ? dots(26, '#fff', 1, .35, .9) : k === 'speckle' ? dots(34, '#000', .35, .3, 1) : ''}</g>
    <circle cx="50" cy="50" r="${rh}" fill="url(#${id}h)" stroke="#000" stroke-opacity=".25" stroke-width=".6"/>
    <circle cx="50" cy="50" r="5.5" fill="#15181f"/>${[0, 1, 2].map(i => `<circle cx="${pt(i * 2.0944, 11).split(' ')[0]}" cy="${pt(i * 2.0944, 11).split(' ')[1]}" r="2.3" fill="#15181f" opacity=".85"/>`).join('')}
  </svg>`;
}
const fName = n => String(n || '').replace(/\s*\(\d{3,}\)\s*$/, ''), fRef = n => (String(n || '').match(/\((\d{3,})\)\s*$/) || [])[1];   // « Basic Noir (10101) » → « Basic Noir » + réf. 10101
const imgUrl = (fid, image) => `/api/filaments/${fid}/image?${String(image).split('?')[1] || ''}`;
const kg = w => w >= 1000 ? fmt(w / 1000, 2) + ' kg' : g(w);

// panneau latéral (détail d'un filament et de ses bobines), posé hors de <main> pour survivre aux rafraîchissements
const drawerEl = () => {
  let d = $('#drawer');
  if (!d) { document.body.insertAdjacentHTML('beforeend', '<div id="dwbg" class="dwbg"></div><aside id="drawer" class="drawer" aria-label="Détails du filament"></aside>'); d = $('#drawer'); $('#dwbg').onclick = () => closeDrawer(); }
  return d;
};
function closeDrawer() {
  const d = $('#drawer'); if (d) { d.classList.remove('on'); $('#dwbg').classList.remove('on'); }
  spoolState.sel = null; if (typeof filesState !== 'undefined') filesState.sel = null; document.querySelectorAll('.fcard.on, tr.trow.on').forEach(c => c.classList.remove('on'));
}
addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal').hidden) closeDrawer(); });

// ---------- bobines ----------
const slotName = n => 'N°' + (n + 1);
const SP_KEY = 'pl-spools';
const spoolState = Object.assign({view: 'cards', visual: 'photo', group: 'vendor', sort: 'last_used', dir: -1, q: '', f: {material: [], vendor: [], location: [], finish: []}, low: 0, archived: 0, sel: null, open: {},
  cols: ['id', 'color', 'vendor', 'name', 'material', 'rem', 'pct', 'price', 'temps', 'loc', 'slot']}, (() => { try { return JSON.parse(localStorage.getItem(SP_KEY)) || {}; } catch { return {}; } })(), {q: ''});
const spSave = () => { try { localStorage.setItem(SP_KEY, JSON.stringify({view: spoolState.view, visual: spoolState.visual, group: spoolState.group, sort: spoolState.sort, dir: spoolState.dir, f: spoolState.f, low: spoolState.low, cols: spoolState.cols, open: spoolState.open})); } catch {} };
const SP_SORT = {last_used: ['Dernière utilisation', s => s.last_used || ''], registered: ['Date d\'ajout', s => s.registered || ''], id: ['Numéro', s => s.id], vendor: ['Fabricant', s => (s.vendor_name || '').toLowerCase()],
  name: ['Filament', s => s.filament_name.toLowerCase()], material: ['Matière', s => s.material || ''], rem: ['Poids restant', s => s.remaining_weight], pct: ['% restant', s => s.remaining_pct ?? 0],
  price: ['Prix', s => s.price_eff ?? -1], loc: ['Emplacement', s => (s.location || '').toLowerCase()]};
const SP_GROUP = {vendor: ['Marque', s => s.vendor_name || '—'], material: ['Type', s => s.material || '—'], finish: ['Finition', s => s.finish || '—'], location: ['Emplacement', s => s.location || '—'], none: ['Aucun', () => 1]};
if (!SP_GROUP[spoolState.group]) spoolState.group = 'vendor';   // ancien réglage « par filament » : chaque carte est déjà un filament
const spCols = () => ({id: ['#', s => s.id], color: ['', s => swatch(s.color_hex, s.color_hexes), 'raw'], vendor: ['Fabricant', s => esc(s.vendor_name), 'raw'], name: ['Filament', s => esc(s.filament_name) + (s.anomaly ? ' <span class="tag warn">compteur ?</span>' : ''), 'raw'],
  material: ['Matière', s => esc(s.material), 'raw'], finish: ['Finition', s => esc(s.finish), 'raw'], rem: ['Restant', s => approx(s) + g(s.remaining_weight), 'raw r'], pct: ['%', s => bar(s.remaining_pct, s.low), 'raw w'],
  price: ['Prix', s => eur(s.price_eff), 'raw r'], temps: ['Buse / plateau', s => temps(s), 'raw'], loc: ['Emplacement', s => esc(s.location), 'raw'], slot: ['Slot', s => s.slot != null ? slotName(s.slot) : '', 'raw'],
  last_used: ['Dernier usage', s => dt(s.last_used), 'raw'], lot: ['Lot', s => esc(s.lot_nr), 'raw'], diameter: ['Ø', s => fmt(s.diameter, 2), 'raw r'],
  ...Object.fromEntries((S.extra_fields_spool || []).map(d => ['x_' + d.key, [d.name, s => esc(exOf(s)[d.key] ?? ''), 'raw']]))});
const approx = s => s.weight_src === 'estimated' ? '~' : '';
const wSrc = s => s.weight_src === 'weighed' ? `<span class="wsrc ok" title="Dernière pesée, puis consommation suivie">pesée le ${dt(s.weighed_at)}</span>`
  : s.weight_src === 'estimated' ? '<span class="wsrc est" title="Une partie de la consommation n\'a pas été tracée (poids saisi ou estimé) : pèse la bobine pour fiabiliser">estimé · à peser</span>'
  : s.weight_src === 'tracked' ? '<span class="wsrc" title="Bobine neuve, toute la consommation a été suivie">suivi</span>' : s.weight_src === 'new' ? '<span class="wsrc" title="Bobine neuve, pas encore utilisée">neuve</span>' : '';
const spTag = s => s.material ? `<span class="tag">${esc(s.material)}</span>` : '';
const spLow = s => s.low ? 'low' : '';

routes.spools = async (el) => {
  const st = spoolState;
  const [all, fils] = await Promise.all([api('/spools?archived=' + st.archived), api('/filaments')]);
  const facets = {vendor: 'Marque', material: 'Type', finish: 'Finition', location: 'Emplacement'};
  const fval = {material: s => s.material, vendor: s => s.vendor_name, location: s => s.location, finish: s => s.finish};
  const render = () => {
    const needle = st.q.toLowerCase();
    let items = all.filter(s => Object.keys(facets).every(k => !st.f[k].length || st.f[k].includes(fval[k](s))) && (!st.low || s.low) && (!st.weigh || s.weight_src === 'estimated') &&
      (!needle || [s.vendor_name, s.filament_name, s.material, s.finish, s.location, s.comment, s.lot_nr, '#' + s.id, ...Object.values(exOf(s))].join(' ').toLowerCase().includes(needle)));
    const sk = SP_SORT[st.sort][1];
    items.sort((a, b) => { const x = sk(a), y = sk(b); return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
    const groups = []; const gm = new Map();
    for (const s of items) { const k = SP_GROUP[st.group][1](s); if (!gm.has(k)) { const o = {k, label: null, items: []}; gm.set(k, o); groups.push(o); } gm.get(k).items.push(s); }
    const activeChips = Object.entries(st.f).flatMap(([k, v]) => v.map(x => `<span class="fchip">${facets[k]} : ${esc(x)} <button data-rm="${k}|${esc(x)}">×</button></span>`)).join('') + (st.low ? '<span class="fchip">Stock bas <button data-rm="low|">×</button></span>' : '') + (st.weigh ? '<span class="fchip">À peser <button data-rm="weigh|">×</button></span>' : '');
    // une carte par filament ; les bobines du même filament sont cumulées (×N)
    const byFil = list => { const m = new Map(); for (const s of list) { if (!m.has(s.filament_id)) m.set(s.filament_id, []); m.get(s.filament_id).push(s); } return [...m.values()]; };
    const sum = (l, k) => l.reduce((a, s) => a + (s[k] || 0), 0);
    const photos = st.visual !== 'art';
    const fcard = ss => {
      const s0 = ss[0], tot = sum(ss, 'remaining_weight'), ini = sum(ss, 'initial_weight'), pct = ini ? 100 * tot / ini : 0, low = ss.some(s => s.low);
      const inBox = ss.filter(s => s.slot != null).map(s => slotName(s.slot));
      const art = spoolArt(s0.color_hex, s0.color_hexes, (s0.finish || '') + ' ' + s0.filament_name, pct);
      return `<div class="fcard ${st.sel && st.sel.fid === s0.filament_id ? 'on' : ''}" data-f="${s0.filament_id}" tabindex="0" role="button" style="--c:#${esc(s0.color_hex || '9AA0AA')}" title="${esc(s0.vendor_name || '')} ${esc(s0.filament_name)}">
        <div class="fca ${s0.image && photos ? 'ph' : ''}">${s0.image && photos ? `<img class="fph" src="${imgUrl(s0.filament_id, s0.image)}" alt="" loading="lazy"><span class="fmini" title="Niveau restant">${art}</span>` : art + (photos ? `<button class="fadd" data-addimg="${s0.filament_id}" title="Ajouter une photo" aria-label="Ajouter une photo">+</button>` : '')}
          ${ss.length > 1 ? `<span class="fcn">×${ss.length}</span>` : ''}${low ? '<span class="tag bad fcl">stock bas</span>' : ''}${inBox.length ? `<span class="fcs">Box ${inBox.join(' · ')}</span>` : ''}</div>
        <div class="fci"><b class="fcnm">${esc(fName(s0.filament_name))}</b><span class="mut ell">${esc(s0.vendor_name || 'Sans fabricant')} · ${esc(s0.material || '?')}</span>
          <div class="fcw"><b class="${low ? 'low' : ''}" ${ss.some(x => x.weight_src === 'estimated') ? 'title="Poids estimé : à peser"' : ''}>${ss.some(x => x.weight_src === 'estimated') ? '~' : ''}${kg(tot)}</b>${bar(pct, low)}</div></div></div>`;
    };
    const cards = groups.map(g0 => { const fl = byFil(g0.items);
      return `${st.group !== 'none' ? `<div class="fsec"><h3>${esc(String(g0.k))}</h3><span class="mut">${fl.length} filament${fl.length > 1 ? 's' : ''} · ${kg(sum(g0.items, 'remaining_weight'))}</span></div>` : ''}
        <div class="fgrid">${fl.map(fcard).join('')}</div>`; }).join('');
    const cols = spCols(); const usedCols = st.cols.filter(c => cols[c]);
    const table = `<div class="card tw"><table><thead><tr>${usedCols.map(c => `<th data-sort="${SP_SORT[c] ? c : ''}" class="${(cols[c][2] || '').includes('r') ? 'r' : ''}">${cols[c][0]}${st.sort === c ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}<th></th></tr></thead><tbody>
      ${items.map(s => `<tr class="trow ${st.sel && st.sel.sid === s.id ? 'on' : ''}" data-s="${s.id}">${usedCols.map(c => { const [, fn, o] = cols[c]; const v = fn(s); return `<td class="${(o || '').includes('r') ? 'r' : ''}" ${(o || '').includes('w') ? 'style="width:110px"' : ''}>${o ? v : esc(v)}</td>`; }).join('')}
      <td style="white-space:nowrap"><button class="btn sm" data-use="${s.id}">Utiliser</button> <button class="btn sm" data-edit="${s.id}">Modifier</button></td></tr>`).join('') || `<tr><td colspan="${usedCols.length + 1}" class="mut">Aucune bobine.</td></tr>`}</tbody></table></div>`;
    el.innerHTML = `<div class="bar"><h1 style="margin:0">Bobines</h1><span class="sp"></span>
      ${st.view === 'cards' ? `<div class="seg" id="vis" title="Visuel des cartes"><button data-vis="photo" class="${st.visual !== 'art' ? 'on' : ''}">Photos</button><button data-vis="art" class="${st.visual === 'art' ? 'on' : ''}">Dessins</button></div>` : ''}
      <div class="seg" id="vw"><button data-v="cards" class="${st.view === 'cards' ? 'on' : ''}">Cartes</button><button data-v="table" class="${st.view === 'table' ? 'on' : ''}">Tableau</button></div>
      <button class="btn" id="photos" title="Cherche la photo officielle de chaque filament qui n'en a pas">Photos officielles</button><a class="btn" href="#/filaments">Catalogue des filaments</a><a class="btn" href="/api/export/spools.csv">Export CSV</a></div>
    <div class="bar tb"><div class="pop"><button class="btn" id="fbtn">+ Filtre</button><div class="popm" id="fpop" hidden>
      ${Object.entries(facets).map(([k, l]) => { const vals = [...new Set(all.map(fval[k]).filter(Boolean))].sort(); return vals.length ? `<div class="pg"><div class="sl">${l}</div>${vals.map(v => `<label><input type="checkbox" data-fk="${k}" value="${esc(v)}" ${st.f[k].includes(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div>` : ''; }).join('')}
      <div class="pg"><label><input type="checkbox" id="lowf" ${st.low ? 'checked' : ''}> Stock bas uniquement</label><label><input type="checkbox" id="weighf" ${st.weigh ? 'checked' : ''}> À peser (poids estimé)</label><label><input type="checkbox" id="arch" ${st.archived ? 'checked' : ''}> Afficher les archivées</label></div></div></div>
      <input id="q" placeholder="Rechercher…" value="${esc(st.q)}" style="min-width:180px">${activeChips}<span class="sp"></span>
      ${st.view === 'cards' ? '' : `<div class="pop"><button class="btn" id="cbtn">Colonnes</button><div class="popm r" id="cpop" hidden>${Object.entries(cols).filter(([k]) => k !== 'color').map(([k, [l]]) => `<label><input type="checkbox" data-c="${k}" ${st.cols.includes(k) ? 'checked' : ''}> ${esc(l || 'Couleur')}</label>`).join('')}</div></div>`}
      <label class="ctl">Trier <select id="srt">${Object.entries(SP_SORT).map(([k, [l]]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn" id="dir" title="Sens du tri">${st.dir > 0 ? '↑' : '↓'}</button></div>
    ${st.view === 'cards' ? `<div class="bar gb"><span class="ctl">Regrouper par</span><div class="chips">${Object.entries(SP_GROUP).map(([k, [l]]) => `<button class="chip ${st.group === k ? 'on' : ''}" data-grp="${k}">${l}</button>`).join('')}</div></div>` : ''}
    ${st.view === 'table' ? table : cards || '<p class="mut">Aucune bobine.</p>'}
    <p class="mut" style="margin-top:14px">${items.length} bobine(s) · ${g(items.reduce((a, s) => a + s.remaining_weight, 0))} restants</p>`;
    wire(); if (st.sel) drawer();
  };
  // panneau latéral : le filament choisi et toutes ses bobines
  const drawer = () => {
    const sel = st.sel, f = sel && fils.find(x => x.id === sel.fid);
    if (!f) return closeDrawer();
    const dw = drawerEl(), ss = all.filter(s => s.filament_id === f.id).sort((a, b) => (a.slot == null) - (b.slot == null) || a.remaining_weight - b.remaining_weight);
    const tot = ss.reduce((a, s) => a + s.remaining_weight, 0), ini = ss.reduce((a, s) => a + s.initial_weight, 0), fin = (f.finish || '') + ' ' + f.name;
    const t = (lo, hi) => lo == null && hi == null ? '–' : rng(lo, hi) + ' °C', defs = S.extra_fields_spool || [];
    dw.innerHTML = `<div class="dwh" style="--c:#${esc(f.color_hex || '9AA0AA')}"><button class="dwx" data-x="1" title="Fermer (Échap)" aria-label="Fermer">×</button>
        <div class="dwa ${f.image && st.visual !== 'art' ? 'ph' : ''}">${f.image && st.visual !== 'art' ? `<span class="dwi"><img src="${imgUrl(f.id, f.image)}" alt=""></span><span class="fmini">${spoolArt(f.color_hex, f.color_hexes, fin, ini ? 100 * tot / ini : 0)}</span>` : spoolArt(f.color_hex, f.color_hexes, fin, ini ? 100 * tot / ini : 0)}
          ${st.visual === 'art' ? '' : `<button class="fadd" data-addimg="${f.id}" title="${f.image ? 'Changer la photo' : 'Ajouter une photo'}" aria-label="Photo">${f.image ? '✎' : '+'}</button>`}</div>
        <div class="dwt"><h2>${esc(fName(f.name))}</h2><div>${esc(f.vendor_name || 'Sans fabricant')}</div>
          <div class="dwtags">${f.material ? `<span class="tag">${esc(f.material)}</span>` : ''}${f.finish ? `<span class="tag">${esc(f.finish)}</span>` : ''}${fRef(f.name) ? `<span class="tag" title="Référence fabricant">réf. ${esc(fRef(f.name))}</span>` : ''}${f.color_hex ? `<span class="tag">#${esc(f.color_hex)}</span>` : ''}</div></div></div>
      <div class="dwb">
        <div class="dws"><div><b>${kg(tot)}</b><small>en stock</small></div><div><b>${ss.length}</b><small>bobine${ss.length > 1 ? 's' : ''}</small></div><div><b>${f.price && f.weight ? eur(f.price / f.weight * 1000) : '–'}</b><small>prix au kg</small></div></div>
        <div class="tech">${[['Buse', t(f.nozzle_min, f.nozzle_max)], ['Plateau', t(f.bed_min, f.bed_max)], ['Densité', fmt(f.density, 2)], ['Diamètre', fmt(f.diameter, 2) + ' mm'], ['Bobine vide', f.spool_weight ? g(f.spool_weight) : '–']].map(([k, v]) => `<span><small>${k}</small>${v}</span>`).join('')}</div>
        ${f.comment ? `<p class="mut">${esc(f.comment)}</p>` : ''}
        <div class="dwh3">${ss.length > 1 ? 'Les bobines' : 'La bobine'}</div>
        ${ss.map(s => { const ex = exOf(s); return `<div class="dsp ${sel.sid === s.id ? 'hl' : ''}" id="dsp${s.id}">
          <div class="dspt">${spoolArt(s.color_hex, s.color_hexes, fin, s.remaining_pct)}<div class="dspn"><b class="${spLow(s)}">${approx(s)}${g(s.remaining_weight)}</b> <span class="mut">/ ${g(s.initial_weight)}</span> ${wSrc(s)}
            <div class="mut sm ell">${esc(s.location) || 'Sans emplacement'}${s.remaining_length ? ' · ≈ ' + fmt(s.remaining_length / 1000, 0) + ' m' : ''}</div></div>
            <select data-slot="${s.id}" title="Association PrintLab uniquement, sans toucher à la Box"><option value="">Hors Box</option>${[0, 1, 2, 3].map(n => `<option value="${n}" ${s.slot === n ? 'selected' : ''}>Box ${slotName(n)}</option>`).join('')}</select></div>
          ${bar(s.remaining_pct, s.low)}
          <div class="dspm mut">Ajoutée le ${dt(s.registered)} · dernier usage ${dt(s.last_used)}${s.price_eff != null ? ' · payée ' + eur(s.price_eff) : ''}${s.lot_nr ? ' · lot ' + esc(s.lot_nr) : ''}
            ${defs.filter(x => ex[x.key] != null && ex[x.key] !== '').map(x => ` · ${esc(x.name)} ${esc(ex[x.key])}${x.unit ? ' ' + esc(x.unit) : ''}`).join('')}
            ${s.low ? ' <span class="tag bad">stock bas</span>' : ''}${s.anomaly ? ' <span class="tag warn">compteur incohérent</span>' : ''}${s.archived ? ' <span class="tag">archivée</span>' : ''}</div>
          ${s.comment ? `<p class="mut sm">${esc(s.comment)}</p>` : ''}
          <div class="dspb"><button class="btn sm primary" data-use="${s.id}">Utiliser / peser</button><button class="btn sm" data-edit="${s.id}">Modifier</button><button class="btn sm" data-hist="${s.id}">Historique</button><button class="btn sm" data-dup="${s.id}">Dupliquer</button></div></div>`; }).join('') || '<p class="mut">Aucune bobine active.</p>'}
      </div>
      <div class="dwf"><button class="btn primary" data-addb="${f.id}">+ Bobine</button><button class="btn" data-fedit="${f.id}">Modifier le filament</button></div>`;
    dw.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.x) return closeDrawer(); act2(b, e); };
    dw.querySelectorAll('[data-slot]').forEach(sl => sl.onchange = () => act(async () => {
      const s = all.find(x => x.id === +sl.dataset.slot);
      if (sl.value === '') { if (s.slot != null) await api('/box/slots/' + s.slot, {method: 'PUT', body: {spool_id: null}}); } else await api('/box/slots/' + sl.value, {method: 'PUT', body: {spool_id: s.id}});
      route(); }, 'Association enregistrée'));
    dw.classList.add('on'); $('#dwbg').classList.add('on');
    if (sel.sid) { const r = $('#dsp' + sel.sid); if (r) r.scrollIntoView({block: 'nearest'}); }
  };
  const wire = () => {
    $('#q').oninput = e => { st.q = e.target.value; clearTimeout(window._qt); window._qt = setTimeout(() => { render(); const q = $('#q'); q.focus(); q.setSelectionRange(99, 99); }, 200); };
    const pop = (b, p) => { if (!$(b)) return; $(b).onclick = e => { e.stopPropagation(); const h = $(p).hidden; document.querySelectorAll('.popm').forEach(x => x.hidden = true); $(p).hidden = !h; }; };
    pop('#fbtn', '#fpop'); pop('#cbtn', '#cpop');
    el.querySelectorAll('.popm').forEach(p => p.onclick = e => e.stopPropagation());
    el.onkeydown = e => { const c = e.target.closest('.fcard'); if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } };
    el.onclick = e => { const t = e.target.closest('button,[data-s],[data-f]'); if (!e.target.closest('.pop')) document.querySelectorAll('.popm').forEach(x => x.hidden = true); if (!t) return; act2(t, e); };
    el.querySelectorAll('[data-fk]').forEach(c => c.onchange = () => { const l = st.f[c.dataset.fk]; c.checked ? l.push(c.value) : l.splice(l.indexOf(c.value), 1); spSave(); const o = $('#fpop').hidden; render(); $('#fpop').hidden = o; });
    el.querySelectorAll('[data-c]').forEach(c => c.onchange = () => { c.checked ? st.cols.push(c.dataset.c) : st.cols.splice(st.cols.indexOf(c.dataset.c), 1); spSave(); render(); $('#cpop').hidden = false; });
    $('#photos').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Recherche…';
      await act(async () => { const r = await api('/images/find-all', {method: 'POST'}); toast(`${r.found} photo(s) trouvée(s)` + (r.missing.length ? ` · sans photo : ${r.missing.join(', ')}` : '')); });
      route(); };
    $('#lowf').onchange = e => { st.low = e.target.checked ? 1 : 0; spSave(); render(); };
    $('#weighf').onchange = e => { st.weigh = e.target.checked ? 1 : 0; render(); };
    $('#arch').onchange = e => { st.archived = e.target.checked ? 1 : 0; route(); };
    el.querySelectorAll('[data-grp]').forEach(b => b.onclick = () => { st.group = b.dataset.grp; spSave(); render(); });
    $('#srt').onchange = e => { st.sort = e.target.value; spSave(); render(); };
    $('#dir').onclick = () => { st.dir = -st.dir; spSave(); render(); };
    el.querySelectorAll('#vis button').forEach(b => b.onclick = () => { st.visual = b.dataset.vis; spSave(); render(); });
    el.querySelectorAll('#vw button').forEach(b => b.onclick = () => { st.view = b.dataset.v; spSave(); render(); });
    el.querySelectorAll('th[data-sort]').forEach(h => { if (h.dataset.sort) h.onclick = () => { st.dir = st.sort === h.dataset.sort ? -st.dir : 1; st.sort = h.dataset.sort; spSave(); render(); }; });
  };
  const act2 = (t, e) => {
    const D = t.dataset;
    if (D.rm) { const [k, v] = D.rm.split('|'); if (k === 'low') st.low = 0; else if (k === 'weigh') st.weigh = 0; else st.f[k].splice(st.f[k].indexOf(v), 1); spSave(); return render(); }
    if (D.use) return spoolUse(+D.use); if (D.edit) return spoolEdit(+D.edit); if (D.hist) return spoolHist(+D.hist); if (D.dup) return spoolDup(+D.dup);
    if (D.addb) return spoolNew(+D.addb); if (D.fedit) return filEdit(+D.fedit);
    const mark = node => { document.querySelectorAll('.fcard.on, tr.trow.on').forEach(c => c.classList.remove('on')); node.classList.add('on'); };
    if (D.addimg) { e.stopPropagation(); return imgModal(+D.addimg); }
    if (D.f) { st.sel = {fid: +D.f}; mark(t); return drawer(); }
    if (t.matches('[data-s]')) { const s = all.find(x => x.id === +D.s); if (!s) return; st.sel = {fid: s.filament_id, sid: s.id}; mark(t); return drawer(); }
  };
  render();
};
document.addEventListener('click', () => document.querySelectorAll('.popm').forEach(x => x.hidden = true));


// ---------- nouvelle bobine : assistant pas à pas ----------
// Marque (cochées dans Paramètres) → Matière (PLA, PETG… cochées dans Paramètres) → Gamme → Couleur → Détails.
// Les gammes et couleurs viennent de ta bibliothèque + du catalogue SpoolmanDB ; choisir une couleur du catalogue
// crée le filament avec ses données techniques (densité, températures, poids, tare).
const DENSITY = {PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PC: 1.2, PA: 1.14, 'PLA-CF': 1.3, 'PETG-CF': 1.3, 'PA-CF': 1.2, PVA: 1.23, HIPS: 1.04};
const FAM_RE = /^(PETG|PCTG|PET|PLA|ABS|ASA|TPU|TPE|TPC|PC|PAHT|PA\d*|PVA|PVB|HIPS|PPS|PP|PEEK|PEI|PEKK|PHA|CPE|PEBA)/;
const famOf = m => { const r = (m || '').toUpperCase().replace(/\s/g, '').replace(/^(HT|EASY)/, '').match(FAM_RE); return r ? (r[1].startsWith('PA') ? 'PA' : r[1]) : 'Autre'; };
const stdLabel = brand => /bambu/i.test(brand || '') ? 'Basic' : 'Standard';
const lineOf = (f, brand) => { const m = (f.material || '').toUpperCase(), fa = famOf(m); return [m !== fa ? m : '', f.finish || (m === fa ? stdLabel(brand) : '')].filter(Boolean).join(' ') || 'Standard'; };
const CATS = {};
const catFor = async name => CATS[name] ??= (await api('/catalog/brand?name=' + encodeURIComponent(name)).catch(() => ({lines: []}))).lines;
window.spoolNew = async (presetFid) => {
  const [fils, vends] = await Promise.all([api('/filaments'), api('/vendors')]);
  const myFams = (S.materials || []).map(x => x.toUpperCase());
  const st = {vendor: null, fam: '', line: '', pick: null, weight: 1000, price: '', qty: 1, nf: null, cat: []};
  const vendors = [...new Map([...vends.map(v => [String(v.id), v.name]), ...fils.filter(f => f.vendor_id == null).map(() => ['', 'Sans fabricant'])]).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const vname = () => (vendors.find(v => v[0] === st.vendor) || [])[1] || '';
  const setVendor = async id => { st.vendor = id; st.fam = st.line = ''; st.pick = st.nf = null; st.cat = id ? await catFor(vname()) : []; };
  if (presetFid) { const f = fils.find(x => x.id === presetFid); if (f) { await setVendor(String(f.vendor_id ?? '')); st.fam = famOf(f.material); st.line = lineOf(f, vname()); st.pick = {loc: f.id}; st.price = f.price ?? ''; } }
  const newFil = () => ({material: st.fam && st.fam !== 'Autre' ? st.fam : 'PLA', finish: '', color: '', hex: '888888'});
  const draw = () => {
    const ofV = fils.filter(f => String(f.vendor_id ?? '') === st.vendor), brand = vname();
    // gammes = bibliothèque + catalogue, regroupées par famille puis par libellé
    const lines = new Map();
    const L = (fam, label) => { const k = fam + '|' + label; if (!lines.has(k)) lines.set(k, {fam, label, loc: [], cat: null}); return lines.get(k); };
    ofV.forEach(f => L(famOf(f.material), lineOf(f, brand)).loc.push(f));
    st.cat.forEach(c => { const l = L(c.fam, c.label); l.cat = l.cat || c; });
    const all = [...lines.values()];
    const famsAvail = [...new Set(all.map(l => l.fam))];
    const fams = famsAvail.filter(f => !myFams.length || myFams.includes(f) || all.some(l => l.fam === f && l.loc.length)).sort((a, b) => a === 'Autre' ? 1 : b === 'Autre' ? -1 : a.localeCompare(b));
    const hidden = famsAvail.length - fams.length;
    if (st.vendor !== null && !all.length && !st.nf) st.nf = newFil();
    const gam = all.filter(l => l.fam === st.fam).sort((a, b) => (b.loc.length - a.loc.length) || a.label.localeCompare(b.label, 'fr'));
    const ln = gam.find(l => l.label === st.line);
    const nf = st.nf;
    let colors = [];
    if (ln && !nf) {
      const have = new Set(ln.loc.map(f => (f.color_hex || '').toUpperCase()));
      colors = [...ln.loc.map(f => ({k: 'l' + f.id, name: f.name.replace(/\(\d+\)\s*$/, '').replace(new RegExp('^' + (ln.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) + '\\s+', 'i'), ''), hex: f.color_hex, hexes: f.color_hexes, mine: true, f})),
        ...(ln.cat ? ln.cat.colors.filter(c => !have.has(c[1])).map((c, i) => ({k: 'c' + ln.cat.colors.indexOf(c), name: c[0], hex: c[1], hexes: c[2]})) : [])];
    }
    const pk = st.pick && (st.pick.loc ? 'l' + st.pick.loc : 'c' + st.pick.cat);
    const selLoc = st.pick && st.pick.loc ? fils.find(f => f.id === st.pick.loc) : null;
    const selCat = st.pick && st.pick.cat != null && ln && ln.cat ? ln.cat.colors[st.pick.cat] : null;
    const ready = !!selLoc || !!selCat || !!(nf && nf.material && nf.color.trim());
    const tech = selCat ? ln.cat : selLoc ? null : null;
    const wopts = [...new Set([250, 500, 1000, 2000, 3000, ...((ln && ln.cat && ln.cat.weights) || [])])].sort((a, b) => a - b);
    const t = (lo, hi) => lo == null ? '–' : lo === hi || hi == null ? `${lo} °C` : `${lo}–${hi} °C`;
    modal(`<h2>Nouvelle bobine</h2>
      <div class="step"><div class="sl">1 · Marque</div><div class="chips">${vendors.map(([id, n]) => `<button class="chip ${id === st.vendor ? 'on' : ''}" data-v="${esc(id)}">${esc(n)}</button>`).join('') || '<span class="mut">Aucune marque : coche tes marques dans Paramètres.</span>'}</div></div>
      ${st.vendor !== null && all.length ? `<div class="step"><div class="sl">2 · Matière</div><div class="chips">${fams.map(f => `<button class="chip ${!nf && f === st.fam ? 'on' : ''}" data-fa="${esc(f)}">${esc(f)}</button>`).join('')}<button class="chip ${nf ? 'on' : ''}" data-new="1">+ Nouveau filament</button></div>
        ${hidden ? `<p class="mut" style="margin:6px 0 0;font-size:12px">${hidden} autre(s) matière(s) chez ${esc(brand)}, masquée(s) par tes réglages (Paramètres → Mes matières).</p>` : ''}</div>` : ''}
      ${st.fam && !nf ? `<div class="step"><div class="sl">3 · Gamme ${esc(brand)}</div><div class="chips">${gam.map(l => `<button class="chip ${l.label === st.line ? 'on' : ''}" data-ln="${esc(l.label)}" title="${l.loc.length ? l.loc.length + ' dans ta bibliothèque' : 'catalogue'}">${esc(l.label)}${l.loc.length ? ' ✓' : ''}</button>`).join('')}</div></div>` : ''}
      ${nf ? `<div class="step"><div class="sl">3 · Nouveau filament</div><div class="form">
        <label>Matière<input id="nm" list="nmats" value="${esc(nf.material)}"></label>
        <label>Finition / gamme (facultatif)<input id="nfi" placeholder="Basic, Matte, Silk…" value="${esc(nf.finish)}"></label>
        <label>Nom de la couleur<input id="nco" placeholder="ex. Noir, Rouge écarlate" value="${esc(nf.color)}"></label>
        <label>Couleur<input id="nhx" type="color" value="#${esc(nf.hex)}"></label></div>
        <datalist id="nmats">${[...new Set([...(myFams.length ? myFams : []), ...Object.keys(DENSITY)])].map(m => `<option>${esc(m)}</option>`).join('')}</datalist>
        <p class="mut" style="margin:6px 0 0;font-size:12px">Densité <span id="nden">${fmt(DENSITY[nf.material.toUpperCase()] || 1.24, 2)}</span> g/cm³, Ø 1,75 mm (modifiables ensuite dans le catalogue).</p></div>`
      : ln ? `<div class="step"><div class="sl">4 · Couleur</div><div class="colors">${colors.map(c => `<button class="col ${c.k === pk ? 'on' : ''}" data-k="${c.k}" title="${esc(c.name)}${c.mine ? ' · dans ta bibliothèque' : ' · catalogue'}">${swatch(c.hex, c.hexes)}<span>${esc(c.name)}${c.mine ? ' <b class="mut">✓</b>' : ''}</span></button>`).join('')}</div>
        ${ln.cat ? `<p class="mut" style="margin:6px 0 0;font-size:12px">✓ = déjà dans ta bibliothèque. Les autres viennent du catalogue SpoolmanDB.</p>` : ''}</div>` : ''}
      ${selLoc || selCat || nf ? `<div class="step"><div class="sl">5 · Détails</div>
        ${tech ? `<div class="tech">${[['Densité', fmt(tech.density, 2) + ' g/cm³'], ['Buse', t(...(tech.nozzle || []))], ['Plateau', t(...(tech.bed || []))], ['Tare bobine', tech.spool_weight ? fmt(tech.spool_weight) + ' g' : '–']].map(([k, v]) => `<span><small>${k}</small>${v}</span>`).join('')}</div>` : ''}
        <div class="form">
        <label>Poids de filament<select id="w">${wopts.map(v => `<option value="${v}" ${v === st.weight ? 'selected' : ''}>${v >= 1000 ? fmt(v / 1000, v % 1000 ? 2 : 0) + ' kg' : v + ' g'}</option>`).join('')}</select></label>
        <label>Prix payé (${esc(SYM[S.currency] || S.currency)})<input id="p" type="number" step="any" value="${esc(st.price)}" placeholder="${selLoc ? selLoc.price ?? '' : ''}"></label>
        <label>Quantité<input id="qty" type="number" min="1" max="50" value="${st.qty}"></label></div></div>` : ''}
      <div class="acts"><button class="btn" id="mc">Annuler</button><button class="btn primary" id="ms" ${ready ? '' : 'disabled'}>Ajouter la bobine</button></div>`);
    $('#mc').onclick = closeModal;
    document.querySelectorAll('.chip[data-v]').forEach(b => b.onclick = async () => { await setVendor(b.dataset.v); draw(); });
    document.querySelectorAll('.chip[data-fa]').forEach(b => b.onclick = () => { st.fam = b.dataset.fa; st.line = ''; st.pick = st.nf = null;
      const g = all.filter(l => l.fam === st.fam); if (g.length === 1) st.line = g[0].label; draw(); });
    document.querySelectorAll('.chip[data-ln]').forEach(b => b.onclick = () => { st.line = b.dataset.ln; st.pick = null; const l = gam.find(x => x.label === st.line);
      if (l && l.cat && l.cat.weights.length && !l.cat.weights.includes(st.weight)) st.weight = l.cat.weights.includes(1000) ? 1000 : l.cat.weights[0]; draw(); });
    const nb = $('.chip[data-new]'); if (nb) nb.onclick = () => { st.nf = st.nf || newFil(); st.pick = null; st.line = ''; draw(); };
    document.querySelectorAll('.col[data-k]').forEach(b => b.onclick = () => { const k = b.dataset.k;
      st.pick = k[0] === 'l' ? {loc: +k.slice(1)} : {cat: +k.slice(1)};
      if (st.pick.loc) { const f = fils.find(x => x.id === st.pick.loc); st.price = f.price ?? ''; } draw(); });
    if (nf) {
      const upd = () => { nf.material = $('#nm').value.trim(); nf.finish = $('#nfi').value.trim(); nf.color = $('#nco').value; nf.hex = $('#nhx').value.replace('#', '').toUpperCase(); $('#ms').disabled = !(nf.material && nf.color.trim()); };
      ['#nm', '#nfi', '#nco', '#nhx'].forEach(k => $(k).oninput = upd);
      $('#nm').addEventListener('input', () => { $('#nden').textContent = fmt(DENSITY[nf.material.toUpperCase()] || 1.24, 2); });
    }
    if (selLoc || selCat || nf) {
      $('#w').onchange = e => st.weight = Number(e.target.value); $('#p').oninput = e => st.price = e.target.value;
      $('#qty').oninput = e => st.qty = Number(e.target.value) || 1;
      $('#ms').onclick = () => act(async () => {
        let fid = selLoc && selLoc.id;
        const price = st.price === '' ? null : Number(st.price), vid = st.vendor === '' ? null : Number(st.vendor);
        if (selCat) {
          const c = ln.cat, [lo, hi] = c.nozzle || [], [blo, bhi] = c.bed || [];
          fid = (await api('/filaments', {method: 'POST', body: {vendor_id: vid, name: `${c.label} ${selCat[0]}`, material: c.mat, finish: c.finish || null,
            color_hex: selCat[1], color_hexes: selCat[2] || null, density: c.density || DENSITY[c.fam] || 1.24, diameter: 1.75, weight: st.weight,
            spool_weight: c.spool_weight, nozzle_min: lo, nozzle_max: hi, bed_min: blo, bed_max: bhi, price,
            external_id: `sdb:${brand}:${c.mat}:${c.label}:${selCat[0]}`}})).id;
        } else if (nf) {
          const mat = nf.material.toUpperCase();
          fid = (await api('/filaments', {method: 'POST', body: {vendor_id: vid, name: `${nf.finish || mat} ${nf.color.trim()}`,
            material: mat, finish: nf.finish || null, color_hex: nf.hex, density: DENSITY[mat] || 1.24, diameter: 1.75, weight: st.weight, price}})).id;
        }
        await api('/spools', {method: 'POST', body: {filament_id: fid, initial_weight: st.weight, used_weight: 0, price, quantity: st.qty}});
        closeModal(); route();
      }, 'Bobine ajoutée');
    }
  };
  draw();
};

// photo d'un filament : officielle (recherche auto), fichier (appareil photo / galerie sur téléphone) ou adresse d'image
window.imgModal = async fid => {
  const f = (await api('/filaments')).find(x => x.id === fid); if (!f) return;
  const done = msg => { closeModal(); toast(msg); route(); };
  modal(`<h2>Photo · ${esc(fName(f.name))}</h2>
    ${f.image ? `<div class="imgcur"><img src="${imgUrl(f.id, f.image)}" alt=""><div class="mut sm">Source : ${f.image_src && /^https?:/.test(f.image_src) ? `<a href="${esc(f.image_src)}" target="_blank" rel="noopener">${esc(new URL(f.image_src).hostname)}</a>` : esc(f.image_src || '–')}</div></div>` : ''}
    <div class="step"><div class="sl">Photo officielle</div><button class="btn" id="imfind">Chercher sur le site de ${esc(f.vendor_name || 'la marque')}</button></div>
    <div class="step"><div class="sl">Ta photo</div><label class="btn" style="display:inline-block">Choisir une image…<input type="file" id="imfile" accept="image/*" hidden></label></div>
    <div class="step"><div class="sl">Adresse d'une image</div><div class="bar" style="margin:0"><input id="imurl" placeholder="https://…/photo.jpg" style="flex:1;min-width:0"><button class="btn" id="imgo">Utiliser</button></div></div>
    <div class="acts">${f.image ? '<button class="btn danger" id="imdel">Retirer la photo</button><span style="flex:1"></span>' : ''}<button class="btn" id="mc">Fermer</button></div>`);
  $('#mc').onclick = closeModal;
  $('#imfind').onclick = async e => { e.target.disabled = true; e.target.textContent = 'Recherche…';
    try { await api(`/filaments/${fid}/image/find`, {method: 'POST'}); done('Photo officielle ajoutée'); } catch (x) { toast(x.message); e.target.disabled = false; e.target.textContent = 'Réessayer'; } };
  $('#imgo').onclick = () => act(async () => { await api(`/filaments/${fid}/image/url`, {method: 'POST', body: {url: $('#imurl').value}}); done('Photo enregistrée'); });
  $('#imfile').onchange = e => act(async () => {
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    const r = await fetch(`/api/filaments/${fid}/image/upload`, {method: 'POST', body: fd}); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail || 'Erreur ' + r.status); done('Photo enregistrée'); });
  if ($('#imdel')) $('#imdel').onclick = () => act(async () => { await api(`/filaments/${fid}/image`, {method: 'DELETE'}); done('Photo retirée'); });
};

window.spoolEdit = async (id) => {
  const [fils, locs, s] = await Promise.all([api('/filaments'), api('/locations'), id ? api('/spools/' + id) : null]);
  if (!fils.length) { toast("Crée d'abord un filament"); location.hash = '#/filaments'; return; }
  const fields = [
    ['filament_id', 'Filament', {type: 'select', full: true, options: fils.map(f => [f.id, `${f.vendor_name || ''} – ${f.name} (${f.material || '?'})`])}],
    ['initial_weight', 'Poids initial (g)', {type: 'number'}], ['remaining_weight', 'Poids restant (g)', {type: 'number'}],
    ['with_spool', 'Poids avec bobine', {type: 'checkbox', full: true}],
    ['price', 'Prix payé (€)', {type: 'number'}], ['location', 'Emplacement', {list: 'locs'}],
    ['lot_nr', 'N° de lot'], ['archived', 'Archivée', {type: 'select', options: [[0, 'Non'], [1, 'Oui']]}],
    ['comment', 'Commentaire', {type: 'textarea', full: true}]];
  const tareOf = fid => (fils.find(f => f.id === Number(fid)) || {}).tare;
  const init = s ? {...s, remaining_weight: Math.round(s.remaining_weight * 10) / 10} : {quantity: 1, archived: 0};
  formModal(id ? 'Bobine #' + id : 'Nouvelle bobine', fields, init,
    async v => {
      const rem = v.remaining_weight, gross = v.with_spool, tare = tareOf(v.filament_id);
      delete v.remaining_weight; delete v.with_spool;
      if (gross && rem != null && !tare) throw new Error('Poids de la bobine vide inconnu : renseigne-le sur le filament ou le fabricant');
      if (id) {
        await api('/spools/' + id, {method: 'PUT', body: v});
        // ne recale que si l'utilisateur a changé le restant (ou pesé bobine comprise)
        if (rem != null && (gross || Math.abs(rem - init.remaining_weight) >= 0.05))
          await api(`/spools/${id}/measure`, {method: 'POST', body: {remaining_weight: rem, gross}});
      } else {
        const ini = v.initial_weight ?? (fils.find(f => f.id === Number(v.filament_id)) || {}).weight ?? 1000;
        v.used_weight = rem == null ? 0 : Math.max(0, ini - Math.max(0, rem - (gross ? tare : 0)));
        await api('/spools', {method: 'POST', body: v});
      }
      route(); },
    `<datalist id="locs">${locs.map(l => `<option>${esc(l)}</option>`).join('')}</datalist>` +
    (id ? `<div class="bar" style="margin-top:12px"><button class="btn sm" onclick="spoolDup(${id})">Dupliquer</button><button class="btn sm danger" onclick="spoolDel(${id})">Supprimer</button></div>` : ''), 'spool');
  // libellé de la case : rappelle la tare utilisée (filament, sinon fabricant), réglable sur ces fiches
  const fm = $('#mf').elements, lbl = () => { const t = tareOf(fm.filament_id.value);
    $('#lbl_with_spool').textContent = t ? `Poids avec bobine : retirer ${fmt(t)} g de bobine vide` : 'Poids avec bobine (poids de bobine vide à renseigner sur le filament ou le fabricant)';
    fm.with_spool.disabled = !t; if (!t) fm.with_spool.checked = false; };
  fm.filament_id.addEventListener('change', lbl); lbl();
};
window.spoolDup = async id => { if (await act(() => api(`/spools/${id}/duplicate`, {method: 'POST'}), 'Bobine dupliquée')) { closeModal(); route(); } };
window.spoolDel = async id => { if (confirm('Supprimer définitivement cette bobine ?') && await act(() => api('/spools/' + id, {method: 'DELETE'}), 'Supprimée')) { closeModal(); route(); } };
window.spoolUse = async id => { const sp = await api('/spools/' + id); formModal('Utiliser / peser la bobine #' + id, [
  ['weight', 'Consommé (g)', {type: 'number'}], ['length', 'ou longueur (mm)', {type: 'number'}],
  ['gross_weight', sp.tare ? `ou pesée : poids avec bobine (bobine vide ${fmt(sp.tare)} g)` : 'ou pesée : poids avec bobine (poids de bobine vide à renseigner)', {type: 'number', full: true}]], {},
  async v => {
    if (v.gross_weight != null) await api(`/spools/${id}/measure`, {method: 'POST', body: {gross_weight: v.gross_weight}});
    else await api(`/spools/${id}/use`, {method: 'POST', body: {weight: v.weight, length: v.length}});
    route();
  }); };
// historique d'une bobine, modifiable : chaque ligne peut être corrigée (poids, date, note), déplacée vers une autre
// bobine (erreur de slot Box) ou supprimée ; le stock des bobines concernées est recalculé côté serveur.
const SRC = {suivi: 'Suivi auto', manual: 'Manuel', manuel: 'Manuel', impression: 'Impression', 'pesée': 'Pesée'};
const srcLbl = s => (s || '').split(' · ').map(x => SRC[x] || x).join(' · ');
const toLocal = ts => { const d = new Date(ts || Date.now()); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };
const toUtc = v => new Date(v).toISOString().slice(0, 19) + 'Z';
window.spoolHist = async (id, editId) => {
  const [s, sp] = await Promise.all([api('/spools/' + id), api('/spools?all=1')]);
  const opts = cur => sp.filter(x => !x.archived || x.id === cur).map(x => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(x.vendor_name || '')} ${esc(fName(x.filament_name))} · ${g(x.remaining_weight)}${x.slot != null ? ' · Box ' + slotName(x.slot) : ''}${x.id === id ? ' (cette bobine)' : ''}</option>`).join('');
  const form = (u, k) => `<tr class="hedit" data-k="${k}"><td colspan="5"><div class="hform">
    <label>Date<input type="datetime-local" class="hts" value="${toLocal(u.ts)}"></label>
    <label>Poids consommé (g)<input type="number" step="any" class="hw" value="${u.weight ?? ''}" placeholder="g"></label>
    <label class="w2">Bobine<select class="hsp">${opts(u.spool_id || id)}</select></label>
    <label class="w2">Note<input class="hnote" placeholder="facultatif" value="${esc(u.note || '')}"></label>
    <div class="hact"><button class="btn sm" data-hcancel="1">Annuler</button><button class="btn sm primary" data-hsave="${k}">Enregistrer</button></div></div></td></tr>`;
  const line = u => editId === u.id ? form(u, u.id) : `<tr><td>${dt(u.ts)}</td><td class="r ${u.weight < 0 ? 'ok' : ''}">${u.weight < 0 ? '+' + fmt(-u.weight, 1) : fmt(u.weight, 1)} g</td><td>${esc(srcLbl(u.source))}</td><td class="ell" style="max-width:200px" title="${esc(u.note)}">${esc(u.note)}</td>
    <td style="white-space:nowrap"><button class="btn sm" data-hed="${u.id}" title="Corriger ou déplacer vers une autre bobine">✎</button> <button class="btn sm danger" data-hdel="${u.id}" title="Supprimer la ligne">🗑</button></td></tr>`;
  modal(`<h2>${swatch(s.color_hex)}${esc(s.vendor_name)} ${esc(fName(s.filament_name))}</h2>
    <p>Restant : <b>${g(s.remaining_weight)}</b> sur ${g(s.initial_weight)} · enregistrée le ${dt(s.registered)} · dernier usage ${dt(s.last_used)}</p>
    <div class="bar" style="margin:0 0 8px"><b style="flex:1">Historique</b><button class="btn sm" id="hadd">+ Ajouter une consommation</button></div>
    <div class="tw"><table class="hist"><thead><tr><th>Date</th><th class="r">Poids</th><th>Source</th><th>Note</th><th></th></tr></thead><tbody>
    ${editId === 'new' ? form({ts: null, weight: '', spool_id: id, note: ''}, 'new') : ''}
    ${s.usage.map(line).join('') || (editId === 'new' ? '' : '<tr><td colspan="5" class="mut">Aucun mouvement enregistré.</td></tr>')}</tbody></table></div>
    <p class="mut sm" style="margin:8px 0 0">✎ corrige le poids, la date ou la note d'une ligne. Pour une erreur de slot Box, choisis la bonne bobine dans la liste : la consommation y est déplacée. Le stock des deux bobines est recalculé.</p>
    <div class="acts"><button class="btn" id="mc">Fermer</button></div>`);
  $('#modal .box').style.width = 'min(780px,100%)';
  const box = $('#modal'), again = e => spoolHist(id, e), done = async msg => { toast(msg); await route(); spoolHist(id); };
  $('#mc').onclick = closeModal;
  $('#hadd').onclick = () => again('new');
  box.querySelectorAll('[data-hed]').forEach(b => b.onclick = () => again(+b.dataset.hed));
  box.querySelectorAll('[data-hcancel]').forEach(b => b.onclick = () => again());
  box.querySelectorAll('[data-hdel]').forEach(b => b.onclick = () => { const u = s.usage.find(x => x.id === +b.dataset.hdel);
    if (confirm(`Supprimer cette ligne (${fmt(u.weight, 1)} g) ? Le poids est rendu à la bobine.`)) act(async () => { await api('/usage/' + u.id, {method: 'DELETE'}); await done('Ligne supprimée'); }); });
  box.querySelectorAll('[data-hsave]').forEach(b => b.onclick = () => act(async () => {
    const r = b.closest('tr'), w = r.querySelector('.hw').value, body = {weight: w === '' ? null : Number(w), spool_id: Number(r.querySelector('.hsp').value), ts: toUtc(r.querySelector('.hts').value), note: r.querySelector('.hnote').value.trim() || null};
    if (body.weight == null || isNaN(body.weight)) throw new Error('Poids requis');
    if (b.dataset.hsave === 'new') await api(`/spools/${body.spool_id}/use`, {method: 'POST', body: {...body, source: 'manuel'}});
    else await api('/usage/' + b.dataset.hsave, {method: 'PUT', body});
    await done(body.spool_id !== id ? 'Consommation déplacée vers l\'autre bobine' : 'Historique mis à jour'); }));
};

// ---------- filaments ----------
routes.filaments = async (el) => {
  const items = await api('/filaments');
  el.innerHTML = `<h1>Filaments</h1><div class="bar"><button class="btn primary" onclick="filEdit()">+ Nouveau filament</button></div>
  <div class="card tw"><table><thead><tr><th></th><th>Fabricant</th><th>Nom</th><th>Matière</th><th>Finition</th><th class="r">Prix</th><th class="r">Poids</th><th>Temp. buse/plateau</th><th class="r">Dens.</th><th class="r">Ø</th><th class="r">Bobines</th><th class="r">Stock</th><th></th></tr></thead><tbody>
  ${items.map(f => `<tr><td>${swatch(f.color_hex, f.color_hexes)}</td><td>${esc(f.vendor_name)}</td><td>${esc(f.name)}</td><td>${esc(f.material)}</td><td>${esc(f.finish)}</td>
  <td class="r">${eur(f.price)}</td><td class="r">${g(f.weight)}</td><td>${temps(f)}</td><td class="r">${fmt(f.density, 2)}</td><td class="r">${fmt(f.diameter, 2)}</td><td class="r">${f.spools}</td><td class="r">${g(f.remaining)}</td>
  <td style="white-space:nowrap"><button class="btn sm" onclick="spoolEditFor(${f.id})">+ bobine</button> <button class="btn sm" onclick="filEdit(${f.id})">Modifier</button></td></tr>`).join('')}</tbody></table></div>`;
};
window.spoolEditFor = fid => spoolNew(fid);
window.filEdit = async (id) => {
  const [vs, fs, mats] = await Promise.all([api('/vendors'), api('/filaments'), api('/materials')]);
  const f = id ? fs.find(x => x.id === id) : {density: 1.24, diameter: 1.75, weight: 1000};
  formModal(id ? 'Modifier le filament' : 'Nouveau filament', [
    ['vendor_id', 'Fabricant', {type: 'select', options: [['', '—'], ...vs.map(v => [v.id, v.name])]}], ['name', 'Nom', {}],
    ['material', 'Matière', {list: 'mats'}], ['finish', 'Finition (Basic, Matte, Silk…)', {}],
    ['color_hex', 'Couleur', {type: 'color'}], ['article_number', 'Référence', {}],
    ['weight', 'Poids net (g)', {type: 'number'}], ['spool_weight', 'Poids bobine vide (g)', {type: 'number'}],
    ['price', 'Prix (€)', {type: 'number'}], ['density', 'Densité (g/cm³)', {type: 'number'}],
    ['diameter', 'Diamètre (mm)', {type: 'number'}], ['low_threshold', 'Alerte stock bas (g, défaut : réglage global)', {type: 'number'}],
    ['nozzle_min', 'Buse min (°C)', {type: 'number'}], ['nozzle_max', 'Buse max (°C)', {type: 'number'}],
    ['bed_min', 'Plateau min (°C)', {type: 'number'}], ['bed_max', 'Plateau max (°C)', {type: 'number'}],
    ['comment', 'Commentaire', {type: 'textarea', full: true}]], f,
    async v => { if (!v.vendor_id) v.vendor_id = null; if (id) await api('/filaments/' + id, {method: 'PUT', body: v}); else await api('/filaments', {method: 'POST', body: v}); route(); },
    `<datalist id="mats">${mats.map(m => `<option>${esc(m)}</option>`).join('')}</datalist>` +
    (id ? `<div class="bar" style="margin-top:12px"><button class="btn sm danger" onclick="filDel(${id})">Supprimer</button></div>` : ''), 'filament');
};
window.filDel = async id => { if (confirm('Supprimer ce filament ?') && await act(() => api('/filaments/' + id, {method: 'DELETE'}), 'Supprimé')) { closeModal(); route(); } };

// ---------- marques : gérées dans Paramètres ----------
routes.vendors = async () => { location.hash = '#/settings'; };
window.vendEdit = v => formModal(v ? 'Modifier le fabricant' : 'Nouveau fabricant', [
  ['name', 'Nom', {}], ['website', 'Site web', {}], ['empty_spool_weight', 'Poids bobine vide (g)', {type: 'number'}], ['comment', 'Commentaire', {type: 'textarea', full: true}]],
  v || {}, async x => { if (v) await api('/vendors/' + v.id, {method: 'PUT', body: x}); else await api('/vendors', {method: 'POST', body: x}); route(); },
  v && !v.filaments ? `<div class="bar" style="margin-top:12px"><button class="btn sm danger" onclick="vendDel(${v.id})">Supprimer</button></div>` : '', 'vendor');
window.vendDel = async id => { if (confirm('Supprimer ce fabricant ?') && await act(() => api('/vendors/' + id, {method: 'DELETE'}), 'Supprimé')) { closeModal(); route(); } };

// ---------- imprimante ----------
// Vue « jumeau » de la QIDI Max4 : photo + températures en surimpression, ventilateurs animés, Box, système.
// Le squelette (photo, caméra) est rendu une fois ; chaque rafraîchissement ne met à jour que ce qui change.
const FANS = {
  cooling_fan: ['Ventilateur pièce', 'Refroidissement du modèle'], auxiliary_cooling_fan: ['Auxiliaire', 'Ventilateur latéral de refroidissement des pièces'],
  auxiliary_cooling_fan2: ['Auxiliaire 2', 'Second ventilateur auxiliaire'], hotend_fan: ['Tête', 'Refroidit le radiateur de la buse'],
  chamber_circulation_fan: ['Circulation caisson', "Brasse l'air chaud du caisson"], chamber_fan: ['Ventilateur caisson', 'Piloté automatiquement par Klipper'],
  board_fan: ['Électronique', 'Carte mère de l\'imprimante'],
  heater_fan_a_box1: ['Box · chauffage A', 'Souffle sur la résistance A'], heater_fan_b_box1: ['Box · chauffage B', 'Souffle sur la résistance B'], board_fan_box1: ['Box · électronique', 'Carte de la Box']};
const PSTATE = {printing: ['Impression en cours', 'ok'], paused: ['En pause', 'warn'], complete: ['Terminée', ''], cancelled: ['Annulée', 'warn'], error: ['Erreur', 'bad'], standby: ['En veille', '']};
const fanSvg = `<svg viewBox="0 0 24 24" class="fan"><circle cx="12" cy="12" r="2.2"/><path d="M12 9.8C11 6 12.5 2.5 15.5 3c2.6.5 1.9 4.6-3.5 6.8zM14.2 12c3.8-1 7.3.5 6.8 3.5-.5 2.6-4.6 1.9-6.8-3.5zM12 14.2c1 3.8-.5 7.3-3.5 6.8-2.6-.5-1.9-4.6 3.5-6.8zM9.8 12C6 13 2.5 11.5 3 8.5c.5-2.6 4.6-1.9 6.8 3.5z"/></svg>`;
// Icônes maison (remplacent les visuels QIDI) : buse, plateau, caisson, lumière
const ICO = {
  extruder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M7 3h10v7H7z"/><path d="M9 10h6l-1.5 5h-3z"/><path d="M11 15h2v2.5l-1 1.5-1-1.5z"/><path d="M5 21h14" stroke-linecap="round"/></svg>',
  hotbed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 17h18v3H3z" stroke-linejoin="round"/><path d="M7 13c-1-1.3 1-2.2 0-3.6M12 13c-1-1.3 1-2.2 0-3.6M17 13c-1-1.3 1-2.2 0-3.6"/></svg>',
  chamber: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M12 7v6.2" stroke-linecap="round"/><circle cx="12" cy="15.5" r="2.3"/></svg>',
  light: on => `<svg viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>`,
};
// Imprimante dessinée de face (vectoriel, pas de visuel constructeur) ; viewBox 800×560 = repères des pastilles en %.
// Les zones chaudes s'allument selon l'état : buse, plateau, caisson (lueur), résistance du caisson.
function printerArt(st) {
  const glow = (t, lo, hi) => t == null ? 0 : Math.max(0, Math.min(1, (t - lo) / (hi - lo)));
  const gN = glow(st.nozzle, 60, 260), gB = glow(st.bed, 40, 100), gC = glow(st.chamber, 30, 65), gH = glow(st.heater, 60, 140);
  const L = (x1, y1, x2, y2, hot) => `<path d="M${x1} ${y1}H${(x1 + x2) / 2}L${x2} ${y2}" fill="none" stroke="${hot ? '#ff9a3c' : '#5a6378'}" stroke-width="2"/><circle cx="${x2}" cy="${y2}" r="4.5" fill="${hot ? '#ffb15c' : '#8b93a7'}"/>`;
  return `<svg viewBox="0 0 800 560" class="prart" aria-hidden="true"><defs>
    <linearGradient id="paBody" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3c424d"/><stop offset=".5" stop-color="#4b525e"/><stop offset="1" stop-color="#363b45"/></linearGradient>
    <linearGradient id="paIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1e27"/><stop offset="1" stop-color="#0f1218"/></linearGradient>
    <radialGradient id="paGlow" cx=".5" cy=".62" r=".75"><stop offset="0" stop-color="#ff8a2a" stop-opacity=".75"/><stop offset="1" stop-color="#ff6a00" stop-opacity=".18"/></radialGradient>
    <linearGradient id="paBed" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb35c"/><stop offset="1" stop-color="#e2650f"/></linearGradient>
    <linearGradient id="paGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="800" height="560" fill="#0b0e1a"/>
  <ellipse cx="400" cy="526" rx="210" ry="10" fill="#000" opacity=".5"/>
  <rect x="218" y="58" width="364" height="464" rx="14" fill="url(#paBody)" stroke="#5b6372" stroke-width="1.5"/>
  <rect x="336" y="50" width="128" height="10" rx="3" fill="#2a2f38"/>
  <rect x="236" y="74" width="74" height="48" rx="5" fill="#0d1016" stroke="#626a79"/><rect x="243" y="80" width="60" height="36" rx="2" fill="#16304d"/><path d="M249 92h22M249 100h34M249 108h16" stroke="#5aa0e6" stroke-width="3" stroke-linecap="round" opacity=".8"/>
  <rect x="236" y="134" width="328" height="372" rx="8" fill="url(#paIn)" stroke="#1d2129" stroke-width="3"/>
  <rect x="236" y="134" width="328" height="372" rx="8" fill="url(#paGlow)" opacity="${(gC * .9).toFixed(2)}"/>
  <path d="M268 140V500M532 140V500" stroke="#596171" stroke-width="5"/>
  <path d="M246 172H554" stroke="#6b7385" stroke-width="9" stroke-linecap="round"/>
  <rect x="372" y="152" width="56" height="44" rx="5" fill="#cfd3d9"/><rect x="380" y="160" width="40" height="18" rx="3" fill="#9aa1ab"/>
  <path d="M392 196h16l-4 9h-8z" fill="#8d949e"/><circle cx="400" cy="208" r="${(3 + gN * 4).toFixed(1)}" fill="#ff7a1a" opacity="${gN.toFixed(2)}"/>
  <rect x="262" y="246" width="276" height="12" rx="3" fill="${gB > 0.05 ? 'url(#paBed)' : '#7d8593'}"/>
  ${gB > 0.05 ? `<rect x="262" y="236" width="276" height="10" fill="#ff8a2a" opacity="${(gB * .35).toFixed(2)}" rx="3"/>` : ''}
  <rect x="290" y="258" width="220" height="8" fill="#3a404a"/>
  <rect x="300" y="456" width="64" height="22" rx="4" fill="${gH > .05 ? '#e2650f' : '#3a404a'}" stroke="#596171"/>${gH > .05 ? `<rect x="300" y="452" width="64" height="6" rx="3" fill="#ffb35c" opacity="${gH.toFixed(2)}"/>` : ''}
  <rect x="236" y="134" width="328" height="372" rx="8" fill="url(#paGlass)"/>
  <rect x="548" y="282" width="7" height="70" rx="3" fill="#8d949e"/>
  <text x="440" y="104" font-family="IBM Plex Mono,monospace" font-size="15" font-weight="600" fill="#aeb4bd" letter-spacing="2">MAX 4</text>
  ${L(700, 142, 408, 196, gN > .05)}${L(118, 202, 266, 252, gB > .05)}${L(686, 344, 470, 380, gC > .3)}${st.heater != null ? L(118, 416, 312, 462, gH > .05) : ''}
  </svg>`;
}
const setH = (el, h) => { if (el && el._h !== h) { el.innerHTML = h; el._h = h; } };
const spin = sp => sp > 0.01 ? `animation-duration:${(1.5 - Math.min(sp, 1) * 1.25).toFixed(2)}s` : 'animation:none';
routes.printer = async (el) => {
  el.innerHTML = `<h1>Imprimante <span id="prst"></span></h1><p class="mut" id="prsub"></p><div id="prerr"></div>
  <div class="pr-grid"><div class="card" style="margin:0"><h2>Caméra</h2><div id="prcam"></div></div>
    <div class="pr-side"><div class="card"><h2>Impression</h2><div id="prjob"></div></div><div class="card"><h2>Système</h2><div id="prsys"></div></div></div></div>
  <div class="pr-grid"><div class="pr-hero"><div class="pr-img"><div id="prart"></div><div id="prpills"></div><div id="prfov"></div></div>
      <div class="pr-legend"><span><i class="lg h"></i>en chauffe</span><span><i class="lg"></i>à l'arrêt</span><span class="mut">Max : buse 370 °C · plateau 120 °C · caisson 65 °C</span></div></div>
    <div class="card" style="margin:0"><h2>Ventilation</h2><div id="prfans" class="fans"></div></div></div>`;
  let camSet = false, fanKeys = '';
  $('#prjob').onclick = async e => { const b = e.target.closest('[data-job]'); if (!b) return; const j = b.dataset.job;
    if (j === 'cancel' && !confirm('Annuler l\'impression en cours ? Elle ne pourra pas être reprise.')) return;
    if (j === 'pause' && !confirm('Mettre l\'impression en pause ?')) return;
    b.disabled = true; await act(async () => { await api('/printer/job/' + j, {method: 'POST', body: {}}); await draw(); }, {pause: 'Pause demandée', resume: 'Reprise demandée', cancel: 'Annulation demandée'}[j]); };
  const draw = async () => {
    const p = await api('/printer');
    if (!p.online) { setH($('#prerr'), `<div class="card err">${/non configur/.test(p.error || '') ? 'Aucune imprimante configurée. Renseigne son adresse dans <a href="#/settings">Paramètres</a>.' : 'Imprimante injoignable : ' + esc(p.error) + ' · <a href="#/settings">vérifier l\'adresse</a>'}</div>`); return; }
    setH($('#prerr'), '');
    const [stl, stc] = PSTATE[p.state] || [p.state || '?', ''];
    setH($('#prst'), `<span class="tag ${stc}">${esc(stl)}</span>`);
    setH($('#prsub'), `QIDI Max4 · ${esc(p.hostname)} · Klipper ${esc(p.klippy)} · rafraîchi toutes les 3 s · seule commande possible : la lumière`);
    const S2 = p.sensors || {}, F = p.fans || {};
    const deg = v => v == null ? '–' : fmt(v, 0) + '°';
    // pastilles de température posées sur les repères de la photo (coordonnées en % de l'image recadrée)
    const pill = (x, y, icon, label, cur, tgt, side) => {
      const hot = tgt > 0 || (icon === null && cur > 60);
      return `<div class="pill ${hot ? 'hot' : ''} ${side}" style="left:${x}%;top:${y}%">${icon ? ICO[icon] : ''}<span><small>${label}</small><b>${deg(cur)}</b>${tgt != null ? `<em>/ ${tgt > 0 ? deg(tgt) : 'off'}</em>` : ''}</span></div>`;
    };
    const ch = S2.chamber || p.chamber || {}, ptc = S2.Chamber_Thermal_Protection_Sensor || {};
    setH($('#prart'), printerArt({nozzle: p.extruder?.temperature, bed: p.bed?.temperature, chamber: ch.temperature, heater: ptc.temperature}));
    setH($('#prpills'), pill(89.4, 25.4, 'extruder', 'Buse', p.extruder?.temperature, p.extruder?.target, 'r') + pill(14.4, 36, 'hotbed', 'Plateau', p.bed?.temperature, p.bed?.target, 'l')
      + pill(86.3, 61.4, 'chamber', 'Caisson', ch.temperature, ch.target, 'r') + (ptc.temperature != null ? pill(14.4, 74.3, null, 'Résistance caisson', ptc.temperature, null, 'l') : ''));
    const fb = (x, y, k) => F[k] ? `<div class="fbadge ${F[k].speed > 0.01 ? 'on' : ''}" style="left:${x}%;top:${y}%" title="${esc(FANS[k]?.[0] || k)}">${fanSvg.replace('class="fan"', `class="fan" style="${spin(F[k].speed)}"`)}<b>${Math.round((F[k].speed || 0) * 100)} %</b></div>` : '';
    setH($('#prfov'), fb(37, 27, 'cooling_fan') + fb(33.7, 53.6, 'auxiliary_cooling_fan') + fb(53.7, 86, 'chamber_circulation_fan'));
    // impression
    const pct = Math.round((p.progress || 0) * 100);
    const v = p.velocity;
    setH($('#prjob'), p.filename && p.state !== 'standby' ? `<div class="ell"><b>${esc(p.filename.replace(/\.gcode(\.3mf)?$/i, ''))}</b></div>
      <div style="margin:8px 0">${bar(pct)} <b>${pct} %</b></div>
      <div class="kv"><span>Couche</span><b>${p.layer?.current_layer ?? '–'} / ${p.layer?.total_layer ?? '–'}</b><span>Durée</span><b>${dur(p.print_duration)}</b>${p.remaining_s != null ? `<span>Temps restant</span><b title="${esc(ETA_SRC[p.eta_source] || '')}">${dur(p.remaining_s)}</b><span>Fin estimée</span><b>${endAt(p.eta)}</b>` : ''}
      <span>Filament</span><b>${fmt((p.filament_used_mm || 0) / 1000, 1)} m</b><span>Vitesse</span><b>${v != null ? fmt(v, 0) + ' mm/s' : '–'} <span class="mut">× ${fmt((p.speed_factor || 1) * 100, 0)} %</span></b></div>
      ${p.write && (p.state === 'printing' || p.state === 'paused') ? `<div class="dwact" id="prctl">${p.state === 'printing' ? '<button class="btn" data-job="pause">⏸ Pause</button>' : '<button class="btn primary" data-job="resume">▶ Reprendre</button>'}<button class="btn danger" data-job="cancel">■ Annuler l'impression</button></div>` : ''}`
      : `<span class="mut">Aucune impression en cours.</span>${p.filename ? `<div class="mut" style="margin-top:6px">Dernière : ${esc(p.filename.replace(/\.gcode(\.3mf)?$/i, ''))}</div>` : ''}`);
    // ventilateurs : structure construite une fois, puis seules les valeurs bougent (l'animation ne redémarre pas)
    const keys = Object.keys(F).filter(k => !/box1$/.test(k)).sort((a, b) => Object.keys(FANS).indexOf(a) - Object.keys(FANS).indexOf(b));
    if (keys.join() !== fanKeys) { fanKeys = keys.join();
      $('#prfans').innerHTML = keys.map(k => `<div class="fr" data-fan="${esc(k)}">${fanSvg}<div class="fn"><b>${esc(FANS[k]?.[0] || k)}</b><small class="mut">${esc(FANS[k]?.[1] || '')}</small></div><div class="fv"><b class="pc"></b><small class="rpm mut"></small></div><div class="fb"><i></i></div></div>`).join('')
        + `<div class="fr" data-pin="polar"><svg viewBox="0 0 24 24" class="fan snow"><path d="M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10" stroke-width="2" stroke="currentColor" fill="none"/></svg><div class="fn"><b>Polar cooler</b><small class="mut">Refroidisseur de l'extrudeur</small></div><div class="fv"><b class="pc"></b></div><div class="fb"><i></i></div></div>`; }
    keys.forEach(k => { const r = document.querySelector(`#prfans [data-fan="${CSS.escape(k)}"]`); if (!r) return; const f = F[k], sp = f.speed || 0;
      r.classList.toggle('on', sp > 0.01); const sv = r.querySelector('.fan'), st = spin(sp); if (sv._s !== st) { sv.setAttribute('style', st); sv._s = st; }
      r.querySelector('.pc').textContent = Math.round(sp * 100) + ' %'; r.querySelector('.rpm').textContent = f.rpm ? fmt(f.rpm, 0) + ' tr/min' : '';
      r.querySelector('.fb i').style.width = Math.round(sp * 100) + '%'; });
    const pr = document.querySelector('#prfans [data-pin="polar"]'); if (pr) { const pv = p.polar_cooler || 0; pr.classList.toggle('on', pv > 0); pr.querySelector('.pc').textContent = p.polar_cooler == null ? '–' : Math.round(pv * 100) + ' %'; pr.querySelector('.fb i').style.width = Math.round(pv * 100) + '%'; }
    // système
    const sy = p.system || {}, pos = p.position || [];
    setH($('#prsys'), `<div class="kv"><span>État Klipper</span><b>${esc(p.klippy)}</b>
      <span>Axes référencés</span><b>${esc((p.homed || '').toUpperCase()) || '<span class="mut">aucun</span>'}</b>
      <span>Position</span><b>${pos.length ? `X ${fmt(pos[0], 1)} · Y ${fmt(pos[1], 1)} · Z ${fmt(pos[2], 2)}` : '–'}</b>
      <span>Charge CPU</span><b>${fmt(sy.sysload, 2)}</b><span>Mémoire libre</span><b>${sy.memavail ? fmt(sy.memavail / 1024, 0) + ' Mo' : '–'}</b></div>`);
    const lb = $('#prlight'); if (lb) { const on = !!p.caselight; lb.classList.toggle('on', on); lb.setAttribute('aria-pressed', on); lb.querySelector('i').innerHTML = ICO.light(on); lb.querySelector('span').textContent = on ? 'Lumière allumée' : 'Lumière éteinte'; lb.dataset.on = on ? 1 : 0; }
    if (!camSet) { camSet = true;
      $('#prcam').innerHTML = `<div class="camw"><img class="cam" id="camimg" src="/api/printer/stream?t=${Date.now()}" alt="Caméra de l'imprimante">
        <button class="lightb" id="prlight" type="button" aria-pressed="false"><i>${ICO.light(false)}</i><span>Lumière</span></button>
        <p class="mut camerr" hidden>Caméra injoignable. <button class="btn sm" id="camre">Réessayer</button></p></div>`;
      const ci = $('#camimg'), ce = $('#prcam .camerr');
      ci.onerror = () => { ci.hidden = true; ce.hidden = false; };
      $('#camre').onclick = () => { ce.hidden = true; ci.hidden = false; ci.src = '/api/printer/stream?t=' + Date.now(); };
      $('#prlight').onclick = async e => { const b = e.currentTarget, on = b.dataset.on !== '1'; b.disabled = true;
        await act(async () => { await api('/printer/light', {method: 'POST', body: {on}}); await draw(); }, on ? 'Lumière allumée' : 'Lumière éteinte'); b.disabled = false; };
      draw().catch(() => {}); }
  };
  await draw();
  window._poll = setInterval(() => draw().catch(() => {}), 3000);
};

// ---------- QIDI Box ----------

// QIDI Box dessinée (vue de face, vectorielle) : bobines de profil, hauteur du filament = poids restant,
// pastille cuivre = emplacement chargé, alerte rouge quand la bobine est en stock bas. Les pastilles (data-pin) sont cliquables.
function boxArt(slots) {
  const W = 1040, BX = 60, BW = 920, LT = 40, LB = 330, BB = 560, AX = (LT + LB) / 2 + 8, IW = BW - 24, CW = IW / 4;
  const Rmax = (LB - LT) / 2 - 6, rIn = 34, fw = CW * .70, fl = 10;
  let s = `<svg class="boxart" viewBox="0 0 ${W} 600" role="img" aria-label="QIDI Box"><defs>
   <linearGradient id="baBase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe2e6"/><stop offset="1" stop-color="#b9bec5"/></linearGradient>
   <linearGradient id="baBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a7adb5"/><stop offset="1" stop-color="#c4c9cf"/></linearGradient>
   <linearGradient id="baLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a525e" stop-opacity=".62"/><stop offset=".28" stop-color="#3a414b" stop-opacity=".48"/><stop offset=".29" stop-color="#2a3038" stop-opacity=".14"/><stop offset="1" stop-color="#1b2027" stop-opacity=".22"/></linearGradient>
   <linearGradient id="baShine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
   <linearGradient id="baCyl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".35"/><stop offset=".18" stop-color="#fff" stop-opacity=".18"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".4"/></linearGradient>
   <pattern id="baWire" width="7" height="10" patternUnits="userSpaceOnUse"><path d="M1 0v10" stroke="#000" stroke-opacity=".14" stroke-width="1.3"/><path d="M4.5 0v10" stroke="#fff" stroke-opacity=".10"/></pattern></defs>
   <ellipse cx="${W / 2}" cy="${BB + 12}" rx="${BW / 2 + 30}" ry="12" fill="#000" opacity=".22"/>
   <rect x="${BX}" y="${LT}" width="${BW}" height="${LB - LT + 14}" rx="4" fill="#15191f"/>
   <rect x="${BX + 12}" y="${LT + 8}" width="${IW}" height="${LB - LT}" fill="#101318"/>`;
  const cxOf = i => BX + 12 + i * CW + CW / 2;
  slots.forEach((sl, i) => {
    const x0 = BX + 12 + i * CW, cx = cxOf(i), rF = rIn + (Rmax - rIn) * (sl.empty ? 0 : sl.frac);
    s += `<rect x="${x0 - 4}" y="${LT + 8}" width="8" height="${LB - LT}" fill="#1b1f26"/>
      <rect x="${cx - fw / 2 - fl}" y="${AX - Rmax}" width="${fl}" height="${2 * Rmax}" rx="3" fill="#3a404a"/>
      <rect x="${cx + fw / 2}" y="${AX - Rmax}" width="${fl}" height="${2 * Rmax}" rx="3" fill="#3a404a"/>
      <rect x="${cx - fw / 2}" y="${AX - rIn}" width="${fw}" height="${2 * rIn}" fill="#0b0d10"/>`;
    if (sl.empty) s += `<text x="${cx}" y="${AX + 5}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="14" fill="#6b7385" letter-spacing="2">VIDE</text>`;
    else ['', 'url(#baWire)', 'url(#baCyl)'].forEach(f => { s += `<rect x="${cx - fw / 2}" y="${AX - rF}" width="${fw}" height="${2 * rF}" fill="${f || '#' + sl.col}"/>`; });
  });
  s += `<rect x="${BX + 12 + IW - 4}" y="${LT + 8}" width="8" height="${LB - LT}" fill="#1b1f26"/>
   <rect x="${BX}" y="${LT}" width="${BW}" height="${LB - LT + 14}" rx="4" fill="url(#baLid)" stroke="#59616d" stroke-width="2"/>
   <rect x="${BX}" y="${LT}" width="${BW}" height="${LB - LT + 14}" fill="url(#baShine)"/>
   <path d="M${BX + 2} ${LT + 82}H${BX + BW - 2}" stroke="#8a929d" stroke-opacity=".5" stroke-width="1.5"/>
   <rect x="${BX}" y="${LB}" width="${BW}" height="14" fill="#0e1014" opacity=".85"/>`;
  slots.forEach((sl, i) => {
    const cx = cxOf(i);
    if (sl.low && !sl.empty) s += `<g transform="translate(${cx} ${LT + 34})"><rect x="-46" y="-12" width="92" height="24" rx="12" fill="#e5484d"/><text y="5" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="12" font-weight="600" fill="#fff">${esc(sl.lowTxt)}</text></g>`;
    s += `<g class="bapin" data-pin="${i}" transform="translate(${cx} ${LB - 34})"><title>${esc(sl.title)}</title><circle r="19" fill="#15181e" stroke="${sl.loaded ? '#e08a57' : '#cfd3d9'}" stroke-width="${sl.loaded ? 4 : 2}"/>${sl.loaded ? '<circle r="26" fill="none" stroke="#e08a57" stroke-width="2" class="baring"/>' : ''}<text y="7" text-anchor="middle" font-size="19" font-weight="700" fill="#fff">${i + 1}</text></g>`;
  });
  s += `<rect x="${BX - 2}" y="${LB + 14}" width="${BW + 4}" height="${BB - LB - 14}" rx="3" fill="url(#baBase)"/>
   <rect x="${BX - 2}" y="${LB + 26}" width="${BW + 4}" height="30" fill="url(#baBand)"/>
   <text x="${BX + 50}" y="${LB + 112}" font-family="IBM Plex Mono,monospace" font-size="25" font-weight="600" fill="#3a3f47" letter-spacing="1">QIDI</text>
   <rect x="${BX + 124}" y="${LB + 90}" width="56" height="28" rx="5" fill="#3a3f47"/><text x="${BX + 152}" y="${LB + 110}" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="15" font-weight="600" fill="#e8e6e1">BOX</text>
   <rect x="${W / 2 - 60}" y="${LB - 2}" width="120" height="36" rx="8" fill="#eef0f2" stroke="#8d949e" stroke-width="1.5"/>${[...Array(8)].map((_, k) => `<path d="M${W / 2 + 10 + k * 5} ${LB + 6}v20" stroke="#9aa1ab"/>`).join('')}
   <rect x="${BX + 70}" y="${BB}" width="34" height="6" rx="2" fill="#2a2e35"/><rect x="${BX + BW - 104}" y="${BB}" width="34" height="6" rx="2" fill="#2a2e35"/></svg>`;
  return s;
}
const hexDist = (a, b) => { const p = h => { h = String(h).replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }; const x = p(a), y = p(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
// ligne « réglé sur l'imprimante » d'un emplacement + écart éventuel avec la bobine associée
const slotInfo = (s, x) => {
  const d = [];
  if (x && s.printer_type && x.material && s.printer_type.toUpperCase() !== String(x.material).toUpperCase()) d.push('type');
  // la Box et Fluidd n'ont qu'une palette de 24 teintes : on tolère l'écart avec la teinte exacte de la bobine (#FAFAFA ≈ #FFFFFF)
  if (x && s.printer_color && x.color_hex && hexDist(s.printer_color, x.color_hex) > 60) d.push('couleur');
  const pr = s.printer_filament || s.printer_color;
  const txt = pr ? `Imprimante : ${esc(s.printer_filament_name || s.printer_filament || 'type non défini')}` : s.col ? 'Couleur de la bobine' : '&nbsp;';
  const tip = pr ? `Réglé sur l'imprimante : ${s.printer_filament_name || s.printer_filament || '?'}${s.printer_color ? ' #' + s.printer_color : ''}` : '';
  return `<div class="ci mut" title="${esc(tip)}">${s.col ? `<span class="sw" style="background:#${esc(s.col)}"></span>` : ''}<span class="el">${txt}</span>${d.length ? `<span class="tag warn" title="La bobine associée ne correspond pas à ce que l'imprimante indique">≠ ${d.join(' + ')}</span>` : ''}</div>`;
};
// synchronisation bobine PrintLab → imprimante (comme une étiquette RFID : marque, matière, teinte la plus proche des 24)
const syncLine = (s, all) => {
  if (s.sync_error) return `<div class="mut sm syncl"><span class="tag warn">synchro impossible</span> ${esc(s.sync_error)}</div>`;
  const t = s.sync_target; if (!t) return '';
  const others = (all || []).filter(o => o.slot !== s.slot && o.box_inserted && o.printer_filament);
  const relaySel = others.length ? `<select class="relsel" data-relay="${s.slot}" title="Déclare cette bobine à l'imprimante comme identique à une autre (marque, matière, couleur) pour que la Box puisse basculer dessus quand l'autre est vide. Le décompte reste sur la vraie bobine.">
      <option value="">Bobine de relais de…</option>${others.map(o => `<option value="${o.slot}">relais de la n°${o.slot + 1}</option>`).join('')}</select>` : '';
  if (s.relay_of != null) return `<div class="syncl"><div class="mut sm"><span class="tag ok">relais de la n°${s.relay_of + 1}</span> l'imprimante la voit comme la n°${s.relay_of + 1} : la Box basculera dessus quand la n°${s.relay_of + 1} sera vide. Le décompte reste sur cette bobine.</div>
    <button class="btn sm" data-sync="${s.slot}" title="Rend à cette bobine sa vraie identité côté imprimante">Fin du relais : synchroniser</button></div>`;
  const what = `${esc(t.name)}${t.generic ? ' (marque absente de la liste QIDI)' : ''} · <span class="sw" style="background:#${esc(t.color)}"></span>#${esc(t.color)}`;
  // bobine lue par RFID et conforme : l'imprimante a déjà les infos exactes de l'étiquette, rien à synchroniser
  if (s.rfid_linked && s.in_sync) return `<div class="syncl"><div class="mut sm"><span class="tag ok">lue par RFID</span> l'imprimante a les infos exactes de l'étiquette</div>${relaySel ? `<div class="row2">${relaySel}</div>` : ''}</div>`;
  return `<div class="syncl"><div class="mut sm">${s.in_sync ? '<span class="tag ok">imprimante à jour</span>' : '<span class="tag warn">imprimante pas à jour</span>'} ${what}</div>
    <div class="row2"><button class="btn ${s.in_sync ? '' : 'primary'} sm" data-sync="${s.slot}" title="Envoie marque, matière et couleur à l'imprimante (aucun chargement ni déchargement)">Synchroniser avec l'imprimante</button>${relaySel}</div></div>`;
};
routes.box = async (el) => {
  const [b, spools, hp] = await Promise.all([api('/box'), api('/spools'), api('/box/heat').catch(() => ({}))]);
  if (!b.online) { el.innerHTML = `<h1>QIDI Box</h1><div class="card err">${/non configur/.test(b.error || '') ? 'Aucune imprimante configurée. Renseigne son adresse dans <a href="#/settings">Paramètres</a>.' : 'Injoignable : ' + esc(b.error) + ' · <a href="#/settings">vérifier l\'adresse</a>'}</div>`; return; }
  const sp = id => spools.find(x => x.id === id);
  // emplacement vide (la Box ne détecte pas de bobine) : on n'affiche ni bobine ni couleur ; l'association reste enregistrée
  // pour réapparaître quand la bobine est remise
  b.slots.forEach(s => { s.sid = s.spool_id || s.printer_spool_id || null; s.empty = !s.box_inserted; s.col = s.empty ? null : s.printer_color || (sp(s.sid) || {}).color_hex || null; });
  const hum = b.humidity, tmp = b.temp;
  const tz = tmp == null ? {k: 'z0', l: '–'} : tmp < 35 ? {k: 'z1', l: 'Ambiante'} : tmp < 50 ? {k: 'z2', l: 'Chauffe'} : {k: 'z3', l: 'Séchage'};
  const hz = hum == null ? {k: 'z0', l: '–'} : hum < 40 ? {k: 'z1', l: 'Normale'} : hum < 60 ? {k: 'z2', l: 'Un peu élevée'} : {k: 'z3', l: 'Élevée'};
  el.innerHTML = `<div class="boxp"><div class="bar"><h1 style="margin:0">QIDI Box</h1><span class="sp"></span><span class="mut">Associe une bobine à chaque emplacement, puis « Synchroniser » pour que l'imprimante la reconnaisse</span></div>
  <div class="hero"><div class="hstats">
      <div class="hum ${hz.k}"><svg class="drop" viewBox="0 0 56 70" width="58" height="72" aria-hidden="true"><defs>
          <clipPath id="dcl"><path d="M28 5C28 5 9 29 9 45a19 19 0 0 0 38 0C47 29 28 5 28 5z"/></clipPath>
          <linearGradient id="dgr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".95"/><stop offset="1" stop-color="currentColor" stop-opacity=".55"/></linearGradient></defs>
        <path d="M28 5C28 5 9 29 9 45a19 19 0 0 0 38 0C47 29 28 5 28 5z" fill="currentColor" opacity=".08"/>
        <g clip-path="url(#dcl)"><g style="transform:translateY(${(64 - 54 * Math.min(100, Math.max(hum || 0, 6)) / 100).toFixed(1)}px)"><g class="wv"><path d="M-28 0q7-4.5 14 0t14 0t14 0t14 0t14 0t14 0t14 0t14 0V80h-112z" fill="url(#dgr)"/></g></g>
          <path d="M17 36c-3 5-4 9-3.4 13" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></g>
        <path d="M28 5C28 5 9 29 9 45a19 19 0 0 0 38 0C47 29 28 5 28 5z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>
      <div class="hb"><div class="hv"><b>${fmt(hum, 0)}</b> %RH <span class="hz">${hz.l}</span></div>
        <div class="hbar"><i class="z1"></i><i class="z2"></i><i class="z3"></i><u style="left:${Math.min(100, hum || 0)}%"></u></div>
        <div class="hlab"><span>Normale<br>0–39</span><span>Un peu élevée<br>40–59</span><span>Élevée<br>60–100</span></div><div class="hv" style="margin-top:4px;font-size:12px">Recommandé : moins de 40 %RH</div></div></div>
      <div class="hum tmp ${tz.k}"><svg class="thermo" viewBox="0 0 40 70" width="42" height="72" aria-hidden="true"><defs>
          <clipPath id="tcl"><path d="M13 6a7 7 0 0 1 14 0v34.5a12.5 12.5 0 1 1-14 0z" transform="translate(0 4)"/></clipPath>
          <linearGradient id="tgr" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="currentColor" stop-opacity=".6"/><stop offset="1" stop-color="currentColor" stop-opacity=".98"/></linearGradient></defs>
        <path d="M13 6a7 7 0 0 1 14 0v34.5a12.5 12.5 0 1 1-14 0z" transform="translate(0 4)" fill="currentColor" opacity=".08"/>
        <g clip-path="url(#tcl)"><rect x="0" y="${(52 - 44 * Math.min(1, Math.max(tmp || 0, 0) / 65)).toFixed(1)}" width="40" height="70" fill="url(#tgr)"/><circle cx="20" cy="52" r="9" fill="url(#tgr)"/>
          <path d="M16 18v26" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity=".45" fill="none"/></g>
        <path d="M13 6a7 7 0 0 1 14 0v34.5a12.5 12.5 0 1 1-14 0z" transform="translate(0 4)" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>
        <g stroke="currentColor" stroke-width="1.6" opacity=".55" stroke-linecap="round"><path d="M32 14h4M32 24h4M32 34h4M32 44h4"/></g></svg>
      <div class="hb"><div class="hv"><b>${fmt(tmp, 1)}</b> °C <span class="hz">${tz.l}</span></div>
        <div class="hbar"><i class="t1"></i><i class="t2"></i><i class="t3"></i><u style="left:${Math.min(100, Math.max(0, (tmp || 0) / 65 * 100))}%"></u>${b.target_temp > 0 ? `<s style="left:${Math.min(100, b.target_temp / 65 * 100)}%" title="consigne ${fmt(b.target_temp, 0)}°"></s>` : ''}</div>
        <div class="hlab t"><span>Ambiante<br>0–34</span><span>Chauffe<br>35–49</span><span>Séchage<br>50–65</span></div>
        <div class="hv" style="margin-top:4px;font-size:12px">${b.target_temp > 0 ? `Consigne <b style="font-size:13px">${fmt(b.target_temp, 0)} °C</b>` : 'Chauffage éteint'} · max 65 °C</div></div></div>
      <div class="hs"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8z"/></svg></i><div><b>${(b.loaded_slot && Number(b.loaded_slot.slice(4)) < 4) ? slotName(Number(b.loaded_slot.slice(4))) : 'Aucun'}</b><span>slot chargé</span></div></div></div>
    <div class="himg">${boxArt(b.slots.map(s => { const x = sp(s.sid); const frac = x && x.initial_weight > 0 ? Math.max(.06, Math.min(1, x.remaining_weight / x.initial_weight)) : 1;
        return {empty: s.empty, loaded: s.loaded, col: s.col || '8b93a7', frac, low: !!(x && x.low), lowTxt: x ? g(x.remaining_weight) : '',
          title: `${slotName(s.slot)}${s.empty ? ' : vide' : x ? ` : ${x.vendor_name} ${x.filament_name} · ${g(x.remaining_weight)}` : ''}`}; }))}</div></div>
  <div class="card" id="heatc"><h2 style="margin:0 0 6px">Séchage de la Box</h2>
    <p class="mut sm" style="margin:0 0 10px">Chauffe uniquement la Box (rien d'autre n'est modifié sur l'imprimante : pas de rotation des bobines).</p>
    ${hp.active ? `<div style="margin-bottom:10px"><span class="tag ok">séchage en cours</span> consigne <b>${fmt(hp.target, 0)} °C</b> · reste <b>${Math.floor((hp.remaining_s || 0) / 3600)} h ${String(Math.floor((hp.remaining_s || 0) % 3600 / 60)).padStart(2, '0')}</b> · arrêt auto sous ${fmt(hp.hum_stop, 0)} % RH</div>
      <button class="btn primary" id="heatstop">Arrêter le séchage</button>`
    : `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end"><label>Température (°C)<br><input type="number" id="heatt" min="30" max="65" step="1" value="50" style="width:90px"></label>
      <label>Durée max (h)<br><input type="number" id="heath" min="0.25" max="24" step="0.25" value="4" style="width:90px"></label>
      <label>Arrêt si humidité ≤ (%)<br><input type="number" id="heatu" min="0" max="100" step="1" value="15" style="width:90px"></label>
      <button class="btn primary" id="heatgo">Démarrer le séchage</button></div>
      ${hp.reason ? `<div class="mut sm" style="margin-top:8px">Dernier séchage terminé : ${esc(hp.reason)}</div>` : ''}`}
    ${hp.printing ? '<div class="mut sm" style="margin-top:8px">Une impression est en cours.</div>' : ''}
    ${hp.pending_print ? `<div class="pdry-pend"><span class="tag ok">impression programmée</span> <b data-notr>${esc(flName(hp.pending_print.path))}</b> démarrera automatiquement à la fin du séchage.
      <button class="btn sm" id="pendx">Annuler l'impression programmée</button></div>` : ''}</div>
  <div class="slots">${b.slots.map(s => { const x = sp(s.sid); return `<div class="sc ${s.loaded ? 'ld' : ''}" id="sc${s.slot}">
    <div class="sh"><span class="sn2">${slotName(s.slot)}</span>${s.loaded ? '<span class="tag ok">chargé</span>' : ''}${s.rfid ? (s.rfid_brand === 'bambu' ? `<span class="tag ok" title="Puce d'origine Bambu Lab lue par la Box : bobine du stock associée automatiquement (même matière, couleur la plus proche)">RFID Bambu</span>` : `<span class="tag ok" title="Étiquette RFID lue par la Box : bobine associée automatiquement">RFID</span>`) : ''}<span class="tag ${s.box_inserted ? '' : 'warn'}">${s.box_inserted ? 'bobine détectée' : 'vide'}</span></div>
    ${s.rfid_brand === 'bambu' && !s.rfid_linked ? `<div class="mut sm" style="color:var(--warn)">Puce Bambu lue (${esc(s.printer_filament_name || '')}) : aucune bobine de ton stock ne correspond. Ajoute-la dans Filaments pour qu'elle soit suivie.</div>` : ''}
    ${s.rfid_candidates && s.rfid_candidates.length ? `<div class="mut sm" style="color:var(--warn)">Étiquette lue : plusieurs bobines identiques possibles (#${s.rfid_candidates.join(', #')}), choisis la bonne ci-dessous.</div>` : ''}
    ${s.empty ? `<div class="ci mut"><span class="el">Aucune bobine dans cet emplacement</span></div>
      <div class="sb2"><div class="nm mut">Emplacement vide</div></div><div class="big3 mut">–</div>${bar(0)}`
    : slotInfo(s, x) + (x ? `<div class="sb2">${swatch(x.color_hex, x.color_hexes)}<div class="nm"><b>${esc(x.vendor_name)} ${esc(x.filament_name)}</b><div class="mut">${esc(x.material)}${x.finish ? ' · ' + esc(x.finish) : ''} · #${x.id}</div></div></div>
      <div class="big3 ${spLow(x)}">${g(x.remaining_weight)}</div>${bar(x.remaining_pct, x.low)}${syncLine(s, b.slots)}` : '<div class="sb2"><div class="nm mut">Aucune bobine associée</div></div><div class="big3 mut">–</div>' + bar(0))}
    <select data-slot="${s.slot}"><option value="">— aucune bobine —</option>${spools.map(y => `<option value="${y.id}" ${y.id === s.sid && !s.empty ? 'selected' : ''}>#${y.id} ${esc(y.vendor_name)} ${esc(y.filament_name)} (${g(y.remaining_weight)})</option>`).join('')}</select></div>`; }).join('')}</div></div>`;
  const hg = $('#heatgo'), hs = $('#heatstop');
  if (hg) hg.onclick = () => act(async () => { await api('/box/heat', {method: 'POST', body: {temp: +$('#heatt').value, hours: +$('#heath').value, hum_stop: +$('#heatu').value}}); route(); }, 'Séchage démarré');
  if (hs) hs.onclick = async () => { if (hp.pending_print && !confirm('Arrêter le séchage annule aussi l\'impression programmée. Continuer ?')) return;
    act(async () => { await api('/box/heat/stop', {method: 'POST'}); if (hp.pending_print) await api('/files/print/pending', {method: 'DELETE'}); route(); }, 'Séchage arrêté'); };
  const px = $('#pendx'); if (px) px.onclick = () => act(async () => { await api('/files/print/pending', {method: 'DELETE'}); route(); }, 'Impression programmée annulée');
  el.querySelectorAll('select[data-slot]').forEach(x => x.onchange = () => act(async () => { await api('/box/slots/' + x.dataset.slot, {method: 'PUT', body: {spool_id: x.value ? Number(x.value) : null}}); route(); }, 'Association enregistrée'));
  el.querySelectorAll('[data-relay]').forEach(x => x.onchange = () => { if (x.value === '') return; act(async () => { x.disabled = true; try { await api('/box/slots/' + x.dataset.relay + '/relay', {method: 'POST', body: {source: Number(x.value)}}); } finally { x.disabled = false; } route(); }, 'Bobine de relais déclarée'); });
  el.querySelectorAll('[data-sync]').forEach(x => x.onclick = () => act(async () => { x.disabled = true; try { await api('/box/slots/' + x.dataset.sync + '/sync', {method: 'POST'}); } finally { x.disabled = false; } route(); }, 'Imprimante synchronisée'));
  el.querySelectorAll('[data-pin]').forEach(p => p.onclick = () => { const c = $('#sc' + p.dataset.pin); c.scrollIntoView({behavior: 'smooth', block: 'center'}); c.classList.add('fl'); setTimeout(() => c.classList.remove('fl'), 900); });
};


// ---------- étiquettes RFID (QIDI Box, format BoxRFID : MIFARE Classic 1K, bloc 4 = matière / couleur / marque) ----------
const RF = {sid: null, q: ''};
routes.rfid = async (el, rest) => {
  if (rest && rest[0]) RF.sid = Number(rest[0]) || RF.sid;
  const [info, spools, st] = await Promise.all([api('/rfid'), api('/spools'), api('/settings')]);
  const C = info.codes, w = info.writer;
  const tagged = Object.fromEntries(info.tags.map(t => [t.spool_id, t]));
  const live = spools.filter(x => !x.archived);
  const spName = x => `${x.vendor_name || ''} ${fName(x.filament_name)}`.trim();
  const mode = st.rfid_writer || '';
  const modeKind = mode === '' ? 'none' : mode === 'pcsc' ? 'pcsc' : mode === 'mock' ? 'mock' : 'http';
  const wState = !w ? `<span class="tag warn">aucun lecteur</span>` : w.ok ? (w.card ? `<span class="tag ok">étiquette posée</span>` : `<span class="tag">prêt · pose une étiquette</span>`) : `<span class="tag bad">${esc(w.error || 'indisponible')}</span>`;
  el.innerHTML = `<div class="rfp"><div class="bar"><h1 style="margin:0">Étiquettes RFID</h1><span class="sp"></span><span class="mut">Codes : ${esc(info.source)} · ${Object.keys(C.materials).length} matières, ${Object.keys(C.colors).length} couleurs, ${Object.keys(C.vendors).length} marques</span></div>
  <div class="card rfh"><div><b>Comment ça marche</b><p class="mut sm">Choisis une bobine, pose une étiquette MIFARE Classic 1K sur le lecteur et écris-la. Colle l'étiquette sur la bobine : quand tu la mets dans la QIDI Box, la Box lit marque, matière et couleur, et PrintLab associe automatiquement la bonne bobine à l'emplacement (stock et Slicer à jour).</p>
    <p class="mut sm">L'iPhone ne sait pas écrire ces étiquettes (limite d'Apple pour le MIFARE Classic) : l'écriture passe par un petit lecteur, piloté depuis cette page sur ton téléphone.</p></div>
    <div class="rfw"><div class="sh"><b>Lecteur</b>${wState}</div>
      <select id="rfmode"><option value="none">Aucun</option><option value="pcsc">Lecteur USB sur le serveur (ACR122U…)</option><option value="http">Module Wi-Fi ESP32 + PN532</option><option value="mock">Étiquette simulée (essai)</option></select>
      <input id="rfurl" placeholder="http://192.168.1.x" value="${modeKind === 'http' ? esc(mode) : ''}" ${modeKind === 'http' ? '' : 'hidden'}>
      <label class="mut sm" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="rfauto" ${st.rfid_autolink ? 'checked' : ''}> Associer automatiquement à la lecture par la Box</label>
      <div class="row gap"><button class="btn" id="rfsave">Enregistrer</button><button class="btn" id="rfread" ${w && w.ok ? '' : 'disabled'}>Lire l'étiquette posée</button></div></div></div>
  <div class="rfgrid"><div class="card"><h2 style="margin-top:0">1. Bobine</h2><input id="rfq" placeholder="Rechercher une bobine…" value="${esc(RF.q)}">
      <div class="rfl" id="rfl"></div></div>
    <div class="card" id="rfform"><p class="mut">Choisis une bobine à gauche.</p></div></div>
  <div class="card"><h2 style="margin-top:0">Bobines étiquetées (${info.tags.length})</h2>${info.tags.length ? `<div class="tw"><table><thead><tr><th>Bobine</th><th>Ce que lit la Box</th><th>Écrite le</th><th></th></tr></thead><tbody>${info.tags.map(t => { const x = spools.find(y => y.id === t.spool_id); return `<tr><td>${x ? swatch(x.color_hex) + ' #' + x.id + ' ' + esc(spName(x)) : '#' + t.spool_id}${x && x.slot != null ? ` <span class="tag ok">Box ${slotName(x.slot)}</span>` : ''}</td><td>${rfSig(t.sig)}</td><td>${dt(t.written)}</td><td><button class="btn small" data-rfedit="${t.spool_id}">Réécrire</button> <button class="btn small" data-rfdel="${t.spool_id}">Oublier</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="mut">Aucune étiquette écrite pour le moment.</p>'}
    ${info.events.length ? `<h3>Associations automatiques récentes</h3>${info.events.slice(0, 8).map(e => { const x = spools.find(y => y.id === e.spool_id); return `<div class="mut sm">${dt(e.ts)} · Box ${slotName(e.slot)} ← ${x ? '#' + x.id + ' ' + esc(spName(x)) : '#' + e.spool_id}</div>`; }).join('')}` : ''}</div></div>`;
  $('#rfmode').value = modeKind;
  $('#rfmode').onchange = () => { $('#rfurl').hidden = $('#rfmode').value !== 'http'; };
  $('#rfsave').onclick = () => act(async () => {
    const k = $('#rfmode').value, v = k === 'none' ? '' : k === 'http' ? $('#rfurl').value.trim() : k;
    if (k === 'http' && !/^https?:\/\//.test(v)) throw new Error('Adresse du module : http://…');
    await api('/settings', {method: 'PUT', body: {rfid_writer: v, rfid_autolink: $('#rfauto').checked}}); route();
  }, 'Lecteur enregistré');
  $('#rfread').onclick = () => act(async () => {
    const r = await api('/rfid/read', {method: 'POST'});
    const x = r.spools.map(id => spools.find(y => y.id === id)).filter(Boolean);
    modal(`<h2>Étiquette ${esc(r.uid || '')}</h2>${r.blank ? '<p>Étiquette vierge.</p>' : `<p>La Box lira : ${rfSig(r.sig)}</p><p class="mut sm">Codes : matière ${r.codes.material}, couleur ${r.codes.color}, marque ${r.codes.vendor}</p>
      <p>${x.length ? 'Bobine(s) PrintLab correspondante(s) : ' + x.map(y => '#' + y.id + ' ' + esc(spName(y))).join(', ') : 'Aucune bobine PrintLab ne porte cette étiquette.'}</p>`}<div class="row gap" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Fermer</button></div>`);
  });
  el.querySelectorAll('[data-rfdel]').forEach(b => b.onclick = async () => { if (!confirm('Oublier cette étiquette ? (l\'étiquette physique n\'est pas effacée)')) return; await act(() => api('/rfid/tags/' + b.dataset.rfdel, {method: 'DELETE'}), 'Étiquette oubliée'); route(); });
  el.querySelectorAll('[data-rfedit]').forEach(b => b.onclick = () => { RF.sid = Number(b.dataset.rfedit); route(); scrollTo({top: 0, behavior: 'smooth'}); });
  const list = () => {
    const q = RF.q.toLowerCase();
    $('#rfl').innerHTML = live.filter(x => !q || `${x.id} ${spName(x)} ${x.material} ${x.location || ''}`.toLowerCase().includes(q)).slice(0, 60).map(x =>
      `<button class="rfi ${x.id === RF.sid ? 'on' : ''}" data-sid="${x.id}">${swatch(x.color_hex, x.color_hexes)}<span class="el"><b>#${x.id} ${esc(spName(x))}</b><span class="mut sm">${esc(x.material || '')} · ${g(x.remaining_weight)}${x.slot != null ? ' · Box ' + slotName(x.slot) : ''}</span></span>${tagged[x.id] ? '<span class="tag ok">RFID</span>' : ''}</button>`).join('') || '<p class="mut">Aucune bobine</p>';
    $('#rfl').querySelectorAll('[data-sid]').forEach(b => b.onclick = () => { RF.sid = Number(b.dataset.sid); list(); form(); });
  };
  $('#rfq').oninput = e => { RF.q = e.target.value; list(); };
  const form = async () => {
    const x = live.find(y => y.id === RF.sid);
    if (!x) return;
    const sg = await api('/rfid/suggest/' + x.id), v = sg.current || sg.suggest;
    const mats = Object.entries(C.materials).sort((a, b) => a[1].filament.localeCompare(b[1].filament));
    $('#rfform').innerHTML = `<h2 style="margin-top:0">2. Étiquette de #${x.id} ${esc(spName(x))}</h2>
      <p class="mut sm">${sg.current ? 'Cette bobine a déjà une étiquette : tu peux la réécrire.' : 'Valeurs proposées d\'après la bobine : vérifie-les.'} La Box ne connaît que ces listes (fichier officiall_filas_list.cfg de l'imprimante).</p>
      <label>Marque<select id="rfv">${Object.entries(C.vendors).map(([n, name]) => `<option value="${n}">${esc(name)}</option>`).join('')}</select></label>
      <label>Matière<select id="rfm">${mats.map(([n, m]) => `<option value="${n}">${esc(m.filament)} (${esc(m.type)}, ${m.min_temp}–${m.max_temp} °C)</option>`).join('')}</select></label>
      <div><span class="lbl">Couleur <span class="mut sm">(la plus proche de la bobine est proposée)</span></span><div class="rfc">${Object.entries(C.colors).map(([n, h]) => `<button type="button" data-col="${n}" title="${h}" style="background:${h}"></button>`).join('')}</div></div>
      <div class="rfprev" id="rfprev"></div>
      <div class="row gap" style="justify-content:flex-end"><button class="btn primary" id="rfgo" ${w && w.ok ? '' : 'disabled title="Configure un lecteur"'}>Écrire l'étiquette</button></div>`;
    let col = v.color;
    $('#rfv').value = v.vendor ?? 0; $('#rfm').value = v.material ?? '';
    const prev = () => {
      $('#rfform').querySelectorAll('[data-col]').forEach(b => b.classList.toggle('on', Number(b.dataset.col) === col));
      const m = C.materials[$('#rfm').value] || {};
      $('#rfprev').innerHTML = `La Box affichera : <b>${esc(C.vendors[$('#rfv').value] || '')} ${esc(m.filament || '')}</b> <span class="sw" style="background:${C.colors[col] || 'transparent'}"></span> <span class="mut sm">(couleur bobine : ${x.color_hex ? '#' + esc(x.color_hex) : '?'})</span>`;
    };
    $('#rfform').querySelectorAll('[data-col]').forEach(b => b.onclick = () => { col = Number(b.dataset.col); prev(); });
    $('#rfv').onchange = prev; $('#rfm').onchange = prev; prev();
    $('#rfgo').onclick = () => act(async () => {
      $('#rfgo').disabled = true; $('#rfgo').textContent = 'Écriture… garde l\'étiquette sur le lecteur';
      try { await api('/rfid/write', {method: 'POST', body: {spool_id: x.id, material: Number($('#rfm').value), color: col, vendor: Number($('#rfv').value)}}); }
      finally { $('#rfgo').disabled = false; $('#rfgo').textContent = 'Écrire l\'étiquette'; }
      route();
    }, 'Étiquette écrite ✔ colle-la sur la bobine');
  };
  list(); if (RF.sid) form();
};
const rfSig = s => s ? `${esc(s.vendor)} · ${esc(s.filament)} <span class="sw" style="background:${esc(s.color)}"></span>` : '–';


// ---------- atelier : entretien, firmware, santé, mods et astuces (sources : wikis QIDI et communautaire) ----------
routes.workshop = async (el) => {
  const d = await api('/workshop');
  const h = d.health || {};
  const tag = (ok, t) => `<span class="tag ${ok ? 'ok' : 'warn'}">${esc(t)}</span>`;
  const due = d.tasks.filter(t => t.due).length;
  const latest = d.releases[0];
  const fwOk = latest && d.firmware && latest.tag === d.firmware.trim();
  const cats = [...new Set(d.mods.map(m => m.cat))];
  el.innerHTML = `<div class="wsp"><div class="bar"><h1 style="margin:0">Atelier</h1><span class="sp"></span><span class="mut">QIDI Max 4 + QIDI Box · ${fmt(d.hours, 0)} h d'impression au compteur</span></div>
  ${d.error ? `<div class="card err">Imprimante injoignable : ${esc(d.error)} (heures estimées depuis l'historique PrintLab)</div>` : ''}
  <div class="wsg">
    <div class="card"><h2 style="margin-top:0">Entretien ${due ? tag(false, due + ' à faire') : tag(true, 'à jour')}</h2>
      <p class="mut sm">Échéances d'après le manuel QIDI et le wiki de la communauté, sur tes vraies heures d'impression.</p>
      ${d.tasks.map(t => `<div class="wst ${t.due ? 'due' : ''}"><div class="wsh"><b>${esc(t.name)}</b><button class="btn small" data-done="${t.id}">Fait</button></div>
        ${bar(Math.min(100, t.ratio * 100), t.due)}<div class="mut sm">${t.due ? '<b style="color:var(--warn)">À faire</b>' : 'Reste ' + esc(t.left)}${t.done_t ? ' · fait le ' + dt(t.done_t) : ''} · <a href="${esc(t.link)}" target="_blank" rel="noopener">guide</a></div>
        <div class="mut sm">${esc(t.info)}</div></div>`).join('')}</div>
    <div>
      <div class="card"><h2 style="margin-top:0">Santé de la machine</h2>
        <div class="wsk">${[['Mémoire libre', h.mem_mb != null ? h.mem_mb + ' Mo' : '–', h.mem_mb != null && h.mem_mb < 150], ['Charge système', h.load ?? '–', h.load > 3],
          ['Chambre', h.chamber != null ? fmt(h.chamber, 1) + ' °C' : '–'], ['Chambre (max mesuré)', h.chamber_max != null ? fmt(h.chamber_max, 0) + ' °C' : '–'],
          ['Box', h.box_temp != null ? fmt(h.box_temp, 1) + ' °C · ' + fmt(h.box_hum, 0) + ' %RH' : '–', h.box_hum >= 40],
          ['Impressions', h.jobs ?? '–'], ['Filament utilisé', h.filament_km != null ? fmt(h.filament_km, 2) + ' km' : '–'], ['Plus longue impression', h.longest_h != null ? fmt(h.longest_h, 1) + ' h' : '–']]
          .map(([k, v, bad]) => `<div><small>${k}</small><b class="${bad ? 'warn' : ''}">${esc(String(v))}</b></div>`).join('')}</div>
        <p class="mut sm">Lecture seule (Moonraker). La carte mère de la Max 4 a peu de mémoire : sous ~150 Mo libres, l'interface et Klipper ralentissent.</p></div>
      <div class="card"><h2 style="margin-top:0">Firmware</h2>
        <label class="mut sm">Version installée (écran → À propos)<input id="wsfw" value="${esc(d.firmware)}" placeholder="ex. 01.01.06.05" style="width:100%"></label>
        <p>${latest ? `Dernière version suivie par la communauté : <b>${esc(latest.tag)}</b> (${esc(latest.date)}) ${d.firmware ? (fwOk ? tag(true, 'à jour') : tag(false, 'mise à jour possible')) : ''} · <a href="${esc(latest.url)}" target="_blank" rel="noopener">notes</a>` : '<span class="mut">Liste des versions indisponible</span>'}</p>
        <p class="mut sm">⚠ Pas de retour en arrière ; coupe la Box pendant la mise à jour ; tes configs personnelles (macros, correctifs) sont effacées — elles restent dans les sauvegardes PrintLab (Imprimante → Fichiers &amp; sauvegardes).</p></div>
    </div>
  </div>
  <div class="card"><h2 style="margin-top:0">Améliorations conseillées</h2><p class="mut sm">Sélection de la communauté Max 4 (les mods Q2 / Plus4 ne vont pas sur la Max 4). Coche ce que tu as fait.</p>
    ${cats.map(c => `<h3>${esc(c)}</h3>${d.mods.filter(m => m.cat === c).map(m => `<label class="wsm"><input type="checkbox" data-mod="${m.id}" ${d.mods_done[m.id] ? 'checked' : ''}><span><b>${esc(m.name)}</b> <a href="${esc(m.link)}" target="_blank" rel="noopener">↗</a><br><span class="mut sm">${esc(m.why)}</span></span></label>`).join('')}`).join('')}</div>
  <div class="card"><h2 style="margin-top:0">Astuces</h2>${d.tips.map(t => `<div class="wsti"><b>${esc(t.title)}</b> <a href="${esc(t.link)}" target="_blank" rel="noopener">↗</a><div class="mut sm">${esc(t.text)}</div></div>`).join('')}
    <p class="mut sm">Sources : <a href="https://github.com/thelegendtubaguy/QidiMax4CommunityWiki" target="_blank" rel="noopener">wiki communautaire Max 4</a> · <a href="https://wiki.qidi3d.com/en/Max4/X-Max4" target="_blank" rel="noopener">wiki QIDI</a> · <a href="https://www.reddit.com/r/QIDI_Max4/" target="_blank" rel="noopener">r/QIDI_Max4</a></p></div></div>`;
  el.querySelectorAll('[data-done]').forEach(b => b.onclick = () => act(async () => { await api('/workshop/tasks/' + b.dataset.done, {method: 'POST'}); route(); }, 'Noté'));
  el.querySelectorAll('[data-mod]').forEach(c => c.onchange = () => act(() => api('/workshop', {method: 'PUT', body: {mod: c.dataset.mod, done: c.checked}})));
  $('#wsfw').onchange = () => act(async () => { await api('/workshop', {method: 'PUT', body: {firmware: $('#wsfw').value.trim()}}); route(); }, 'Version enregistrée');
};


// ---------- impressions ----------
const trkParts = t => (t.parts || []).map(p => `<div>${p.slot === 'ext' ? 'Hors Box' : slotName(Number(p.slot))} : ${fmt(p.weight, 1)} g <span class="mut">(${fmt(p.mm / 1000, 2)} m)</span> ${p.spool_id ? '→ <a href="#/spools">#' + p.spool_id + '</a>' : '<span class="mut">→ aucune bobine associée</span>'}</div>`).join('') || '<span class="mut">–</span>' + trkEvents(t);
const trkEvents = t => (t.events || []).filter(e => e.kind === 'runout').map(e => `<div class="tag warn" style="margin-top:3px" title="La Box a basculé seule sur une bobine identique : la bobine de départ est vide${e.corrected_g != null ? ` (PrintLab pensait qu'il restait ${fmt(e.corrected_g, 1)} g)` : ''}">↻ bobine vide ${slotName(Number(e.slot))} → relais ${slotName(Number(e.to))}${e.spool_id ? ' · #' + e.spool_id + ' passée à 0 g' : ''}</div>`).join('');
async function trkUndo(id) { if (!confirm('Annuler la déduction de cette impression sur le stock ?')) return; await act(() => api('/tracks/' + id + '/undo', {method: 'POST'}), 'Déduction annulée'); route(); }
async function trkApply(id) { await act(() => api('/tracks/' + id + '/apply', {method: 'POST', body: {}}), 'Déduit du stock'); route(); }
const JOB_ST = {completed: ['terminée', 'ok'], cancelled: ['annulée', ''], error: ['erreur', 'bad'], klippy_shutdown: ['arrêt Klipper', 'bad'], interrupted: ['interrompue', 'warn'], in_progress: ['en cours', 'ok'], server_exit: ['arrêt serveur', 'warn']};
const jobSt = s => { const [l, c] = JOB_ST[s] || [s || '?', '']; return `<span class="tag ${c}">${esc(l)}</span>`; };
let jobsAll = false;
// ---------- journal des impressions : une carte par impression suivie ----------
let jrnN = 20;
const RATE = {ok: ['★ réussie', 'ok'], bof: ['◐ moyenne', 'warn'], 'raté': ['✕ ratée', 'bad']};
const jCard = (t, W) => {
  const m = t.meta || {}, el2 = m.elec || {}, d = t.ended ? t.ended - t.started : null, f = t.file;
  const evs = (t.events || []).filter(e => e.kind === 'runout');
  const parts = (t.parts || []).map(p => `<div class="jpart">${swatch(p.color_hex)}<span class="ell">${p.slot === 'ext' ? 'Hors Box' : boxLbl(+p.slot)} · ${esc(p.label || 'aucune bobine associée')}</span>
    <b>${fmt(p.weight, 1)} g</b><span class="mut">${p.cost != null ? eur(p.cost) : ''}</span>${evs.some(e => e.to === p.slot) ? '<span class="tag" title="Bobine de relais : la Box a basculé dessus">↻ relais</span>' : ''}${evs.some(e => e.slot === p.slot) ? '<span class="tag warn">vidée</span>' : ''}</div>`).join('');
  const tot = (t.cost_mat || 0) + (el2.eur || 0);
  return `<div class="card jcard" data-t="${t.id}">
    <div class="jth">${f && f.thumb ? `<img src="/api/files/thumb?path=${encodeURIComponent(f.path)}&m=${Math.round(f.modified)}" alt="" loading="lazy">` : '<span class="mut sm">pas d\'aperçu</span>'}</div>
    <div class="jb"><div class="jh"><b class="ell">${esc(flName(t.filename || '?'))}</b><span class="mut">${dt(t.started)}${d ? ' · ' + dur(d) : ''}</span>
      <span class="tag ${t.status === 'terminée' ? 'ok' : 'warn'}">${esc(t.status)}</span>${m.rating ? `<span class="tag ${RATE[m.rating][1]}">${RATE[m.rating][0]}</span>` : ''}${t.partial ? '<span class="tag warn" title="Suivi démarré en cours d\'impression">partiel</span>' : ''}</div>
      ${parts || '<div class="mut">Aucune consommation mesurée.</div>'}
      <div class="jcost">Matière <b>${eur(t.cost_mat)}</b>${el2.eur != null ? ` · Électricité <b>${eur(el2.eur)}</b> <span class="mut">(${fmt(el2.kwh, 2)} kWh)</span>` : ''} · Total <b>${eur(tot)}</b>${t.applied ? '' : ' <span class="tag">non déduit du stock</span>'}</div>
      ${m.note ? `<div class="jnote">« ${esc(m.note)} »</div>` : ''}
      <div class="jact">${t.timelapse ? `<button class="btn sm primary" data-tl="${esc(t.timelapse)}">▶ Timelapse</button>` : ''}<button class="btn sm" data-rate="${t.id}">Noter</button>
        ${f && W ? `<button class="btn sm" data-again="${t.id}">Relancer</button>` : ''}
        ${t.applied ? `<button class="btn sm" onclick="trkUndo(${t.id})">Annuler la déduction</button>` : `<button class="btn sm" onclick="trkApply(${t.id})">Déduire du stock</button>`}</div></div></div>`;
};
routes.jobs = async (el) => {
  const [j, tli] = await Promise.all([api('/journal?limit=' + jrnN), api('/timelapse').catch(() => null)]);
  const W = j.write;
  el.innerHTML = `<div class="bar"><h1 style="margin:0">Impressions</h1><span class="sp"></span><a class="btn" href="#/jobs-raw">Historique brut de l'imprimante</a></div>
    <p class="mut" style="margin-top:-4px">Une carte par impression suivie par PrintLab : consommation par bobine, coût matière (prix payé) et électrique (compteurs Home Assistant), timelapse de l'imprimante, ta note.</p>
    <div class="jlist">${j.items.map(t => jCard(t, W)).join('') || '<p class="mut">Aucune impression suivie pour l\'instant.</p>'}</div>
    ${j.total > j.items.length ? `<div style="text-align:center;margin:12px 0"><button class="btn" id="jmore">Afficher plus (${j.total - j.items.length} de plus)</button></div>` : ''}
    ${tli ? `<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="flex:1;min-width:240px"><b>Timelapses sur l'imprimante :</b> ${tli.count} vidéos · ${fmt(tli.size / 1e9, 2)} Go${tli.oldest ? ` · le plus ancien du ${new Date(tli.oldest * 1000).toLocaleDateString((window.PL_LOCALE || 'fr-FR'))}` : ''}</span>
      ${tli.write ? `<label class="ctl">Supprimer ceux de plus de <select id="tlage"><option value="30">1 mois</option><option value="90" selected>3 mois</option><option value="180">6 mois</option></select></label><button class="btn danger" id="tlclean">Supprimer</button>` : '<span class="mut">Suppression : active les actions d\'écriture (Paramètres).</span>'}</div>` : ''}`;
  const more = $('#jmore'); if (more) more.onclick = () => { jrnN += 20; route(); };
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tl) {
      modal(`<h2>Timelapse</h2><video src="/api/timelapse/video?path=${encodeURIComponent(b.dataset.tl)}" controls autoplay playsinline style="width:100%;max-height:70vh;background:#000;border-radius:6px"></video>
        <div class="acts"><a class="btn" href="/api/timelapse/video?path=${encodeURIComponent(b.dataset.tl)}" download="${esc(b.dataset.tl)}">Télécharger</a><button class="btn primary" onclick="closeModal()">Fermer</button></div>`);
      $('#modal').addEventListener('click', () => { if ($('#modal').hidden) $('#modal video')?.pause(); });
    } else if (b.dataset.rate) {
      const t = j.items.find(x => x.id === +b.dataset.rate), m = t.meta || {};
      modal(`<h2>Noter « ${esc(flName(t.filename))} »</h2><div class="chips" id="rt">${Object.entries(RATE).map(([k, [l]]) => `<button class="chip ${m.rating === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
        <textarea id="rn" rows="4" style="width:100%;margin-top:10px" placeholder="Remarque (warping, réglage à refaire…)">${esc(m.note || '')}</textarea>
        <div class="acts"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" id="rok">Enregistrer</button></div>`);
      let k = m.rating || null;
      document.querySelectorAll('#rt [data-k]').forEach(c => c.onclick = () => { k = k === c.dataset.k ? null : c.dataset.k; document.querySelectorAll('#rt [data-k]').forEach(x => x.classList.toggle('on', x.dataset.k === k)); });
      $('#rok').onclick = () => act(async () => { await api(`/tracks/${t.id}/meta`, {method: 'PUT', body: {rating: k, note: $('#rn').value}}); closeModal(); route(); }, 'Enregistré');
    } else if (b.dataset.again) {
      const t = j.items.find(x => x.id === +b.dataset.again);
      const ch = await mapDialog('Relancer l\'impression', `Relancer « <b>${esc(flName(t.file.path))}</b> » sur la QIDI ? Vérifie que le plateau est dégagé.`, t.file.filaments || [], 'Imprimer', {secs: flTime(t.file)});
      if (ch && await act(() => api('/files/print', {method: 'POST', body: {path: t.file.path, mapping: ch.map, relays: ch.relays, dry: ch.dry}}), printMsg(ch))) location.hash = printDest(ch);
    } else if (b.id === 'tlclean') {
      const days = +$('#tlage').value;
      if (!confirm(`Supprimer définitivement de l'imprimante les timelapses de plus de ${days} jours ?`)) return;
      b.disabled = true; b.textContent = 'Suppression…';
      try { const r = await api('/timelapse/cleanup', {method: 'POST', body: {days}}); toast(`${r.deleted} timelapse(s) supprimé(s) · ${fmt(r.freed / 1e6, 0)} Mo libérés`); route(); }
      catch (x) { toast(x.message); b.disabled = false; b.textContent = 'Supprimer'; }
    }
  };
};
routes['jobs-raw'] = async (el) => {
  const [r, tk] = await Promise.all([api('/jobs'), api('/tracks')]);
  const trk = `<h2 style="margin-top:18px">Suivi automatique de la consommation</h2>
  <p class="mut">PrintLab observe l'imprimante (lecture seule) et compte le filament utilisé par emplacement de la Box, en ignorant les changements de filament. ${tk.auto ? 'La consommation est déduite automatiquement des bobines associées aux emplacements.' : 'La déduction automatique est désactivée (Paramètres) : utilise « Déduire ».'}${tk.error ? ` <span class="err">Imprimante : ${esc(tk.error)}</span>` : ''}</p>
  ${tk.live ? `<div class="card"><b>En cours :</b> ${esc(tk.live.filename)}<div class="mut">${trkParts(tk.live)}</div>${tk.live.partial ? '<div class="mut">Suivi démarré en cours d\'impression : la consommation avant ce moment n\'est pas comptée.</div>' : ''}</div>` : ''}
  <div class="card tw"><table><thead><tr><th>Date</th><th>Fichier</th><th>Statut</th><th>Consommation par emplacement</th><th>Stock</th><th></th></tr></thead><tbody>
  ${tk.tracks.map(t => `<tr><td>${dt(t.started)}</td><td>${esc(t.filename)}${t.partial ? ' <span class="tag warn">partiel</span>' : ''}</td><td><span class="tag ${t.status === 'terminée' ? 'ok' : 'warn'}">${esc(t.status)}</span></td><td>${trkParts(t)}</td>
  <td>${t.applied ? '<span class="tag ok">déduit</span>' : '<span class="tag">non déduit</span>'}</td>
  <td>${t.applied ? `<button class="btn sm" onclick="trkUndo(${t.id})">Annuler la déduction</button>` : `<button class="btn sm" onclick="trkApply(${t.id})">Déduire</button>`}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">Aucune impression suivie pour l\'instant.</td></tr>'}</tbody></table></div>`;
  el.innerHTML = `<div class="bar"><h1 style="margin:0">Historique brut</h1><span class="sp"></span><a class="btn" href="#/jobs">← Journal des impressions</a></div>${trk}<h2 style="margin-top:22px">Historique de l'imprimante</h2>${r.error ? `<p class="err">Moonraker : ${esc(r.error)}</p>` : ''}
  <p class="mut">Historique lu depuis l'imprimante. « Imputer » répartit le poids sur une ou plusieurs bobines (les imputations se retrouvent dans l'historique de chaque bobine).</p>
  <div class="card tw"><table><thead><tr><th>Date</th><th>Fichier</th><th>Statut</th><th class="r">Durée</th><th class="r">Filament</th><th class="r">Imputé</th><th></th></tr></thead><tbody>
  ${(jobsAll ? r.jobs : r.jobs.slice(0, 25)).map(j => `<tr><td>${dt(j.start_time)}</td><td>${esc(j.filename)}</td><td>${jobSt(j.status)}</td><td class="r">${dur(j.print_duration)}</td>
  <td class="r">${fmt(j.filament_mm / 1000, 1)} m · ≈${g(j.filament_g)}</td><td class="r">${j.tracked_g != null ? `<span class="tag ok" title="Déduit par le suivi automatique">${g(j.tracked_g)} · suivi</span>` : g(j.assigned_g)}</td>
  <td>${j.tracked_g != null || j.status === 'in_progress' ? '' : `<button class="btn sm" data-job="${esc(j.job_id)}">Imputer</button>`}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">Aucune impression.</td></tr>'}</tbody></table>
  ${!jobsAll && r.jobs.length > 25 ? `<div style="text-align:center;margin-top:10px"><button class="btn" id="jall">Afficher les ${r.jobs.length} impressions</button></div>` : ''}</div>`;
  el.querySelectorAll('[data-job]').forEach(b => b.onclick = () => jobAssign(r.jobs.find(j => j.job_id === b.dataset.job)));
  if ($('#jall')) $('#jall').onclick = () => { jobsAll = true; route(); };
};
window.jobAssign = async j => {
  const sp = await api('/spools');
  const row = (i) => `<div class="bar"><select class="as">${sp.map(x => `<option value="${x.id}" ${x.id === (j.spool_ids[0]) ? 'selected' : ''}>#${x.id} ${esc(x.vendor_name)} ${esc(x.filament_name)}</option>`).join('')}</select>
    <input class="aw" type="number" step="any" placeholder="g" style="width:80px" value="${i === 0 ? Math.round(j.filament_g * 10) / 10 : ''}"></div>`;
  modal(`<h2>Imputer « ${esc(j.filename)} »</h2><p class="mut">Estimation : ≈ ${g(j.filament_g)} (ABS/PLA standard 1,75 mm). Ajuste selon ton slicer.</p>
    <div id="rows">${row(0)}${row(1)}${row(2)}</div><div class="acts"><button class="btn" onclick="closeModal()">Annuler</button><button class="btn primary" id="ok">Enregistrer</button></div>`);
  $('#ok').onclick = async () => {
    const parts = [...document.querySelectorAll('#rows .bar')].map(r => ({spool_id: Number(r.querySelector('.as').value), weight: Number(r.querySelector('.aw').value)})).filter(p => p.weight > 0);
    if (await act(() => api(`/jobs/${j.job_id}/assign`, {method: 'POST', body: {parts}}), 'Imputation enregistrée')) { closeModal(); route(); }
  };
};

// ---------- paramètres ----------
const putSetting = async (k, v) => { S = await api('/settings', {method: 'PUT', body: {[k]: v}}); };
// ---------- fichiers à imprimer (sur l'imprimante, lecture seule) ----------
// Vignettes façon bobines + panneau latéral de détail. Les infos viennent de l'archive .gcode.3mf (lue à distance par
// morceaux, rien n'est envoyé à l'imprimante), de l'historique Moonraker et du stock PrintLab (bobines correspondantes).
const FL_KEY = 'printlab.files';
const filesState = Object.assign({q: '', sort: 'modified', dir: -1, group: 'none', mat: '', sel: null, cwd: ''}, (() => { try { return JSON.parse(localStorage.getItem(FL_KEY)) || {}; } catch { return {}; } })());
filesState.sel = null; filesState.cwd = ''; filesState.pick = new Set();
const flDir = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const flSave = () => { try { localStorage.setItem(FL_KEY, JSON.stringify({sort: filesState.sort, dir: filesState.dir, group: filesState.group})); } catch {} };
const flName = p => p.split('/').pop().replace(/\.gcode\.3mf$|\.3mf$|\.gcode$/i, '');
const flTime = f => f.info && (f.info.prediction || (f.info.moonraker || {}).estimated_time);
const flWeight = f => f.info && (f.info.weight ?? (f.info.moonraker || {}).filament_weight_total);
const flFils = f => (f.info && f.info.filaments) || [];
const FL_SORT = {modified: ['Date du fichier', f => f.modified], name: ['Nom', f => flName(f.path).toLowerCase()], time: ['Durée', f => flTime(f) || 0],
  weight: ['Poids', f => flWeight(f) || 0], prints: ['Nb d\'impressions', f => (f.hist || {}).count || 0], last: ['Dernière impression', f => (f.hist || {}).last || 0]};
const FL_GROUP = {none: ['Aucun', () => ''], month: ['Mois', f => new Date(f.modified * 1000).toLocaleDateString((window.PL_LOCALE || 'fr-FR'), {month: 'long', year: 'numeric'})],
  colors: ['Nb de couleurs', f => { const n = flFils(f).length; return n ? (n > 1 ? n + ' couleurs' : '1 couleur') : 'Inconnu'; }],
  material: ['Matière', f => [...new Set(flFils(f).map(x => x.type).filter(Boolean))].join(' + ') || 'Inconnue'],
  printed: ['Déjà imprimé', f => (f.hist || {}).count ? 'Déjà imprimés' : 'Jamais imprimés'],
  dup: ['Doublons', f => { const k = flNorm(f); return (FL_DUPS.get(k) || 0) > 1 ? 'Doublons — ' + k : 'Sans doublon'; }]};
// même pièce envoyée plusieurs fois : nom sans suffixe de copie / plateau (« _1 », « (2) », « -copie », « _plate_2 »)
const flNorm = f => flName(f.path).toLowerCase().replace(/[_ -]*(\(\d+\)|copie|copy|plate_?\d+|_\d{1,2})$/g, '').replace(/[_ -]*(\(\d+\)|copie|copy|_\d{1,2})$/g, '').trim();
let FL_DUPS = new Map();
const dots = fl => `<span class="fdots">${fl.map(x => `<i style="background:${esc(x.color || '#888')}" title="${esc(x.type || '')} ${x.used_g != null ? fmt(x.used_g, 1) + ' g' : ''}"></i>`).join('')}</span>`;
const sizeH = b => b >= 1048576 ? fmt(b / 1048576, 1) + ' Mo' : fmt(b / 1024, 0) + ' ko';
const thumbUrl = f => `/api/files/thumb?path=${encodeURIComponent(f.path)}&m=${Math.round(f.modified)}`;
const BED = {textured_plate: 'PEI texturé', hot_plate: 'PEI lisse', cool_plate: 'Plateau froid', eng_plate: 'Plateau ingénierie', pc_plate: 'Plateau PC', pei_plate: 'PEI lisse'};
const WARN = {bed_temperature_too_high_than_filament: 'Température plateau au-dessus de celle conseillée pour un filament', filament_unprintable: 'Filament non imprimable', print_outside: 'Objet hors du plateau'};

// ---------- lancement d'un fichier : filaments du fichier → emplacements de la Box (même fenêtre que le Slicer, façon Orca) ----------
const EXT = 16;
const boxLbl = i => i === EXT ? 'Ext' : `${Math.floor(i / 4) + 1}${'ABCD'[i % 4]}`;
const rgbOf = h => { const m = /^#?([0-9a-f]{6})/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x808080; return [n >> 16, (n >> 8) & 255, n & 255]; };
const inkOf = h => { const [r, g0, b] = rgbOf(h); return 0.299 * r + 0.587 * g0 + 0.114 * b > 150 ? '#1b1b1b' : '#fff'; };
const cDist = (a, b) => { const p = rgbOf(a), q = rgbOf(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const printMsg = ch => ch.dry?.mode === 'before' ? 'Séchage démarré : l\'impression sera lancée à la fin' : ch.dry ? 'Séchage démarré, impression lancée' : 'Impression lancée';
const printDest = ch => ch.dry?.mode === 'before' ? '#/box' : '#/printer';
// séchage conseillé par matière : [température °C (max Box 65), durée h]
const DRY_MAT = [['PETG', 55, 4], ['PET', 60, 4], ['PLA', 45, 4], ['ABS', 60, 4], ['ASA', 60, 4], ['TPU', 50, 6], ['PVA', 50, 6], ['HIPS', 55, 4], ['PA', 65, 8], ['PC', 65, 6]];
const dryOf = t => DRY_MAT.find(([k]) => String(t || '').toUpperCase().startsWith(k));

async function mapDialog(title, intro, fl, okLabel, opts = {}) {
  const [box, spools, heat] = await Promise.all([api('/box'), api('/spools'), api('/box/heat').catch(() => ({}))]);
  const sp = Object.fromEntries(spools.map(x => [x.id, x]));
  const slots = (box.slots || []).map(x => ({index: x.slot, loaded: x.box_inserted !== false, type: (x.printer_type || '').toUpperCase(), color: '#' + (x.printer_color || '808080'),
    name: x.printer_filament_name || '', spool: x.spool_id ? sp[x.spool_id] : null, relay_of: x.relay_of}));
  const tools = fl.filter(x => x.used_g == null || x.used_g > 0).map(x => ({t: x.id - 1, type: String(x.type || '').toUpperCase(), color: x.color || '#808080', need: +(x.used_g || 0)}));
  const map = {};
  for (const x of tools) {
    const ok = s => s && s.loaded && s.type === x.type;
    map[x.t] = ok(slots[x.t]) ? x.t : (slots.filter(ok).sort((a, b) => cDist(a.color, x.color) - cDist(b.color, x.color))[0] || {index: x.t}).index;
  }
  const relays = {};
  return new Promise(resolve => {
    let done = false, pop = null;
    const fin = v => { if (done) return; done = true; pop?.remove(); document.removeEventListener('mousedown', out, true); closeModal(); resolve(v); };
    const out = e => { if (pop && !pop.contains(e.target)) { pop.remove(); pop = null; } };
    document.addEventListener('mousedown', out, true);
    modal(`<h2>${esc(title)}</h2><p>${intro}</p><div class="pmap"><div class="pmap-grid"><div class="pmap-lbl"><span>Fichier</span><span>Box</span></div><div class="pmap-cols"></div></div>
      <p class="mut sm">Clique sur une case de la Box pour choisir l'emplacement utilisé par chaque filament.</p><div class="pmap-warn"></div></div>
      <div class="pdry"></div>
      <div class="acts"><button class="btn" data-r="0">Annuler</button><button class="btn primary" data-r="1">${esc(okLabel)}</button></div>`);
    const M = $('#modal'), cols = M.querySelector('.pmap-cols');
    const info = i => i === EXT ? {index: EXT, loaded: true, type: '', color: '#F2F2F2', name: 'Bobine externe'} : slots[i] || {index: i, loaded: false, color: '#808080'};
    const relayHtml = () => {
      const res = [], seen = new Set(), mat = x => String(x?.material || '').toUpperCase().replace(/\+$/, '');
      for (const x of tools) {
        const m = map[x.t]; if (m === EXT || seen.has(m)) continue; seen.add(m);
        const need = tools.filter(y => map[y.t] === m).reduce((a, y) => a + y.need, 0), s0 = info(m).spool;
        if (!s0 || need <= 0) continue;
        const rem = s0.remaining_weight, est = s0.weight_src === 'estimated';
        if (!(rem < need * 1.05 || (est && rem < need * 1.5))) { delete relays[m]; continue; }
        const act0 = slots.find(y => y.index !== m && y.relay_of === m);
        if (act0) { res.push(`<div class="pmap-relay"><b>↻ Relais déjà actif</b> : si la ${boxLbl(m)} se vide, la Box continue avec la ${boxLbl(act0.index)}.</div>`); continue; }
        const c = slots.filter(y => y.index !== m && y.loaded && y.spool && mat(y.spool) === mat(s0) && cDist('#' + y.spool.color_hex, '#' + s0.color_hex) <= 60 && y.spool.remaining_weight >= need - Math.max(rem, 0))
          .sort((a, b) => b.spool.remaining_weight - a.spool.remaining_weight)[0];
        if (!c) { delete relays[m]; continue; }
        if (!relays[m] || relays[m].c !== c.index) relays[m] = {c: c.index, on: true};
        res.push(`<div class="pmap-relay"><b>↻ Relais possible</b> : la ${boxLbl(c.index)} contient aussi ${esc(s0.material || '')} de même couleur (${esc(c.spool.vendor_name || '')} ${esc(c.spool.filament_name || '')}, ${Math.round(c.spool.remaining_weight)} g).
          <label class="check"><input type="checkbox" data-relay="${m}" ${relays[m].on ? 'checked' : ''}> Si la ${boxLbl(m)} se vide, continuer avec la ${boxLbl(c.index)}</label></div>`);
      }
      return res.join('');
    };
    const render = () => {
      cols.innerHTML = tools.map(x => { const s1 = info(map[x.t]); return `<div class="pmap-col"><div class="pmap-orig" style="background:${esc(x.color)};color:${inkOf(x.color)}">${x.t + 1} ${esc(x.type || '?')}</div>
        <button class="pmap-slot" data-t="${x.t}" title="${esc(s1.name || '')}"><span class="pmap-spool" style="background:${esc(s1.color)}"></span><b>${boxLbl(map[x.t])}</b><span class="pmap-caret">▾</span></button></div>`; }).join('');
      cols.querySelectorAll('.pmap-slot').forEach(b => b.onclick = e => { e.stopPropagation(); openPop(+b.dataset.t, b); });
      const w = [];
      for (const x of tools) {
        const s1 = info(map[x.t]), L = boxLbl(map[x.t]);
        if (map[x.t] !== EXT && !s1.loaded) w.push(['warn', `Filament ${x.t + 1} → ${L} : emplacement vide dans la Box`]);
        else if (map[x.t] !== EXT && s1.type && x.type && s1.type.replace(/\+$/, '') !== x.type.replace(/\+$/, '')) w.push(['bad', `Filament ${x.t + 1} (${x.type}) → ${L} contient du ${s1.type}`]);
        const s0 = s1.spool;
        if (s0 && x.need > 0 && s0.remaining_weight < x.need) w.push(['bad', `${L} — ${s0.vendor_name || ''} ${s0.filament_name || ''} : ${s0.weight_src === 'estimated' ? '~' : ''}${Math.round(s0.remaining_weight)} g restants${s0.weight_src === 'estimated' ? ' (poids estimé)' : ''} pour ${fmt(x.need, 1)} g nécessaires`]);
      }
      M.querySelector('.pmap-warn').innerHTML = w.map(([k, m]) => `<p style="color:var(--${k});margin:6px 0 0">⚠ ${esc(m)}</p>`).join('') + relayHtml();
      M.querySelectorAll('[data-relay]').forEach(c => c.onchange = () => { relays[c.dataset.relay].on = c.checked; });
    };
    const openPop = (t, anchor) => {
      pop?.remove();
      pop = document.createElement('div'); pop.className = 'pmap-pop';
      const tile = s1 => `<button class="pmap-tile${s1.loaded ? '' : ' empty'}${map[t] === s1.index ? ' sel' : ''}" data-s="${s1.index}" style="background:${s1.loaded ? esc(s1.color) : 'transparent'};color:${s1.loaded ? inkOf(s1.color) : 'var(--mut)'}" title="${esc(s1.loaded ? s1.name : 'Emplacement vide')}"><span class="bar" style="background:${esc(s1.color)}"></span><b>${boxLbl(s1.index)}</b><span>${esc(s1.loaded ? s1.type || '?' : 'vide')}</span></button>`;
      pop.innerHTML = `<div class="pmap-sec">Box</div><div class="pmap-box"><div class="pmap-tiles">${slots.map(tile).join('')}</div><div class="pmap-boxname">QIDI-BOX</div></div>
        <div class="pmap-sec">Externe</div><button class="pmap-tile ext${map[t] === EXT ? ' sel' : ''}" data-s="${EXT}"><b>Ext</b></button>`;
      document.body.append(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (r.bottom + 6 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - 6 - pop.offsetHeight) : r.bottom + 6) + 'px';
      pop.querySelectorAll('[data-s]').forEach(b => b.onclick = e => { e.stopPropagation(); map[t] = +b.dataset.s; pop.remove(); pop = null; render(); });
    };
    // séchage de la Box avant ou pendant l'impression
    const D = M.querySelector('.pdry'), mats = tools.map(x => dryOf(x.type)).filter(Boolean);
    const dDef = mats.length ? {temp: Math.min(...mats.map(m => m[1])), hours: Math.max(...mats.map(m => m[2]))} : {temp: 50, hours: 4};
    const dry = {mode: 'none', temp: dDef.temp, hours: dDef.hours, hum_stop: 15};
    const hum = box.humidity != null ? +box.humidity : null, pend = heat.pending_print;
    const renderDry = () => {
      const chip = (k, l) => `<button class="chip ${dry.mode === k ? 'on' : ''}" data-dm="${k}"${pend && k !== 'none' ? ' disabled' : ''}>${l}</button>`;
      const durP = opts.secs ? dur(opts.secs) : null;
      D.innerHTML = `<div class="pdry-h"><b>Séchage du filament</b>${hum != null ? ` <span class="mut sm">· Box à <b class="${hum >= 30 ? 'warnc' : ''}">${fmt(hum, 0)} %</b> d'humidité</span>` : ''}</div>
        ${hum != null && hum >= 30 && dry.mode === 'none' ? `<p class="sm" style="color:var(--warn);margin:4px 0">⚠ Humidité élevée dans la Box : un séchage est conseillé.</p>` : ''}
        <div class="chips">${chip('none', 'Pas de séchage')}${chip('before', 'Sécher avant')}${chip('during', 'Sécher pendant')}</div>
        ${pend ? `<p class="mut sm">Une impression attend déjà la fin d'un séchage (${esc(flName(pend.path))}).</p>` : ''}
        ${dry.mode === 'none' ? '' : `<div class="pdry-f"><label>Température<br><input type="number" data-dk="temp" min="30" max="65" step="1" value="${dry.temp}"> °C</label>
          ${dry.mode === 'before' ? `<label>Durée max<br><input type="number" data-dk="hours" min="0.25" max="24" step="0.25" value="${dry.hours}"> h</label>
          <label>Ou dès l'humidité ≤<br><input type="number" data-dk="hum_stop" min="0" max="100" step="1" value="${dry.hum_stop}"> %</label>` : ''}</div>
          <p class="mut sm" style="margin:6px 0 0">${dry.mode === 'before'
            ? (heat.active ? `<span>Un séchage est déjà en cours (${fmt(heat.target, 0)} °C) : l'impression démarrera automatiquement à sa fin.</span> ` : '<span>La Box chauffe, puis l\'impression démarre automatiquement à la fin du séchage.</span> ') + '<span>Laisse le plateau dégagé ; tu seras prévenu au lancement.</span>'
            : `<span>${durP ? `La Box chauffe pendant toute l'impression (${durP} + 30 min).` : 'La Box chauffe pendant toute l\'impression (4 h par défaut).'}</span>`}
            ${mats.length ? ` <span>Réglage proposé pour ${[...new Set(tools.map(x => x.type).filter(Boolean))].map(esc).join(' + ')}.</span>` : ''}</p>`}`;
      D.querySelectorAll('[data-dm]').forEach(b => b.onclick = () => { dry.mode = b.dataset.dm; renderDry(); });
      D.querySelectorAll('[data-dk]').forEach(i => i.oninput = () => { dry[i.dataset.dk] = +i.value; });
      ok.textContent = dry.mode === 'before' ? 'Sécher puis imprimer' : okLabel;
    };
    const ok = M.querySelector('[data-r="1"]');
    renderDry();
    render();
    M.querySelectorAll('[data-r]').forEach(b => b.onclick = () => fin(b.dataset.r === '1' ? {map, relays: Object.entries(relays).filter(([, r]) => r.on).map(([m, r]) => ({source: +m, slot: r.c})),
      dry: dry.mode === 'none' ? null : {mode: dry.mode, temp: dry.temp, hum_stop: dry.mode === 'during' ? 0 : dry.hum_stop,
        hours: dry.mode === 'during' ? Math.min(24, Math.max(0.25, Math.round(((opts.secs || 4 * 3600) / 3600 + 0.5) * 4) / 4)) : dry.hours}} : null));
    M.onclick = e => { if (e.target === M) fin(null); };
  });
}

// fenêtre « Déplacer » : arborescence des dossiers de l'imprimante, création d'un sous-dossier possible
function pickFolder(dirs, cur, name, mkdir) {
  return new Promise(resolve => {
    let sel = cur, open = new Set(['']);
    for (let d = cur; d; d = flDir(d)) open.add(d);
    const kids = p => [...new Set(dirs.filter(d => flDir(d) === p))].sort((a, b) => a.localeCompare(b));
    const ico = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
    const node = (p, lvl) => { const k = kids(p), o = open.has(p);
      return `<div class="ftr-row${sel === p ? ' on' : ''}" data-f="${esc(p)}" style="padding-left:${8 + lvl * 18}px">
        <span class="ftr-tw" data-tw="${esc(p)}">${k.length ? (o ? '▾' : '▸') : ''}</span>${ico}<span class="ftr-n"${p ? " data-notr" : ""}>${esc(p ? p.split('/').pop() : 'Racine')}</span>${p === cur ? '<span class="mut sm">(actuel)</span>' : ''}</div>
        ${o ? k.map(c => node(c, lvl + 1)).join('') : ''}`; };
    const fin = v => { closeModal(); resolve(v); };
    modal(`<h2>Déplacer</h2><p class="mut ell" style="margin-top:-6px">${esc(name)}</p><div class="ftr"></div>
      <div class="bar" style="margin-top:10px"><input class="ftr-new" placeholder="Nouveau dossier dans la sélection…" style="flex:1;min-width:0"><button class="btn" data-mk>+ Créer</button></div>
      <div class="acts"><button class="btn" data-r="0">Annuler</button><button class="btn primary" data-r="1">Déplacer ici</button></div>`);
    const M = $('#modal'), T = M.querySelector('.ftr'), ok = M.querySelector('[data-r="1"]');
    const render = () => { T.innerHTML = node('', 0); ok.disabled = sel === cur; ok.textContent = sel === cur ? 'Déjà dans ce dossier' : 'Déplacer ici'; };
    T.onclick = e => { const tw = e.target.closest('[data-tw]'); if (tw && kids(tw.dataset.tw).length) { const p = tw.dataset.tw; open.has(p) ? open.delete(p) : open.add(p); return render(); }
      const r = e.target.closest('[data-f]'); if (r) { sel = r.dataset.f; open.add(sel); render(); } };
    T.ondblclick = e => { const r = e.target.closest('[data-f]'); if (r && r.dataset.f !== cur) fin(r.dataset.f); };
    const mk = async () => { const inp = M.querySelector('.ftr-new'), n = inp.value.trim().replace(/[\/]+/g, '-'); if (!n) return inp.focus();
      const path = (sel ? sel + '/' : '') + n; if (dirs.includes(path)) { sel = path; return render(); }
      try { await mkdir(path); } catch (e) { return toast(e.message); }
      dirs = [...dirs, path]; open.add(sel); sel = path; inp.value = ''; render(); };
    M.querySelector('[data-mk]').onclick = mk;
    M.querySelector('.ftr-new').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); mk(); } };
    M.querySelectorAll('[data-r]').forEach(b => b.onclick = () => fin(b.dataset.r === '1' ? sel : null));
    M.onclick = e => { if (e.target === M) fin(null); };
    render();
  });
}

// calque au survol d'une vignette (façon Plex) : sélection en haut à gauche, imprimer au centre, renommer en bas à gauche, supprimer en bas à droite
const SVGI = {
  check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>'};
const flCov = (p, dir, busy) => `<div class="cov"><button type="button" class="cbtn cpk" data-pk="${esc(p)}" title="Sélectionner" aria-label="Sélectionner">${SVGI.check}</button>
  ${!dir && !busy ? `<button type="button" class="cbtn cpl" data-pl="${esc(p)}" title="Imprimer" aria-label="Imprimer">${SVGI.play}</button>` : ''}
  <button type="button" class="cbtn ced" ${dir ? 'data-dren' : 'data-ed'}="${esc(p)}" title="Renommer" aria-label="Renommer">${SVGI.edit}</button>
  ${busy ? '' : `<button type="button" class="cbtn cdl" ${dir ? 'data-ddel' : 'data-dl'}="${esc(p)}" title="Supprimer" aria-label="Supprimer">${SVGI.trash}</button>`}</div>`;

routes.files = async (el) => {
  filesState.pick = new Set(); el.classList.remove('picking');
  const st = filesState;
  let data = await api('/files'), all = data.files;
  const render = () => {
    const needle = st.q.toLowerCase();
    let items = all.filter(f => (!needle || [flName(f.path), ...flFils(f).map(x => x.type), ...((f.info || {}).parts || [])].join(' ').toLowerCase().includes(needle)) &&
      (!st.mat || flFils(f).some(x => x.type === st.mat)));
    const flat = !!(needle || st.mat);
    if (!flat) items = items.filter(f => flDir(f.path) === st.cwd);
    const subs = flat ? [] : (data.dirs || []).filter(d => flDir(d) === st.cwd);
    const cnt = d => all.filter(f => f.path.startsWith(d + '/')).length;
    const W = !!data.write;
    const crumbs = ['<a href="#" data-cd="">Racine</a>', ...st.cwd.split('/').filter(Boolean).map((x, i, a) => `<a href="#" data-notr data-cd="${esc(a.slice(0, i + 1).join('/'))}">${esc(x)}</a>`)].join(' › ');
    const sk = FL_SORT[st.sort][1];
    items.sort((a, b) => { const x = sk(a), y = sk(b); return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
    FL_DUPS = new Map(); for (const f of all) FL_DUPS.set(flNorm(f), (FL_DUPS.get(flNorm(f)) || 0) + 1);
    if (st.group === 'dup') items.sort((a, b) => ((FL_DUPS.get(flNorm(a)) > 1) === (FL_DUPS.get(flNorm(b)) > 1) ? 0 : FL_DUPS.get(flNorm(a)) > 1 ? -1 : 1));
    const groups = [], gm = new Map();
    for (const f of items) { const k = FL_GROUP[st.group][1](f); if (!gm.has(k)) { const o = {k, items: []}; gm.set(k, o); groups.push(o); } gm.get(k).items.push(f); }
    const mats = [...new Set(all.flatMap(f => flFils(f).map(x => x.type)).filter(Boolean))].sort();
    const card = f => { const i = f.info || {}, fl = flFils(f), h = f.hist;
      return `<div class="fcard gcard ${st.sel === f.path ? 'on' : ''} ${st.pick.has(f.path) ? 'picked' : ''}" data-p="${esc(f.path)}" tabindex="0" role="button" draggable="${W && !flat && !f.printing}" style="--c:${esc((fl[0] || {}).color || '#9AA0AA')}" title="${esc(flName(f.path))}">
        <div class="gth">${i.thumb ? `<img src="${thumbUrl(f)}" alt="" loading="lazy">` : `<span class="mut sm">${f.info ? 'Pas d\'aperçu' : 'Analyse…'}</span>`}
          ${f.printing ? '<span class="tag ok gst">en cours</span>' : h && h.count ? `<span class="fcn" title="${h.count} impression(s), ${h.ok} terminée(s)">×${h.count}</span>` : ''}
          ${fl.length > 1 ? `<span class="fcs">${fl.length} couleurs</span>` : ''}${W && !flat ? flCov(f.path, false, f.printing) : ''}</div>
        <div class="fci"><b class="fcnm" data-notr>${esc(flName(f.path))}</b>
          <span class="mut ell">${[...new Set(fl.map(x => x.type).filter(Boolean))].join(' + ') || '–'}${i.layers ? ' · ' + fmt(i.layers) + ' couches' : ''}</span>
          <div class="fcw gmeta"><b>${dur(flTime(f))}</b><span class="mut">${g(flWeight(f))}</span>${dots(fl)}</div></div></div>`; };
    // vignette de dossier : mosaïque des aperçus des 4 fichiers les plus récents (sous-dossiers compris), sinon icône
    const dthumbs = d => {
      const ico = '<svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
      const t = all.filter(f => f.path.startsWith(d + '/') && f.info && f.info.thumb).sort((a, b) => b.modified - a.modified).slice(0, 4);
      if (!t.length) return ico;
      return `<div class="dmos n${t.length}">${t.map(f => `<img src="${thumbUrl(f)}" alt="" loading="lazy">`).join('')}</div><span class="dbadge">${ico.replace(/56/g, '16')}</span>`;
    };
    const dcard = d => `<div class="fcard dcard ${st.pick.has(d) ? 'picked' : ''}" data-d="${esc(d)}" tabindex="0" role="button" draggable="${W}" title="${esc(d)}"><div class="gth dth">${dthumbs(d)}${W ? flCov(d, true, all.some(f => f.printing && f.path.startsWith(d + '/'))) : ''}</div>
        <div class="fci"><b class="fcnm" data-notr>${esc(d.split('/').pop())}</b><span class="mut ell">${cnt(d)} fichier(s)</span></div></div>`;
    const pend = data.pending && data.progress ? `<span class="tag warn">analyse des fichiers : ${data.progress.done}/${data.progress.todo}</span>` : '';
    el.innerHTML = `<div class="bar"><h1 style="margin:0">Fichiers à imprimer</h1><span class="sp"></span>${pend}</div>
      ${W ? '<p class="mut" style="margin-top:-4px">Les fichiers présents sur l\'imprimante. Clique sur un fichier pour l\'imprimer (choix des emplacements de la Box), le renommer, le déplacer ou le supprimer.</p><p class="mut sm" style="margin-top:-6px">Pour ranger : glisse un fichier ou un dossier sur un dossier, ou sur le chemin en haut (« Racine ») pour le remonter.</p>'
        : '<div class="card" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 12px"><span style="flex:1;min-width:240px"><b>Lecture seule.</b> Pour lancer, renommer, ranger en dossiers ou supprimer des fichiers depuis PrintLab, active « Actions d\'écriture sur l\'imprimante ».</span><a class="btn primary" href="#/settings">Activer dans Paramètres</a></div>'}<span hidden></span>
      <div class="bar" style="margin:0 0 8px"><span class="crumbs">${flat ? 'Recherche dans tous les dossiers' : crumbs}</span><span class="sp"></span>${W && !flat ? '<button class="btn" id="mkd">+ Nouveau dossier</button>' : ''}</div>
      ${data.error ? `<div class="card err">Imprimante injoignable : ${esc(data.error)}</div>` : ''}
      <div class="bar tb"><input id="q" placeholder="Rechercher un fichier, une pièce…" value="${esc(st.q)}" style="min-width:220px">
        <label class="ctl">Matière <select id="mat"><option value="">Toutes</option>${mats.map(m => `<option ${st.mat === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label><span class="sp"></span>
        <label class="ctl">Trier <select id="srt">${Object.entries(FL_SORT).map(([k, [l]]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label><button class="btn" id="dir" title="Sens du tri">${st.dir > 0 ? '↑' : '↓'}</button></div>
      <div class="bar gb"><span class="ctl">Regrouper par</span><div class="chips">${Object.entries(FL_GROUP).map(([k, [l]]) => `<button class="chip ${st.group === k ? 'on' : ''}" data-grp="${k}">${l}</button>`).join('')}</div></div>
      ${subs.length ? `<div class="fgrid" style="margin-bottom:12px">${subs.map(dcard).join('')}</div>` : ''}
      ${groups.map(g0 => `${st.group !== 'none' ? `<div class="fsec"><h3>${esc(String(g0.k))}</h3><span class="mut">${g0.items.length} fichier${g0.items.length > 1 ? 's' : ''} · ${dur(g0.items.reduce((a, f) => a + (flTime(f) || 0), 0))}</span></div>` : ''}
        <div class="fgrid">${g0.items.map(card).join('')}</div>`).join('') || (subs.length ? '' : '<p class="mut">Aucun fichier.</p>')}
      <p class="mut" style="margin-top:14px">${items.length} fichier(s) · ${sizeH(items.reduce((a, f) => a + f.size, 0))}</p>
      ${st.pick.size ? `<div class="selbar" role="toolbar"><b>${st.pick.size} sélectionné(s)</b><button class="btn sm" data-sa>Tout sélectionner</button><span class="sp"></span>
        <button class="btn sm" data-smv>Déplacer…</button><button class="btn sm danger" data-sdl>Supprimer</button><button class="btn sm" data-sx title="Annuler la sélection (Échap)">✕</button></div>` : ''}`;
    el.classList.toggle('picking', st.pick.size > 0);
    wire(); if (st.sel) drawer();
  };
  const drawer = async () => {
    const f = all.find(x => x.path === st.sel); if (!f) return closeDrawer();
    const dw = drawerEl();
    if (!f.info) { dw.innerHTML = `<div class="dwb"><p class="mut">Fichier en cours d'analyse…</p></div>`; dw.classList.add('on'); $('#dwbg').classList.add('on'); return; }
    let d; try { d = await api('/files/detail?path=' + encodeURIComponent(f.path)); } catch (e) { toast(e.message); return; }
    if (st.sel !== f.path) return;
    const i = d.info, s = i.settings || {}, mr = i.moonraker || {}, fl = i.filaments || [], h = f.hist;
    const at = (k, id) => { const v = s[k]; return Array.isArray(v) ? v[Math.min((id || 1) - 1, v.length - 1)] : v; };
    const bedT = at((s.curr_bed_type || '').match(/Textured/i) ? 'textured_plate_temp' : (s.curr_bed_type || '').match(/Cool/i) ? 'cool_plate_temp' : (s.curr_bed_type || '').match(/Engineering/i) ? 'eng_plate_temp' : 'hot_plate_temp', (fl[0] || {}).id);
    let cost = 0, costOk = fl.length > 0;
    const frow = x => { const m = (d.match.find(y => y.id === x.id) || {}).spools || [], best = m[0];
      if (best && best.ppg && x.used_g != null) cost += best.ppg * x.used_g; else costOk = false;
      const short = best && x.used_g != null && best.remaining < x.used_g;
      return `<div class="gfl"><span class="sw" style="background:${esc(x.color)}"></span><div class="gfln"><b>${esc(x.type || '?')}</b> <span class="mut">${esc(at('filament_vendor', x.id) || '')}</span>
          <div class="mut sm ell" title="${esc(at('filament_settings_id', x.id) || '')}">${esc((at('filament_settings_id', x.id) || '').replace(/ @.*$/, ''))}${at('nozzle_temperature', x.id) ? ' · ' + esc(at('nozzle_temperature', x.id)) + ' °C' : ''}${x.support ? ' · supports' : ''}</div>
          <div class="sm ${best ? '' : 'mut'}">${best ? `→ ${swatch(best.color_hex)}${esc(best.vendor || '')} ${esc(fName(best.name))}${best.slot != null ? ` <span class="tag">Box ${slotName(best.slot)}</span>` : ''} <span class="${short ? 'low' : 'mut'}">${g(best.remaining)} restants${short ? ' : insuffisant' : ''}</span>${best.dist > 12 ? ' <span class="mut">(couleur approchante)</span>' : ''}` : 'Aucune bobine en stock de cette couleur'}</div></div>
        <div class="r"><b>${x.used_g != null ? fmt(x.used_g, 1) + ' g' : '–'}</b><div class="mut sm">${x.used_m != null ? fmt(x.used_m, 1) + ' m' : ''}</div></div></div>`; };
    const filHtml = fl.map(frow).join('');
    const yes = v => v === '1' || v === 1 || v === true ? 'oui' : 'non';
    const tech = [['Hauteur de couche', s.layer_height ? s.layer_height + ' mm' : mr.layer_height ? mr.layer_height + ' mm' : '–'], ['1re couche', s.initial_layer_print_height ? s.initial_layer_print_height + ' mm' : '–'],
      ['Remplissage', s.sparse_infill_density ? `${s.sparse_infill_density} ${esc(s.sparse_infill_pattern || '')}` : '–'], ['Parois', s.wall_loops || '–'],
      ['Dessus / dessous', s.top_shell_layers ? `${s.top_shell_layers} / ${s.bottom_shell_layers}` : '–'], ['Supports', s.enable_support === '1' ? esc(s.support_type || 'oui') + (s.support_on_build_plate_only === '1' ? ' (plateau seul)' : '') : 'non'],
      ['Bordure', esc(({auto_brim: 'auto', no_brim: 'aucune', outer_only: 'extérieure', inner_only: 'intérieure', outer_and_inner: 'int. + ext.', brim_ears: 'oreilles'})[s.brim_type] || s.brim_type || '–')], ['Plateau', esc(BED[i.bed_type] || s.curr_bed_type || '–') + (bedT ? ` · ${bedT} °C` : '')],
      ['Buse', s.nozzle_diameter ? at('nozzle_diameter') + ' mm' : mr.nozzle_diameter ? mr.nozzle_diameter + ' mm' : '–'], ['Tour de purge', s.enable_prime_tower != null ? (s.enable_prime_tower === '1' ? (i.wipe_tower !== false ? 'oui' : 'activée, non utilisée') : 'non') : '–'],
      ['Ordre', s.print_sequence === 'by object' ? 'objet par objet' : s.print_sequence ? 'couche par couche' : '–'], ['Lissage', s.ironing_type && s.ironing_type !== 'no ironing' ? esc(s.ironing_type) : 'non'],
      ['Vitesse paroi ext.', at('outer_wall_speed') ? at('outer_wall_speed') + ' mm/s' : '–'], ['Remplissage', at('sparse_infill_speed') ? at('sparse_infill_speed') + ' mm/s' : '–'],
      ['Mode vase', s.spiral_mode != null ? yes(s.spiral_mode) : '–'], ['Timelapse', i.timelapse ? 'oui' : 'non']];
    const z = i.max_z || mr.object_height;
    dw.innerHTML = `<div class="dwh" style="--c:${esc((fl[0] || {}).color || '#9AA0AA')}"><button class="dwx" data-x="1" title="Fermer (Échap)" aria-label="Fermer">×</button>
        <div class="dwa">${i.thumb ? `<span class="dwi gdwi"><img src="${thumbUrl(f)}" alt=""></span>` : ''}</div>
        <div class="dwt"><h2 style="word-break:break-word">${esc(flName(f.path))}</h2><div class="mut sm">${esc(i.slicer || mr.slicer || '')}</div>
          <div class="dwtags">${f.printing ? '<span class="tag ok">en cours d\'impression</span>' : ''}${[...new Set(fl.map(x => x.type).filter(Boolean))].map(t => `<span class="tag">${esc(t)}</span>`).join('')}${fl.length > 1 ? `<span class="tag">${fl.length} couleurs</span>` : ''}${i.support_used ? '<span class="tag">supports</span>' : ''}${(i.plates || []).length ? `<span class="tag">plateau ${i.plates.join(', ')}</span>` : ''}</div></div></div>
      <div class="dwb">
        ${data.write ? `<div class="dwact"><button class="btn primary" data-fa="print" ${f.printing ? 'disabled' : ''}>▶ Imprimer</button><button class="btn" data-fa="ren">Renommer</button><button class="btn" data-fa="move">Déplacer</button><button class="btn danger" data-fa="del" ${f.printing ? 'disabled' : ''}>Supprimer</button></div>` : ''}
        <div class="dws"><div><b>${dur(flTime(f))}</b><small>durée estimée</small></div><div><b>${g(flWeight(f))}</b><small>filament</small></div><div><b>${costOk ? eur(cost) : '–'}</b><small>${costOk ? 'coût matière' : 'coût : prix inconnu'}</small></div></div>
        <div class="dws"><div><b>${i.layers ? fmt(i.layers) : '–'}</b><small>couches</small></div><div><b>${i.changes != null ? fmt(i.changes) : '–'}</b><small>changements</small></div><div><b>${h && h.real_duration ? dur(h.real_duration) : '–'}</b><small>durée réelle moy.</small></div></div>
        ${(i.warnings || []).length ? `<div class="card warn sm" style="margin:0 0 10px;padding:8px 10px">⚠ ${i.warnings.map(w => esc(WARN[w] || w)).join(' · ')}</div>` : ''}
        <div class="dwh3">Filaments</div>${filHtml || '<p class="mut">Aucune information de filament.</p>'}
        ${fl.length ? `<p class="mut sm" style="margin:4px 0 12px">Bobine proposée : même matière et couleur la plus proche dans ton stock (priorité à celles chargées dans la Box). Coût calculé au prix payé de ces bobines.</p>` : ''}
        <div class="dwh3">Réglages d'impression</div>
        <div class="tech gtech">${tech.map(([k, v]) => `<span><small>${k}</small>${v}</span>`).join('')}</div>
        <div class="mut sm" style="margin-bottom:12px">${s.print_settings_id ? 'Profil : ' + esc(s.print_settings_id) : ''}${s.printer_settings_id ? ' · ' + esc(s.printer_settings_id) : ''}</div>
        <div class="dwh3">Pièce</div>
        <div class="tech gtech">${[['Encombrement', i.footprint ? `${fmt(i.footprint[0])} × ${fmt(i.footprint[1])}${z ? ' × ' + fmt(z, 1) : ''} mm` : z ? 'h ' + fmt(z, 1) + ' mm' : '–'], ['Objets', (i.objects || []).length || (i.parts || []).length || '–'], ['1re couche', i.first_layer_time ? dur(i.first_layer_time) : '–'], ['Fichier', sizeH(f.size)], ['Modifié le', dt(f.modified)]].map(([k, v]) => `<span><small>${k}</small>${v}</span>`).join('')}</div>
        ${(i.parts || []).length ? `<div class="mut sm" style="margin-bottom:12px">${esc([...new Set(i.parts)].join(', '))}</div>` : ''}
        <div class="dwh3">Historique ${h ? `· ${h.count} impression${h.count > 1 ? 's' : ''}, ${h.ok} terminée${h.ok > 1 ? 's' : ''}` : ''}</div>
        ${d.jobs.length ? `<div class="tw"><table class="hist"><thead><tr><th>Date</th><th>Statut</th><th class="r">Durée</th><th class="r">Filament</th></tr></thead><tbody>
          ${d.jobs.map(j => `<tr><td>${dt(j.start_time)}</td><td>${jobSt(j.status)}</td><td class="r">${dur(j.print_duration)}</td><td class="r">${g(j.filament_g)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">Jamais imprimé (d\'après l\'historique de l\'imprimante).</p>'}
        ${d.tracks.some(t => t.parts.length) ? `<div class="mut sm" style="margin-top:6px">Consommation mesurée par PrintLab : ${d.tracks.filter(t => t.parts.length).map(t => `${dt(t.started)} ${t.parts.map(p => fmt(p.weight, 1) + ' g').join(' + ')}`).join(' · ')}</div>` : ''}
      </div>`;
    dw.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.x) return closeDrawer(); if (b.dataset.fa) fileAct(b.dataset.fa, f, fl, h); };
    dw.classList.add('on'); $('#dwbg').classList.add('on');
  };
  const reload = async () => { data = await api('/files'); all = data.files; render(); };
  const fileAct = async (a, f, fl, h) => {
    if (a === 'print') {
      const t = flTime(f);
      const ch = await mapDialog('Lancer l\'impression', `Lancer « <b>${esc(flName(f.path))}</b> » sur la QIDI ? Durée estimée : ${t ? dur(t) : 'inconnue'}. Vérifie que le plateau est dégagé.`, fl, 'Imprimer', {secs: t});
      if (!ch) return;
      if (await act(() => api('/files/print', {method: 'POST', body: {path: f.path, mapping: ch.map, relays: ch.relays, dry: ch.dry}}), printMsg(ch))) { closeDrawer(); location.hash = printDest(ch); }
    } else if (a === 'del') {
      if (!confirm(`Supprimer définitivement « ${f.path} » de l'imprimante ?\nCette action est irréversible.`)) return;
      if (await act(() => api('/files/delete', {method: 'POST', body: {path: f.path}}), 'Fichier supprimé')) { closeDrawer(); await reload(); }
    } else if (a === 'ren') {
      const ext = (f.path.match(/\.gcode\.3mf$|\.3mf$|\.gcode$/i) || [''])[0], n = prompt('Nouveau nom :', flName(f.path));
      if (!n || !n.trim() || n.trim() === flName(f.path)) return;
      const dest = (flDir(f.path) ? flDir(f.path) + '/' : '') + n.trim().replace(/[\/]/g, '_') + ext;
      if (await act(() => api('/files/move', {method: 'POST', body: {src: f.path, dest}}), 'Renommé')) { if (st.sel === f.path) st.sel = dest; await reload(); }
    } else if (a === 'move') {
      const cur = flDir(f.path), d = await pickFolder(data.dirs || [], cur, flName(f.path), async n => { await api('/files/mkdir', {method: 'POST', body: {path: n}}); data.dirs = [...(data.dirs || []), n]; });
      if (d == null || d === cur) return;
      const dest = (d ? d + '/' : '') + f.path.split('/').pop();
      if (all.some(x => x.path === dest)) return toast(`« ${dest.split('/').pop()} » existe déjà dans ce dossier`);
      if (await act(() => api('/files/move', {method: 'POST', body: {src: f.path, dest}}), 'Déplacé')) { closeDrawer(); await reload(); }
    }
  };
  const mkdirFn = async n => { await api('/files/mkdir', {method: 'POST', body: {path: n}}); data.dirs = [...(data.dirs || []), n]; };
  const visible = () => [...el.querySelectorAll('[data-p],[data-d]')].map(x => x.dataset.p ?? x.dataset.d);
  const moveMany = async (srcs, d) => {
    let n = 0, skip = 0;
    for (const src of srcs) {
      const dest = (d ? d + '/' : '') + src.split('/').pop();
      if (flDir(src) === d || d === src || d.startsWith(src + '/') || all.some(f => f.path === dest) || (data.dirs || []).includes(dest)) { skip++; continue; }
      try { await api('/files/move', {method: 'POST', body: {src, dest}}); n++; } catch (e) { toast(e.message); skip++; }
    }
    toast(`${n} élément(s) déplacé(s)` + (skip ? ` · ${skip} ignoré(s) (déjà là ou nom existant)` : ''));
    st.pick.clear(); if (srcs.includes(st.sel)) closeDrawer(); await reload();
  };
  const bulk = async a => {
    const sel = [...st.pick], dirs = sel.filter(p => (data.dirs || []).includes(p)), files = sel.filter(p => !dirs.includes(p));
    if (a === 'move') { const d = await pickFolder(data.dirs || [], st.cwd, `${sel.length} élément(s)`, mkdirFn); if (d != null) await moveMany(sel, d); return; }
    if (files.some(p => (all.find(f => f.path === p) || {}).printing) || dirs.some(d => all.some(f => f.printing && f.path.startsWith(d + '/')))) return toast('Un fichier sélectionné est en cours d\'impression');
    const inside = all.filter(f => dirs.some(d => f.path.startsWith(d + '/'))).length;
    if (!confirm(`Supprimer définitivement ${files.length} fichier(s)` + (dirs.length ? ` et ${dirs.length} dossier(s) (${inside} fichier(s) dedans)` : '') + ` de l'imprimante ?\nCette action est irréversible.`)) return;
    let n = 0;
    for (const p of files) { try { await api('/files/delete', {method: 'POST', body: {path: p}}); n++; } catch (e) { toast(e.message); } }
    for (const p of dirs) { try { await api('/files/delete', {method: 'POST', body: {path: p, dir: true}}); n++; } catch (e) { toast(e.message); } }
    toast(`${n} élément(s) supprimé(s)`); st.pick.clear(); if (sel.includes(st.sel)) closeDrawer(); await reload();
  };
  const wire = () => {
    $('#q').oninput = e => { st.q = e.target.value; clearTimeout(window._qt); window._qt = setTimeout(() => { render(); const q = $('#q'); q.focus(); q.setSelectionRange(99, 99); }, 200); };
    $('#mat').onchange = e => { st.mat = e.target.value; render(); };
    $('#srt').onchange = e => { st.sort = e.target.value; flSave(); render(); };
    $('#dir').onclick = () => { st.dir = -st.dir; flSave(); render(); };
    el.querySelectorAll('[data-grp]').forEach(b => b.onclick = () => { st.group = b.dataset.grp; flSave(); render(); });
    document.onkeydown = e => { if (e.key === 'Escape' && st.pick.size && location.hash.startsWith('#/files') && $('#modal').hidden) { st.pick.clear(); render(); } };
    el.onkeydown = e => { const c = e.target.closest('.fcard'); if (c && e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } };
    const mk = $('#mkd'); if (mk) mk.onclick = async () => { const n = prompt('Nom du nouveau dossier :'); if (!n || !n.trim()) return;
      if (await act(() => api('/files/mkdir', {method: 'POST', body: {path: (st.cwd ? st.cwd + '/' : '') + n.trim()}}), 'Dossier créé')) reload(); };
    // glisser-déposer : fichier ou dossier → dossier (vignette) ou dossier parent (fil d'Ariane)
    let drag = null;
    const onFiles = () => location.hash.startsWith('#/files');
    const clearDnd = () => el.querySelectorAll('.dragging,.dropon').forEach(x => x.classList.remove('dragging', 'dropon'));
    const dropTarget = e => {
      if (!drag || !onFiles()) return null;
      const t = e.target.closest('[data-d],[data-cd]'); if (!t) return null;
      const d = t.dataset.d ?? t.dataset.cd;
      if (d === drag || d.startsWith(drag + '/') || flDir(drag) === d) return null;   // même dossier, ou dossier dans lui-même
      return [t, d];
    };
    el.ondragstart = e => {
      const c = e.target.closest && e.target.closest('[data-p],[data-d]');
      if (!data.write || !onFiles() || !c || c.getAttribute('draggable') !== 'true') return;
      drag = c.dataset.p ?? c.dataset.d; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', drag); c.classList.add('dragging');
    };
    el.ondragend = () => { drag = null; clearDnd(); };
    el.ondragover = e => { const r = dropTarget(e); if (!r) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      el.querySelectorAll('.dropon').forEach(x => x !== r[0] && x.classList.remove('dropon')); r[0].classList.add('dropon'); };
    el.ondragleave = e => { const t = e.target.closest && e.target.closest('.dropon'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('dropon'); };
    el.ondrop = async e => {
      const r = dropTarget(e); if (!r) return; e.preventDefault();
      const src = drag, dest = (r[1] ? r[1] + '/' : '') + src.split('/').pop();
      drag = null; clearDnd();
      if (st.pick.has(src) && st.pick.size > 1) return moveMany([...st.pick], r[1]);
      if (all.some(f => f.path === dest) || (data.dirs || []).includes(dest)) return toast(`« ${dest.split('/').pop()} » existe déjà dans ce dossier`);
      if (await act(() => api('/files/move', {method: 'POST', body: {src, dest}}), `Déplacé dans « ${r[1] || 'Racine'} »`)) { if (st.sel === src) closeDrawer(); await reload(); }
    };
    el.onclick = async e => {
      const sb = e.target.closest('.selbar button');
      if (sb) { if ('sx' in sb.dataset) { st.pick.clear(); return render(); } if ('sa' in sb.dataset) { visible().forEach(p => st.pick.add(p)); return render(); }
        return bulk('smv' in sb.dataset ? 'move' : 'del'); }
      const pick = p => { st.pick.has(p) ? st.pick.delete(p) : st.pick.add(p); render(); };
      const pk = e.target.closest('[data-pk]'); if (pk) return pick(pk.dataset.pk);
      if (st.pick.size && !e.target.closest('[data-cd]')) { const c = e.target.closest('[data-p],[data-d]'); if (c) return pick(c.dataset.p ?? c.dataset.d); }
      const fb = e.target.closest('[data-pl],[data-ed],[data-dl]');
      if (fb) { const p = fb.dataset.pl ?? fb.dataset.ed ?? fb.dataset.dl, f = all.find(x => x.path === p); if (!f) return;
        return fileAct('pl' in fb.dataset ? 'print' : 'ed' in fb.dataset ? 'ren' : 'del', f, flFils(f), f.hist); }
      const cd = e.target.closest('[data-cd]'); if (cd) { e.preventDefault(); st.cwd = cd.dataset.cd; closeDrawer(); return render(); }
      const dr = e.target.closest('[data-dren]'); if (dr) { const o = dr.dataset.dren, n = prompt('Nouveau nom du dossier :', o.split('/').pop()); if (!n || !n.trim() || n.trim() === o.split('/').pop()) return;
        if (await act(() => api('/files/move', {method: 'POST', body: {src: o, dest: (flDir(o) ? flDir(o) + '/' : '') + n.trim()}}), 'Dossier renommé')) reload(); return; }
      const dd = e.target.closest('[data-ddel]'); if (dd) { const o = dd.dataset.ddel, n = all.filter(f => f.path.startsWith(o + '/')).length;
        if (!confirm(`Supprimer définitivement le dossier « ${o} » et ses ${n} fichier(s) ?\nCette action est irréversible.`)) return;
        if (await act(() => api('/files/delete', {method: 'POST', body: {path: o, dir: true}}), 'Dossier supprimé')) reload(); return; }
      const dc = e.target.closest('[data-d]'); if (dc) { st.cwd = dc.dataset.d; return render(); }
      const c = e.target.closest('[data-p]'); if (!c) return;
      document.querySelectorAll('.fcard.on').forEach(x => x.classList.remove('on')); c.classList.add('on'); st.sel = c.dataset.p; drawer(); };
  };
  render();
  // liste servie depuis le cache de PrintLab : on relit une fois la version fraîche (nouveaux fichiers envoyés entre-temps)
  if (data.stale && !data.pending) setTimeout(async () => {
    if (!location.hash.startsWith('#/files')) return;
    try { data = await api('/files'); all = data.files; const q = document.activeElement && document.activeElement.id === 'q'; render(); if (q) { $('#q').focus(); $('#q').setSelectionRange(99, 99); } } catch {}
  }, 2500);
  // analyse en cours (premier passage ou nouveaux fichiers) : on rafraîchit jusqu'à la fin
  if (data.pending) window._poll = setInterval(async () => {
    if (!$('#main') || !location.hash.startsWith('#/files')) return clearInterval(window._poll);
    data = await api('/files').catch(() => data); all = data.files;
    const q = document.activeElement && document.activeElement.id === 'q'; render(); if (q) { $('#q').focus(); $('#q').setSelectionRange(99, 99); }
    if (!data.pending) clearInterval(window._poll);
  }, 4000);
};

routes.settings = async (el) => {
  S = await api('/settings');
  const theme = getTheme();
  const ENT = {spool: 'Bobines', filament: 'Filaments', vendor: 'Marques'};
  const row = (t, d, ctl) => `<div class="row"><div><b>${t}</b><div class="d">${d}</div></div>${ctl}</div>`;
  el.innerHTML = `<div class="set"><h1>Paramètres</h1>
  <div class="sec">Apparence</div><div class="box">${row('Thème', 'Couleurs de l\'interface. Le choix est mémorisé sur cet appareil.', '')}
    <div class="themes" id="theme">${THEMES.map(([k, l, d]) => `<button class="th ${theme === k ? 'on' : ''}" data-t="${k}" ${k === 'system' ? '' : `data-theme="${k}"`} type="button" aria-pressed="${theme === k}">
      <div class="pv"><div class="c"><i class="p"></i><i></i><i></i></div><div class="dots"><u style="background:var(--ok)"></u><u style="background:var(--warn)"></u><u style="background:var(--bad)"></u></div></div>
      <div class="nm">${l}<span>${d}</span></div></button>`).join('')}</div>
    ${row('Langue', 'Langue de toute l\'interface, Slicer compris. Le choix est mémorisé sur cet appareil.', `<div class="chips" id="lang" data-notr>${[['fr', 'Français'], ['en', 'English']].map(([k, l]) => `<button class="chip ${PL_LANG === k ? 'on' : ''}" data-l="${k}" type="button">${l}</button>`).join('')}</div>`)}</div>
  <div class="sec">Menus affichés</div><div class="box">${row('Menus de la barre du haut', 'Décoche ce que tu n\'utilises pas pour le masquer. Le tableau de bord et les paramètres restent toujours visibles. Le choix est enregistré pour tous tes appareils.', '')}
    <div class="brands" id="menus">${MENUS.map(([k, l, d]) => `<label class="bchip ${(S.hidden_menus || []).includes(k) ? '' : 'on'}" title="${esc(d)}"><input type="checkbox" data-m="${k}" ${(S.hidden_menus || []).includes(k) ? '' : 'checked'}> ${l}</label>`).join('')}</div></div>
  <div class="sec">Général</div><div class="box">
    ${row('Devise', 'Code ISO à trois lettres utilisé pour les prix (EUR, USD…)', `<input id="cur" value="${esc(S.currency)}" maxlength="3" style="width:80px;text-align:center">`)}
    ${row('Arrondir les prix', 'Arrondit les prix à l\'entier le plus proche', `<label class="sw2"><input type="checkbox" id="rnd" ${S.round_prices ? 'checked' : ''}><i></i></label>`)}
    ${row('Déduction automatique du stock', 'À la fin de chaque impression, la consommation par emplacement est retirée des bobines associées (annulable)', `<label class="sw2"><input type="checkbox" id="adx" ${S.auto_deduct ? 'checked' : ''}><i></i></label>`)}
    ${row('URL de base', 'Adresse publique utilisée pour générer des liens (ex. QR codes)', `<input id="burl" value="${esc(S.base_url)}" placeholder="https://printlab.example.com" style="width:260px">`)}</div>
  <div class="sec">Imprimante et intégrations</div><div class="box">
    ${row('Adresse de l\'imprimante (Moonraker)', 'IP ou URL de ton imprimante Klipper/Moonraker, ex. 192.168.1.50 (port 7125 par défaut). Laisse vide si tu n\'en as pas : PrintLab fonctionne alors comme simple gestionnaire de bobines.', `<span><input id="mrurl" value="${esc(S.moonraker_url)}" placeholder="192.168.1.50" style="width:200px"> <button class="btn" id="mrtest">Tester</button> <span id="mrres" class="mut"></span></span>`)}
    ${row('Actions d\'écriture sur l\'imprimante', 'Autorise PrintLab à lancer, mettre en pause ou annuler une impression, et à déplacer ou supprimer définitivement des fichiers et dossiers. Désactivé : lecture seule (seule la lumière reste commandable).', `<label class="sw2"><input type="checkbox" id="pwr" ${S.printer_write ? 'checked' : ''}><i></i></label>`)}
    ${row('Adresse de Spoolman', 'Uniquement pour importer une ancienne base Spoolman, ex. 192.168.1.10:7912', `<input id="smurl" value="${esc(S.spoolman_url)}" placeholder="192.168.1.10:7912" style="width:200px">`)}</div>
  <div class="sec">Alertes</div><div class="box">
    ${row('Canaux (services Home Assistant)', 'Les alertes de PrintLab passent par Home Assistant, comme tes alertes d\'impression. Un service par ligne : rest_command.… (Discord) ou notify.… (téléphone).', `<textarea id="nsvc" rows="2" style="width:300px">${esc((S.notify_services || []).join('\n'))}</textarea>`)}
    ${[['runout', 'Bobine vide et relais', 'La Box a basculé seule sur une autre bobine pendant un print (la bobine de départ est passée à 0 g)'],
       ['relay_end', 'Fin de relais', 'Après le print, l\'emplacement de relais a repris son vrai réglage sur l\'imprimante (ou n\'a pas pu)'],
       ['low', 'Stock bas', 'Une bobine passe sous son seuil de stock bas après un print (une seule alerte par bobine)']].map(([k, t, d]) =>
      row(t, d, `<label class="sw2"><input type="checkbox" data-al="${k}" ${(S.alerts || {})[k] !== false ? 'checked' : ''}><i></i></label>`)).join('')}
    ${row('Tester', 'Envoie une alerte d\'essai sur les canaux ci-dessus', '<span><button class="btn" id="ntest">Envoyer un test</button> <span id="nres" class="mut"></span></span>')}</div>
  <div class="sec">Comportement de la bibliothèque</div><div class="box">
    ${row('Seuil de stock bas', 'Les bobines à ce poids restant ou en dessous passent en rouge (modifiable par filament)', `<span><input id="thr" type="number" value="${esc(S.low_threshold)}" style="width:90px;text-align:right"> g</span>`)}</div>
  <div class="sec">Mes marques</div><div class="box" id="brands"></div>
  <div class="sec">Mes matières</div><div class="box" id="mats"></div>
  <div class="sec">Champs supplémentaires</div><div class="box" id="ef"></div>
  <div class="sec">Données</div><div class="box">
    ${row('Importer depuis Spoolman', 'Copie fabricants, filaments et bobines. Idempotent : rien n\'est dupliqué ni écrasé.', '<span><button class="btn primary" id="imp">Importer</button> <span id="impr" class="mut"></span></span>')}
    ${row('Export CSV', 'Toutes les bobines', '<a class="btn" href="/api/export/spools.csv">Télécharger</a>')}</div>
  <div class="sec">Session</div><div class="box">${row('Déconnexion', 'Fermer la session sur ce navigateur', '<button class="btn" id="out">Se déconnecter</button>')}</div>
  <p class="mut" style="margin-top:18px">PrintLab · <a href="#/printer">Imprimante</a></p></div>`;
  el.querySelectorAll('#lang [data-l]').forEach(b => b.onclick = () => { if (b.dataset.l !== PL_LANG) plSetLang(b.dataset.l); });
  el.querySelectorAll('#theme button').forEach(b => b.onclick = () => { try { localStorage.setItem('pl-theme', b.dataset.t); } catch {} applyTheme(); el.querySelectorAll('#theme button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); }); });
  el.querySelectorAll('#menus input').forEach(i => i.onchange = () => {
    const hid = [...el.querySelectorAll('#menus input')].filter(x => !x.checked).map(x => x.dataset.m);
    i.parentElement.classList.toggle('on', i.checked);
    act(async () => { await putSetting('hidden_menus', hid); applyMenus(S.hidden_menus); }, 'Enregistré');
  });
  $('#cur').onchange = e => act(() => putSetting('currency', e.target.value), 'Enregistré');
  $('#rnd').onchange = e => act(() => putSetting('round_prices', e.target.checked), 'Enregistré');
  $('#adx').onchange = e => act(() => putSetting('auto_deduct', e.target.checked), 'Enregistré');
  $('#burl').onchange = e => act(() => putSetting('base_url', e.target.value.trim()), 'Enregistré');
  $('#pwr').onchange = e => { if (e.target.checked && !confirm('Autoriser PrintLab à lancer/annuler des impressions et supprimer des fichiers sur l\'imprimante ?')) { e.target.checked = false; return; } act(() => putSetting('printer_write', e.target.checked), 'Enregistré'); };
  $('#mrurl').onchange = e => act(async () => { await putSetting('moonraker_url', e.target.value.trim()); e.target.value = S.moonraker_url || e.target.value; }, 'Enregistré');
  $('#smurl').onchange = e => act(async () => { await putSetting('spoolman_url', e.target.value.trim()); e.target.value = S.spoolman_url || e.target.value; }, 'Enregistré');
  $('#mrtest').onclick = async () => { $('#mrres').textContent = '…'; try { const r = await api('/printer/test', {method: 'POST', body: {url: $('#mrurl').value}}); $('#mrres').textContent = r.ok ? `✓ ${r.hostname || 'connecté'} · Klipper ${r.klippy}` : `✗ ${r.error}`; } catch (e) { $('#mrres').textContent = '✗ ' + e.message; } };
  $('#nsvc').onchange = e => act(() => putSetting('notify_services', e.target.value.split(/[\s,]+/).filter(Boolean)), 'Enregistré');
  el.querySelectorAll('[data-al]').forEach(c => c.onchange = () => act(() => putSetting('alerts', Object.fromEntries([...el.querySelectorAll('[data-al]')].map(x => [x.dataset.al, x.checked]))), 'Enregistré'));
  $('#ntest').onclick = async () => { $('#nres').textContent = '…'; try { const r = await api('/alerts/test', {method: 'POST'}); $('#nres').textContent = r.errors.length ? '✗ ' + r.errors.join(' · ') : '✓ envoyé'; } catch (e) { $('#nres').textContent = '✗ ' + e.message; } };
  $('#thr').onchange = e => act(() => putSetting('low_threshold', e.target.value), 'Enregistré');
  const renderEf = () => {
    $('#ef').innerHTML = Object.entries(ENT).map(([k, l]) => `<div class="efl"><b class="n">${l}</b><button class="btn sm" data-add="${k}">+ Ajouter un champ</button></div>` +
      (S['extra_fields_' + k] || []).map((d, i) => `<div class="efl"><span class="n">${esc(d.name)} <span class="t">· ${{text: 'texte', number: 'nombre', choice: 'choix'}[d.type] || d.type}${d.unit ? ' · ' + esc(d.unit) : ''}${d.choices ? ' · ' + d.choices.map(esc).join(', ') : ''}</span></span><button class="btn sm danger" data-del="${k}:${i}">Supprimer</button></div>`).join('')).join('');
    $('#ef').querySelectorAll('[data-add]').forEach(b => b.onclick = () => formModal('Nouveau champ — ' + ENT[b.dataset.add], [
      ['name', 'Nom', {}], ['type', 'Type', {type: 'select', options: [['text', 'Texte'], ['number', 'Nombre'], ['choice', 'Choix']]}], ['unit', 'Unité (optionnel)', {}],
      ['choices', 'Choix possibles (séparés par des virgules)', {full: true}]], {type: 'text'},
      async v => { if (!v.name) throw new Error('Nom requis'); const key = v.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const list = [...(S['extra_fields_' + b.dataset.add] || [])]; if (list.some(x => x.key === key)) throw new Error('Champ déjà existant');
        list.push({key, name: v.name, type: v.type, unit: v.unit || null, choices: v.type === 'choice' ? v.choices.split(',').map(s => s.trim()).filter(Boolean) : null});
        await putSetting('extra_fields_' + b.dataset.add, list); renderEf(); }));
    $('#ef').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { const [k, i] = b.dataset.del.split(':'); if (!confirm('Supprimer ce champ ? Les valeurs déjà saisies sont conservées.')) return;
      const list = [...S['extra_fields_' + k]]; list.splice(Number(i), 1); await act(() => putSetting('extra_fields_' + k, list), 'Supprimé'); renderEf(); });
  };
  renderEf();
  const PRESET = ['Bambu Lab', 'Polymaker', 'eSUN', 'Sunlu', 'Elegoo', 'Creality', 'Prusament', 'Overture', 'Eryone', 'Anycubic', 'Geeetech', 'Flashforge', 'Artillery', 'Jayo', 'Kingroon', 'Fiberlogy', 'Fillamentum', 'Extrudr', 'Filamentive', 'Das Filament', 'Formfutura', 'Amolen', 'Hatchbox', 'Atomic Filament', 'Add:north', 'colorFabb', 'Matterhackers', 'Siraya Tech', 'Protopasta', 'Raise3D', 'Ultimaker', 'Snapmaker', 'Tinmorry', 'Fillamentum', 'R3D', '3DJAKE', 'Print-Me', 'Nobufil', 'Rosa3D', 'Gizmo Dorks', 'Inland', 'Sakata 3D', 'Voxelab', 'Duramic', 'Rolls', 'Cookiecad'];
  const catP = api('/catalog').catch(() => ({families: {}, brands: {}}));
  const renderBrands = async () => {
    const [vs, cat] = await Promise.all([api('/vendors'), catP]); const have = new Map(vs.map(v => [v.name.toLowerCase(), v]));
    const nk = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const seen = new Set(); const names = [...vs.map(v => v.name), ...PRESET, ...Object.keys(cat.brands)].filter(n => { const k = nk(n); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.localeCompare(b));
    const cb = new Set(Object.keys(cat.brands).map(nk));
    $('#brands').innerHTML = `<div class="row"><div><b>Marques que j'utilise</b><div class="d">Coche tes marques préférées : seules celles-ci apparaissent dans les listes et formulaires. Une marque ne peut pas être retirée tant qu'elle a des filaments. ${Object.keys(cat.brands).length} marques ont leurs gammes et données techniques dans le catalogue intégré (★).</div></div></div>
      <div class="brands">${names.map(n => { const v = have.get(n.toLowerCase()); return `<label class="bchip ${v ? 'on' : ''}"><input type="checkbox" data-b="${esc(n)}" ${v ? 'checked' : ''} ${v && v.filaments ? 'disabled' : ''} title="${v && v.filaments ? v.filaments + ' filament(s) utilisent cette marque' : ''}"> ${esc(n)}${cb.has(nk(n)) ? ' <span class="mut" title="Gammes et données techniques disponibles">★</span>' : ''}${v && v.filaments ? ` <span class="mut">${v.filaments}</span>` : ''}</label>`; }).join('')}</div>
      <div class="row"><div><b>Autre marque</b><div class="d">Ajoute une marque qui n'est pas dans la liste</div></div><span><input id="nb" placeholder="Nom de la marque" style="width:180px"> <button class="btn" id="nbb">Ajouter</button></span></div>`;
    $('#brands').querySelectorAll('[data-b]').forEach(c => c.onchange = () => act(async () => {
      const n = c.dataset.b; const v = have.get(n.toLowerCase());
      if (c.checked) await api('/vendors', {method: 'POST', body: {name: n}}); else if (v) await api('/vendors/' + v.id, {method: 'DELETE'});
      await renderBrands(); }, 'Marques mises à jour'));
    $('#nbb').onclick = () => act(async () => { const n = $('#nb').value.trim(); if (!n) return; await api('/vendors', {method: 'POST', body: {name: n}}); await renderBrands(); }, 'Marque ajoutée');
  };
  renderBrands();
  const renderMats = async () => {
    const [cat, fs] = await Promise.all([catP, api('/filaments')]);
    const used = new Set(fs.map(f => famOf(f.material)));
    const list = [...new Set([...Object.keys(cat.families).filter(f => f !== 'Autre'), ...[...used].filter(f => f !== 'Autre')])];
    const mine = new Set(S.materials || []);
    $('#mats').innerHTML = `<div class="row"><div><b>Matières que j'utilise</b><div class="d">Seules ces matières sont proposées à l'ajout d'une bobine ; chaque marque montre ensuite ses propres gammes (PLA → Basic, Matte, Silk…). Rien de coché = toutes les matières.</div></div></div>
      <div class="brands">${list.map(f => `<label class="bchip ${mine.has(f) ? 'on' : ''}"><input type="checkbox" data-m="${esc(f)}" ${mine.has(f) ? 'checked' : ''}> ${esc(f)}${used.has(f) ? ' <span class="mut" title="Présente dans ta bibliothèque">•</span>' : ''}</label>`).join('')}</div>`;
    $('#mats').querySelectorAll('[data-m]').forEach(c => c.onchange = () => act(async () => {
      const cur = new Set(S.materials || []); c.checked ? cur.add(c.dataset.m) : cur.delete(c.dataset.m);
      await putSetting('materials', [...cur]); renderMats(); }, 'Matières mises à jour'));
  };
  renderMats();
  $('#imp').onclick = async () => { $('#impr').textContent = '…'; try { const r = await api('/import/spoolman', {method: 'POST'}); $('#impr').textContent = `${r.vendors} fabricant(s), ${r.filaments} filament(s), ${r.spools} bobine(s) ajouté(s)`; } catch (e) { $('#impr').textContent = e.message; } };
  $('#out').onclick = async () => { await api('/logout', {method: 'POST'}); location = '/login'; };
};

// ---------- factures d'achat ----------
// Dépôt d'un PDF → lecture → récapitulatif (une ligne par article) → validation → bobines créées.
const INV_ST = {pending: ['À valider', 'warn'], done: ['Intégrée', 'ok'], rejected: ['Rejetée', '']};
const invDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString((window.PL_LOCALE || 'fr-FR'), {dateStyle: 'medium'}) : '–';
async function invUpload(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Lecture de la facture…');
  const r = await fetch('/api/invoices', {method: 'POST', body: fd});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.detail || 'Erreur ' + r.status); return; }
  location.hash = '#/invoices/' + j.id;
}
routes.invoices = async (el, rest) => {
  if (rest[0]) return invRecap(el, +rest[0]);
  const list = await api('/invoices');
  el.innerHTML = `<h1>Factures d'achat</h1>
  <p class="mut">Dépose la facture PDF d'une commande de filament : PrintLab la lit et te montre un récapitulatif (filaments reconnus ou à créer, quantités, prix payé). Rien n'entre dans le stock tant que tu n'as pas validé.</p>
  <label class="idrop" id="idrop" tabindex="0"><input type="file" accept="application/pdf,.pdf" hidden id="ifile">
    <b>Déposer une facture PDF</b><span class="mut">glisser ici ou cliquer pour choisir · lecture automatique : Bambu Lab (les autres fournisseurs : lignes à saisir)</span></label>
  <div class="card tw" style="margin-top:14px"><table><thead><tr><th>Date</th><th>Fournisseur</th><th>Numéro</th><th class="r">Bobines</th><th class="r">Total</th><th>Statut</th><th></th></tr></thead><tbody>
  ${list.map(i => `<tr class="trow" data-inv="${i.id}"><td>${invDate(i.date)}</td><td>${esc(i.vendor || '?')}</td><td>${esc(i.number || '–')}</td><td class="r">${i.spools || '–'}</td>
    <td class="r">${i.total != null ? eur(i.total) : '–'}</td><td><span class="tag ${INV_ST[i.status]?.[1] || ''}">${INV_ST[i.status]?.[0] || esc(i.status)}</span>${i.duplicate_of && i.status !== 'done' ? ' <span class="tag bad">déjà intégrée</span>' : ''}</td>
    <td class="r"><button class="btn sm">${i.status === 'pending' ? 'Vérifier' : 'Voir'}</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Aucune facture pour l\'instant.</td></tr>'}</tbody></table></div>`;
  const dz = $('#idrop'), fi = $('#ifile');
  fi.onchange = () => invUpload(fi.files[0]);
  dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } };
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('on'); };
  dz.ondragleave = () => dz.classList.remove('on');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('on'); invUpload(e.dataTransfer.files[0]); };
  el.querySelectorAll('[data-inv]').forEach(tr => tr.onclick = () => location.hash = '#/invoices/' + tr.dataset.inv);
};
const W_OPTS = [250, 500, 1000, 2000, 3000];
const wOpts = w => [...new Set([...W_OPTS, ...(w && !W_OPTS.includes(+w) ? [+w] : [])])].sort((a, b) => a - b)
  .map(v => `<option value="${v}" ${+w === v ? 'selected' : ''}>${v >= 1000 ? fmt(v / 1000, v % 1000 ? 2 : 0) + ' kg' : v + ' g'}</option>`).join('');
let _invId = 0;
const invPic = (l, f) => {
  const src = f && f.image ? imgUrl(f.id, f.image) : l.photo ? `/api/invoices/${_invId}/img/${l.i}?${l.photo.length}` : null;
  return src ? `<span class="iph"><img src="${src}" alt="" loading="lazy" onerror="this.parentNode.outerHTML=''"></span>` : `<span class="iph sw0">${swatch(l.hexes?.[0], l.hexes)}</span>`;
};
async function invRecap(el, id) {
  _invId = id;
  const [inv, fils, locs] = await Promise.all([api('/invoices/' + id), api('/filaments'), api('/locations').catch(() => [])]);
  const done = inv.status === 'done', ro = inv.status !== 'pending';
  const L = inv.lines.map(l => ({...l, include: true, choice: l.match ? String(l.match.id) : 'new', name: l.new.name, price: l.paid_each, qty: l.qty, weight: l.weight}));
  const man = [];   // lignes ajoutées à la main
  const fsorted = [...fils].sort((a, b) => (a.vendor_name || '').localeCompare(b.vendor_name || '') || a.name.localeCompare(b.name));
  const fopt = (sel, withNew, nm) => (withNew ? `<option value="new" ${sel === 'new' ? 'selected' : ''}>+ Créer « ${esc(nm)} »</option>` : '') +
    fsorted.map(f => `<option value="${f.id}" ${String(f.id) === sel ? 'selected' : ''}>${esc(f.vendor_name || '?')} · ${esc(f.name)}${f.material ? ' · ' + esc(f.material) : ''}</option>`).join('');
  const fById = Object.fromEntries(fils.map(f => [String(f.id), f]));
  const res = inv.result || {};
  const draw = () => {
    const keep = [...L.filter(l => l.include), ...man.filter(m => m.choice)];
    const nSp = keep.reduce((a, l) => a + (+l.qty || 0), 0), nNew = L.filter(l => l.include && l.choice === 'new').length;
    const sum = keep.reduce((a, l) => a + (+l.qty || 0) * (+l.price || 0), 0);
    const tot = inv.totals || {};
    el.innerHTML = `<p><a href="#/invoices">← Factures</a></p>
    <h1>${esc(inv.vendor || 'Facture')} ${inv.number ? '· ' + esc(inv.number) : ''} <span class="tag ${INV_ST[inv.status]?.[1] || ''}">${INV_ST[inv.status]?.[0] || ''}</span></h1>
    <div class="card ihead">
      <div><span class="mut">Date</span><b>${invDate(inv.date)}</b></div>
      <div><span class="mut">Commande</span><b>${esc(inv.order_nr || '–')}</b></div>
      <div><span class="mut">Articles</span><b>${tot.items != null ? eur(tot.items) : '–'}</b></div>
      ${tot.discount ? `<div><span class="mut">Réduction commande</span><b>− ${eur(tot.discount)}</b></div>` : ''}
      ${tot.shipping ? `<div><span class="mut">Livraison</span><b>${eur(tot.shipping)}</b></div>` : ''}
      <div><span class="mut">Total payé</span><b>${inv.total != null ? eur(inv.total) : '–'}</b></div>
      ${inv.has_file ? `<div><a class="btn sm" href="/api/invoices/${id}/file" target="_blank" rel="noopener">Voir le PDF</a></div>` : ''}
    </div>
    ${inv.duplicate_of && !done ? `<p class="err">⚠ Une facture avec ce numéro a déjà été intégrée (<a href="#/invoices/${inv.duplicate_of}">voir</a>). L'intégrer à nouveau créerait des bobines en double.</p>` : ''}
    ${!inv.format && !done ? `<p class="mut">Format de facture non reconnu automatiquement : ajoute les lignes à la main ci-dessous.</p>` : ''}
    ${done ? `<div class="card"><b>Intégrée le ${dt(inv.done_at)}</b> : ${res.spools?.length || 0} bobine(s) créée(s)${res.filaments?.length ? `, ${res.filaments.length} nouveau(x) filament(s)` : ''}.
      <div class="bar" style="margin-top:8px"><a class="btn sm" href="#/spools">Voir les bobines</a><button class="btn sm" id="iundo">Annuler l'intégration</button></div></div>` : ''}
    <div class="card tw"><table class="itab"><thead><tr><th></th><th>Article</th><th class="r">Qté</th><th class="r">Prix payé / bobine</th><th class="r">Poids</th><th>Dans PrintLab</th></tr></thead><tbody>
    ${L.map((l, i) => { const f = fById[l.choice]; return `<tr class="${l.include ? '' : 'off'}">
      <td><input type="checkbox" data-k="include" data-i="${i}" ${l.include ? 'checked' : ''} ${ro ? 'disabled' : ''} aria-label="Intégrer cette ligne"></td>
      <td><div class="iart">${invPic(l, f)}<div><b>${esc(l.product)}</b> ${esc(l.color || '')}${l.code ? ` <span class="mut">(${esc(l.code)})</span>` : ''}
        <div class="mut sm">${l.refill ? 'recharge (sans bobine)' : 'avec bobine'}${l.gift ? ' · <span class="tag ok">cadeau</span>' : ''}</div></div></div></td>
      <td class="r" data-l="Quantité"><input type="number" min="1" max="100" data-k="qty" data-i="${i}" value="${l.qty}" ${ro ? 'disabled' : ''} class="inum"></td>
      <td class="r" data-l="Prix payé / bobine"><input type="number" step="0.01" min="0" data-k="price" data-i="${i}" value="${l.price ?? ''}" ${ro ? 'disabled' : ''} class="inum">
        <div class="mut sm">facture : ${eur(l.subtotal / (l.qty || 1))}${l.subtotal && inv.factor && inv.factor !== 1 ? (inv.factor < 1 ? ' · remise commande répartie' : ' · livraison répartie') : ''}</div></td>
      <td class="r" data-l="Poids"><select data-k="weight" data-i="${i}" ${ro ? 'disabled' : ''} class="iw">${wOpts(l.weight)}</select></td>
      <td data-l="Dans PrintLab"><select data-k="choice" data-i="${i}" ${ro ? 'disabled' : ''}>${fopt(l.choice, true, l.name)}</select>
        ${l.choice === 'new' ? `<input data-k="name" data-i="${i}" value="${esc(l.name)}" ${ro ? 'disabled' : ''} class="iname" aria-label="Nom du nouveau filament">
          <div class="mut sm">nouveau filament ${esc(l.new.material || '')}${l.new.finish ? ' ' + esc(l.new.finish) : ''}${l.new.nozzle_min ? ` · buse ${l.new.nozzle_min}°` : ''}${l.new.density ? ` · densité ${fmt(l.new.density, 2)}` : ''}</div>`
          : `<div class="mut sm">${l.match && String(l.match.id) === l.choice ? `<span class="tag ok">reconnu</span> par ${esc(l.match.why)}` : f ? 'choisi à la main' : ''}${f ? ` · ${f.spools} bobine(s) en stock` : ''}</div>`}</td></tr>`; }).join('')}
    ${man.map((m, i) => `<tr><td><button class="btn sm" data-mdel="${i}" aria-label="Retirer">✕</button></td><td colspan="1"><span class="mut">Ligne ajoutée</span></td>
      <td class="r"><input type="number" min="1" data-mk="qty" data-i="${i}" value="${m.qty}" class="inum"></td>
      <td class="r"><input type="number" step="0.01" data-mk="price" data-i="${i}" value="${m.price ?? ''}" class="inum"></td>
      <td class="r" data-l="Poids"><select data-mk="weight" data-i="${i}" class="iw">${wOpts(m.weight ?? 1000)}</select></td>
      <td><select data-mk="choice" data-i="${i}"><option value="">— choisir un filament —</option>${fopt(m.choice, false)}</select></td></tr>`).join('')}
    ${!L.length && !man.length ? '<tr><td colspan="6" class="mut">Aucune ligne lue.</td></tr>' : ''}
    </tbody></table>${ro ? '' : '<button class="btn sm" id="iman" style="margin-top:8px">+ Ajouter une ligne</button>'}</div>
    ${ro ? '' : `<div class="card isum">
      <label>Emplacement des nouvelles bobines <input id="iloc" list="ilocs" placeholder="ex. Étagère, Box…" value="${esc(invRecap._loc || '')}"><datalist id="ilocs">${locs.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
      <div><b>${nSp}</b> bobine(s) à créer${nNew ? `, dont <b>${nNew}</b> nouveau(x) filament(s)` : ''} · valeur ${eur(sum)}${inv.total != null ? ` <span class="mut">(facture : ${eur(inv.total)})</span>` : ''}</div>
      <div class="bar"><button class="btn" id="irej">Rejeter</button><button class="btn" id="idel">Supprimer</button><span class="sp"></span><button class="btn primary" id="iok" ${nSp ? '' : 'disabled'}>Valider et intégrer ${nSp} bobine(s)</button></div></div>`}
    ${ro && !done ? `<div class="bar"><button class="btn" id="idel">Supprimer</button><button class="btn" id="ireopen">Remettre à valider</button></div>` : ''}`;
    el.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      const l = L[+inp.dataset.i], k = inp.dataset.k;
      l[k] = k === 'include' ? inp.checked : ['qty', 'price', 'weight'].includes(k) ? (inp.value === '' ? null : +inp.value) : inp.value;
      if (['include', 'choice', 'qty', 'price'].includes(k)) draw();
    });
    el.querySelectorAll('[data-mk]').forEach(inp => inp.onchange = () => { const m = man[+inp.dataset.i], k = inp.dataset.mk; m[k] = k === 'choice' ? inp.value : inp.value === '' ? null : +inp.value; draw(); });
    el.querySelectorAll('[data-mdel]').forEach(b => b.onclick = () => { man.splice(+b.dataset.mdel, 1); draw(); });
    if ($('#iloc')) $('#iloc').oninput = e => invRecap._loc = e.target.value;
    if ($('#iman')) $('#iman').onclick = () => { man.push({qty: 1, price: null, weight: 1000, choice: ''}); draw(); };
    if ($('#irej')) $('#irej').onclick = async () => { if (await act(() => api(`/invoices/${id}/reject`, {method: 'POST'}), 'Facture rejetée')) location.hash = '#/invoices'; };
    if ($('#idel')) $('#idel').onclick = async () => { if (confirm('Supprimer cette facture (et son PDF) ?') && await act(() => api('/invoices/' + id, {method: 'DELETE'}), 'Supprimée')) location.hash = '#/invoices'; };
    if ($('#ireopen')) $('#ireopen').onclick = async () => { if (await act(() => api(`/invoices/${id}/reopen`, {method: 'POST'}))) route(); };
    if ($('#iundo')) $('#iundo').onclick = async () => { if (confirm('Retirer les bobines créées par cette facture ? (seulement si elles n\'ont pas encore servi)') && await act(() => api(`/invoices/${id}/undo`, {method: 'POST'}), 'Intégration annulée')) route(); };
    if ($('#iok')) $('#iok').onclick = async () => {
      const lines = [...L.map(l => ({i: l.i, include: l.include, qty: l.qty, price: l.price, weight: l.weight, refill: l.refill, code: l.code, sku: l.sku,
          filament_id: l.choice === 'new' ? null : +l.choice, create: l.choice === 'new' ? {...l.new, name: l.name, price: l.price} : null})),
        ...man.filter(m => m.choice).map(m => ({include: true, qty: m.qty, price: m.price, weight: m.weight, filament_id: +m.choice}))];
      if (inv.duplicate_of && !confirm('Cette facture a déjà été intégrée. Créer quand même ces bobines en double ?')) return;
      const b = $('#iok'); b.disabled = true;
      if (await act(() => api(`/invoices/${id}/apply`, {method: 'POST', body: {lines, location: $('#iloc').value, force: !!inv.duplicate_of}}), 'Bobines ajoutées au stock')) route();
      else b.disabled = false;
    };
  };
  draw();
  let tries = 0;
  const poll = async () => {
    if (inv.photos !== 'pending' || ++tries > 30 || location.hash !== '#/invoices/' + id) return;
    await new Promise(r => setTimeout(r, 2000));
    const n = await api('/invoices/' + id).catch(() => null);
    if (!n || location.hash !== '#/invoices/' + id) return;
    inv.photos = n.photos;
    n.lines.forEach(x => { const l = L.find(y => y.i === x.i); if (l) l.photo = x.photo; });
    draw(); poll();
  };
  poll();
}

// recherche globale (en-tête)
$('#gs').addEventListener('keydown', e => { if (e.key === 'Enter') { spoolState.q = e.target.value; if (location.hash === '#/spools') route(); else location.hash = '#/spools'; } });

api('/settings').then(s => { S = s; applyMenus(s.hidden_menus); }).catch(() => {}).finally(route);


// ---------- Fichiers & sauvegardes de l'imprimante (lecture seule côté imprimante) ----------
const bytes = n => n == null ? '–' : n < 1024 ? n + ' o' : n < 1048576 ? fmt(n / 1024, 1) + ' Ko' : fmt(n / 1048576, 1) + ' Mo';
const ST_TAG = {nouveau: 'ok', modifié: 'warn', supprimé: 'bad', identique: ''};
function diffHtml(t) { return t.split('\n').map(l => `<div class="dl ${l.startsWith('+') && !l.startsWith('+++') ? 'ad' : l.startsWith('-') && !l.startsWith('---') ? 'de' : l.startsWith('@@') ? 'hh' : ''}">${esc(l) || ' '}</div>`).join(''); }
routes.backups = async (el, rest) => {
  if (rest && rest[0]) return backupDetail(el, +rest[0]);
  const r = await api('/backups');
  el.innerHTML = `<div class="bar"><h1 style="margin:0">Fichiers &amp; sauvegardes</h1><span class="sp"></span><button class="btn primary" id="bnow">Sauvegarder maintenant</button></div>
  <p class="mut">PrintLab copie les fichiers de configuration de l'imprimante (printer.cfg, macros, Box, Moonraker, réglages Fluidd…) en <b>lecture seule</b> : rien n'est jamais écrit sur l'imprimante. Une copie est faite automatiquement chaque heure <b>si un fichier a changé</b> (60 copies automatiques conservées, les manuelles sont gardées). Un fichier identique n'est stocké qu'une fois. Pour restaurer : télécharge le fichier ou le ZIP et remets-le toi-même (Fluidd → Configuration).</p>
  <div class="card tw"><table><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Nom</th><th class="r">Fichiers</th><th class="r">Modifiés</th><th class="r">Taille</th><th></th></tr></thead><tbody>
  ${r.snapshots.map(s => `<tr><td>${s.id}</td><td>${dt(s.ts)}</td><td><span class="tag ${s.auto ? '' : 'ok'}">${s.auto ? 'auto' : 'manuelle'}</span></td><td>${esc(s.label || '')}</td><td class="r">${s.nfiles}</td><td class="r">${s.changed}</td><td class="r">${bytes(s.total_size)}</td>
  <td style="white-space:nowrap"><a class="btn sm" href="#/backups/${s.id}">Ouvrir</a> <a class="btn sm" href="/api/backups/${s.id}/zip">ZIP</a> <button class="btn sm" data-del="${s.id}">Supprimer</button></td></tr>`).join('') || '<tr><td colspan="8" class="mut">Aucune sauvegarde pour l\'instant : la première sera faite automatiquement dans quelques minutes, ou clique sur « Sauvegarder maintenant ».</td></tr>'}</tbody></table></div>`;
  $('#bnow').onclick = () => { const l = prompt('Nom de la sauvegarde (facultatif)', ''); if (l === null) return; $('#bnow').disabled = true; act(async () => { await api('/backups', {method: 'POST', body: {label: l || 'manuelle'}}); route(); }, 'Sauvegarde faite').then(() => { const b = $('#bnow'); if (b) b.disabled = false; }); };
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { if (confirm('Supprimer cette sauvegarde ? (l\'imprimante n\'est pas touchée)')) act(async () => { await api('/backups/' + b.dataset.del, {method: 'DELETE'}); route(); }, 'Supprimée'); });
};
async function backupDetail(el, id) {
  const d = await api('/backups/' + id), s = d.snapshot, all = [...d.files, ...d.removed];
  const chg = all.filter(f => f.status !== 'identique').length;
  el.innerHTML = `<div class="bar"><a href="#/backups">← Sauvegardes</a><h1 style="margin:0">Sauvegarde #${s.id}</h1><span class="sp"></span><a class="btn" href="/api/backups/${s.id}/zip">Télécharger le ZIP</a></div>
  <p class="mut">${dt(s.ts)} · ${s.auto ? 'automatique' : 'manuelle'}${s.label ? ' · ' + esc(s.label) : ''} · ${s.nfiles} fichiers · ${bytes(s.total_size)} · ${d.previous ? chg + ' différence(s) avec la sauvegarde #' + d.previous : 'première sauvegarde'}</p>
  <div class="bar"><label><input type="checkbox" id="onlyc" ${d.previous && chg ? 'checked' : ''}> Afficher seulement les fichiers modifiés</label></div>
  <div class="card tw"><table id="bft"><thead><tr><th>Fichier</th><th>Statut</th><th class="r">Taille</th><th></th></tr></thead><tbody>
  ${all.map(f => `<tr data-st="${f.status}"><td><code>${esc(f.path)}</code></td><td>${f.status === 'identique' ? '<span class="mut">identique</span>' : `<span class="tag ${ST_TAG[f.status]}">${f.status}</span>`}</td><td class="r">${bytes(f.size)}</td>
  <td style="white-space:nowrap">${f.status === 'supprimé' ? '' : `<button class="btn sm" data-v="${esc(f.path)}">Voir</button> <button class="btn sm" data-d="prev" data-p="${esc(f.path)}">Diff / précédente</button> <button class="btn sm" data-d="live" data-p="${esc(f.path)}">Diff / imprimante</button> <a class="btn sm" href="/api/backups/${s.id}/file?dl=1&path=${encodeURIComponent(f.path)}">Télécharger</a>`}</td></tr>`).join('')}</tbody></table></div>`;
  const filt = () => el.querySelectorAll('#bft tbody tr').forEach(tr => tr.hidden = $('#onlyc').checked && tr.dataset.st === 'identique'); $('#onlyc').onchange = filt; filt();
  el.querySelectorAll('[data-v]').forEach(b => b.onclick = async () => { const t = await (await fetch(`/api/backups/${s.id}/file?path=` + encodeURIComponent(b.dataset.v))).text(); modal(`<h2>${esc(b.dataset.v)}</h2><pre class="fview">${esc(t)}</pre><div class="acts"><button class="btn" onclick="closeModal()">Fermer</button></div>`); $('#modal .box').style.width = 'min(980px,100%)'; });
  el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => act(async () => { const r = await api(`/backups/${s.id}/diff?path=${encodeURIComponent(b.dataset.p)}&against=${b.dataset.d}`); modal(`<h2>${esc(b.dataset.p)}</h2><p class="mut">${b.dataset.d === 'live' ? 'Cette sauvegarde ↔ l\'imprimante maintenant' : 'Sauvegarde précédente ↔ cette sauvegarde'}</p>${r.diff ? `<div class="fview diff">${diffHtml(r.diff)}</div>` : `<p>${esc(r.note || 'Identique.')}</p>`}<div class="acts"><button class="btn" onclick="closeModal()">Fermer</button></div>`); $('#modal .box').style.width = 'min(980px,100%)'; }));
}


// ---------- Recherche de modèles 3D (multi-sites) ----------
// Printables : résultats affichés dans PrintLab (API publique). Les autres sites bloquent les robots : on ouvre leur recherche.
const MSITES = [
  {id: 'printables', name: 'Printables', url: 'https://www.printables.com/search/models?q={q}', inapp: true},
  {id: 'makerworld', name: 'MakerWorld', url: 'https://makerworld.com/fr/search/models?keyword={q}'},
  {id: 'thingiverse', name: 'Thingiverse', url: 'https://www.thingiverse.com/search?q={q}', inapp: true},
  {id: 'cults', name: 'Cults', url: 'https://cults3d.com/fr/recherche?q={q}'},
  {id: 'mmf', name: 'MyMiniFactory', url: 'https://www.myminifactory.com/search/?query={q}'},
  {id: 'thangs', name: 'Thangs', url: 'https://thangs.com/search/{q}?scope=all'},
  {id: 'yeggi', name: 'Yeggi', url: 'https://www.yeggi.com/q/{q}/'},
  {id: 'cgtrader', name: 'CGTrader', url: 'https://www.cgtrader.com/3d-print-models?keywords={q}'},
];
const msUrl = (s, q) => s.url.replace('{q}', encodeURIComponent(q));
const msSel = () => { try { const v = JSON.parse(localStorage.getItem('pl-msites')); if (Array.isArray(v)) return v; } catch {} return MSITES.map(s => s.id); };
routes.models = async (el, rest) => {
  let sel = msSel();
  const q0 = decodeURIComponent(rest && rest[0] || '');
  el.innerHTML = `<h1>Recherche de modèles 3D</h1>
  <form id="msf" class="bar"><input id="msq" class="gsearch" style="flex:1;max-width:520px" placeholder="Que cherches-tu ? ex. « support casque »" autocomplete="off" value="${esc(q0)}"><button class="btn primary" type="submit">Chercher</button></form>
  <div class="chips" id="mssites">${MSITES.map(s => `<button type="button" class="chip ${sel.includes(s.id) ? 'on' : ''}" data-s="${s.id}">${esc(s.name)}</button>`).join('')}</div>
  <p class="mut" style="margin:8px 0 14px">Coche les sites à interroger. Les résultats de <b>Printables</b> et <b>Thingiverse</b> s'affichent ici ; les autres sites protègent leur recherche contre les robots, PrintLab t'ouvre donc leur page de résultats.</p>
  <div id="msr"></div>`;
  const saveSel = () => { try { localStorage.setItem('pl-msites', JSON.stringify(sel)); } catch {} };
  el.querySelectorAll('#mssites .chip').forEach(c => c.onclick = () => { const id = c.dataset.s; sel = sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]; c.classList.toggle('on', sel.includes(id)); saveSel(); });
  const run = async () => {
    const q = $('#msq').value.trim(); const out = $('#msr');
    if (!q) { out.innerHTML = ''; return; }
    history.replaceState(null, '', '#/models/' + encodeURIComponent(q));
    const sites = MSITES.filter(s => sel.includes(s.id));
    if (!sites.length) { out.innerHTML = '<p class="mut">Coche au moins un site.</p>'; return; }
    const ext = sites.filter(s => !s.inapp);
    const inapp = sites.filter(s => s.inapp);
    out.innerHTML = `${ext.length ? `<div class="card" style="padding:12px 14px;margin-bottom:14px"><b>Ouvrir la recherche « ${esc(q)} » sur :</b>
      <div class="chips" style="margin-top:8px">${ext.map(s => `<a class="btn sm" href="${esc(msUrl(s, q))}" target="_blank" rel="noopener">${esc(s.name)} ↗</a>`).join('')}
      ${ext.length > 1 ? '<button type="button" class="btn sm primary" id="msall">Tout ouvrir</button>' : ''}</div></div>` : ''}
      ${inapp.map(s => `<h2>${esc(s.name)}</h2><div id="ms_${s.id}" class="mut">Recherche…</div>`).join('')}`;
    if ($('#msall')) $('#msall').onclick = () => { ext.forEach(s => window.open(msUrl(s, q), '_blank', 'noopener')); };
    inapp.forEach(async s => {
      const box = $('#ms_' + s.id);
      try {
        const r = await api(`/search/${s.id}?q=` + encodeURIComponent(q));
        if (!box) return;
        box.className = '';
        box.innerHTML = r.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))">${r.map(m => `<a class="card" href="${esc(m.url)}" target="_blank" rel="noopener" style="padding:0;overflow:hidden;color:inherit;text-decoration:none">
          ${m.image ? `<img src="${esc(m.image)}" loading="lazy" alt="" referrerpolicy="no-referrer" style="width:100%;aspect-ratio:1;object-fit:cover;display:block">` : ''}
          <div style="padding:8px 10px"><b style="display:block;font-size:13px">${esc(m.title)}</b><span class="mut" style="font-size:12px">${esc(m.author || '')}${m.likes != null ? ' · ♥ ' + fmt(m.likes) : ''}</span></div></a>`).join('')}</div>
          <p><a href="${esc(msUrl(s, q))}" target="_blank" rel="noopener">Voir plus sur ${esc(s.name)} ↗</a></p>` : `<p class="mut">Aucun résultat sur ${esc(s.name)}.</p>`;
      } catch (e) { if (box) box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    });
  };
  $('#msf').onsubmit = e => { e.preventDefault(); run(); };
  if (q0) run(); else $('#msq').focus();
};

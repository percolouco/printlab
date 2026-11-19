// Petits utilitaires partagés : appels API, notifications, attente, fenêtres modales.

export async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.json !== undefined) {
    o.body = JSON.stringify(o.json);
    o.headers['Content-Type'] = 'application/json';
    o.method = o.method || 'POST';
    delete o.json;
  }
  const r = await fetch(path, o);
  if (r.status === 401) { location.href = '/login'; throw new Error('Session expirée'); }
  if (!r.ok) {
    let msg = r.statusText;
    try { const d = await r.json(); msg = d.detail || msg; } catch {}
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) return r.json();
  if (opts.raw === 'text' || ct.startsWith('text/')) return r.text();
  return r.arrayBuffer();
}

export function toast(msg, kind = '', ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function busy(text) {
  const b = document.getElementById('busy');
  if (text === false) { b.classList.add('hidden'); return; }
  document.getElementById('busy-text').textContent = text || '';
  b.classList.remove('hidden');
}

export function modal(title, content) {
  const m = document.getElementById('modal');
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  if (typeof content === 'string') body.innerHTML = content; else body.appendChild(content);
  m.classList.remove('hidden');
  return { close: () => m.classList.add('hidden'), body };
}
document.getElementById('modal-close').onclick = () => document.getElementById('modal').classList.add('hidden');
// Échap ferme la fenêtre ouverte (comme les dialogues d'Orca), même si un champ a le focus
document.addEventListener('keydown', (e) => {
  const m = document.getElementById('modal');
  if (e.key === 'Escape' && !m.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); document.getElementById('modal-close').click(); }
}, true);
document.getElementById('modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') document.getElementById('modal').classList.add('hidden');
});

export function prompt2(title, label, value = '') {
  return new Promise((resolve) => {
    const wrap = document.createElement('form');
    wrap.innerHTML = `<label class="muted small">${label}</label><div class="row gap" style="margin-top:6px">
      <input style="flex:1" value="${esc(value)}"><button class="btn primary">OK</button></div>`;
    const m = modal(title, wrap);
    const inp = wrap.querySelector('input');
    inp.focus(); inp.select();
    wrap.onsubmit = (e) => { e.preventDefault(); m.close(); resolve(inp.value.trim() || null); };
    document.getElementById('modal-close').addEventListener('click', () => resolve(null), { once: true });
  });
}

export function confirm2(title, text, okLabel = 'Confirmer', danger = false) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<p>${text}</p><div class="row gap" style="justify-content:flex-end">
      <button class="btn" data-r="0">Annuler</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${okLabel}</button></div>`;
    const m = modal(title, wrap);
    wrap.querySelectorAll('button').forEach((b) => b.onclick = () => { m.close(); resolve(b.dataset.r === '1'); });
  });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

// "1d 2h 3m 4s" (format Orca) -> secondes
export function parseOrcaTime(t) {
  if (!t) return 0;
  let s = 0;
  for (const [, n, u] of String(t).matchAll(/(\d+)\s*([dhms])/g)) s += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return s;
}

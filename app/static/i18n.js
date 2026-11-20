// PrintLab — choix de la langue (français / anglais) pour toute l'interface, Slicer compris.
// L'interface est écrite en français ; en anglais, chaque texte affiché est remplacé à la volée d'après le
// dictionnaire i18n-en.js (textes exacts, et modèles « {} » pour les textes qui contiennent des valeurs).
// Langue : choix mémorisé dans le navigateur, sinon celle du navigateur (français → FR, sinon EN).
(function () {
  'use strict';
  const KEY = 'pl-lang';
  function detect() {
    try { const v = localStorage.getItem(KEY) || localStorage.getItem('slicer-lang'); if (v === 'en' || v === 'fr') return v; } catch (e) { /* stockage indisponible */ }
    return String(navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';
  }
  const LANG = detect();
  window.PL_LANG = LANG;
  window.PL_LOCALE = LANG === 'en' ? 'en-GB' : 'fr-FR';
  window.plSetLang = function (l) {
    try { localStorage.setItem(KEY, l); localStorage.setItem('slicer-lang', l); } catch (e) { /* ignoré */ }
    location.reload();
  };
  window.plT = s => s;                       // traduction d'un texte isolé (utilisable par le code)
  // bouton de langue de la barre du haut : affiche la langue vers laquelle on bascule
  const setBtn = () => document.querySelectorAll('.langb').forEach(b => { b.textContent = LANG === 'en' ? 'FR' : 'EN'; b.title = LANG === 'en' ? 'Passer en français' : 'Switch to English'; });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setBtn); else setBtn();
  if (LANG !== 'en') return;
  document.documentElement.lang = 'en';

  const EN = window.PL_EN || {};
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // modèles : « Buse {} °C · plateau {} °C » → expression régulière ; on teste d'abord le plus long morceau fixe (rapide)
  const TPL = [];
  for (const k of Object.keys(EN)) {
    if (!k.includes('{}')) continue;
    const parts = k.split('{}');
    const anchor = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
    if (anchor.trim().length < 2 || parts.slice(1, -1).some(x => x === '')) continue;  // modèle trop vague (« {} {} ») ou ambigu (« {}{} ») : ignoré
    TPL.push({anchor, re: new RegExp('^' + parts.map(reEsc).join('(.*?)') + '$', 's'), out: EN[k], len: k.length});
  }
  TPL.sort((a, b) => b.len - a.len);         // le plus précis d'abord
  const FRW = /\b(le|la|les|des|du|de|une|un|et|pour|dans|sur|avec|sans|est|sont|pas|aucun|aucune|ce|cette|à)\b/gi;
  const cache = new Map();
  function fill(out, groups) {
    let i = 0;
    return out.replace(/\{-?\}/g, m => { const g = groups[i++] ?? ''; return m === '{-}' ? '' : (EN[norm(g)] || g); });
  }
  function trCore(t) {
    if (EN[t] !== undefined) return EN[t];
    for (const p of TPL) {
      if (!t.includes(p.anchor)) continue;
      const m = p.re.exec(t);
      // une valeur insérée qui ressemble à une phrase française non traduite = mauvais modèle (évite les traductions à moitié)
      if (m && !m.slice(1).some(g => g.length > 24 && EN[norm(g)] === undefined && (g.match(FRW) || []).length >= 2)) return fill(p.out, m.slice(1));
    }
    return null;
  }
  function tr(s) {
    if (s == null) return null;
    const t = norm(String(s));
    if (!t || !/[A-Za-zÀ-ÿ]/.test(t)) return null;
    let r = cache.get(t);
    if (r === undefined) { r = trCore(t); if (cache.size > 5000) cache.clear(); cache.set(t, r); }
    if (r === null) return null;
    const lead = String(s).match(/^\s*/)[0], trail = String(s).match(/\s*$/)[0];
    return lead + r + trail;
  }
  window.plT = s => tr(s) ?? s;

  const SKIP = /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/;
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];
  function trText(n) {
    const p = n.parentElement;
    if (!p || SKIP.test(p.tagName) || p.closest('[data-notr],[contenteditable="true"]')) return;
    const r = tr(n.nodeValue); if (r !== null && r !== n.nodeValue) n.nodeValue = r;
  }
  function trAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a); if (!v) continue;
      const r = tr(v); if (r !== null && r !== v) el.setAttribute(a, r);
    }
    if (el.tagName === 'INPUT' && /^(button|submit)$/i.test(el.type) && el.value) { const r = tr(el.value); if (r !== null && r !== el.value) el.value = r; }
  }
  function walk(root) {
    if (root.nodeType === 3) { trText(root); return; }
    if (root.nodeType !== 1 || SKIP.test(root.tagName) || root.closest?.('[data-notr]')) return;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) trText(n);
    trAttrs(root);
    root.querySelectorAll('[title],[placeholder],[aria-label],[alt],[data-tip],input[type=button],input[type=submit]').forEach(trAttrs);
  }
  // boîtes de dialogue natives
  const _c = window.confirm.bind(window), _a = window.alert.bind(window), _p = window.prompt.bind(window);
  window.confirm = m => _c(window.plT(m));
  window.alert = m => _a(window.plT(m));
  window.prompt = (m, d) => _p(window.plT(m), d);

  function start() {
    if (document.title) document.title = window.plT(document.title);
    walk(document.body);
    new MutationObserver(ms => {
      for (const m of ms) {
        if (m.type === 'characterData') trText(m.target);
        else if (m.type === 'attributes') trAttrs(m.target);
        else m.addedNodes.forEach(walk);
      }
    }).observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS});
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

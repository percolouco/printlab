// Service worker minimal : rend PrintLab installable (Android / Chrome). Aucune mise en cache : tout vient du serveur,
// les données affichées sont donc toujours à jour. Hors connexion, une page simple l'indique.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrintLab</title>' +
    '<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0;background:#f3f5f7;color:#1b2430;text-align:center">' +
    '<div><h2>PrintLab injoignable</h2><p>Vérifie que tu es sur le réseau de la maison (ou le VPN).</p>' +
    '<button onclick="location.reload()" style="font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#b4531f;color:#fff">Réessayer</button></div>',
    {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
});

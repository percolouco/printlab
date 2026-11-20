// Interface en anglais (Orca est multilingue) : les libellés des réglages viennent de la traduction d'Orca lue à
// l'envers (/slicer/api/schema?lang=en) ; le reste de l'interface est traduit ici, texte par texte, au fil des
// changements de la page (MutationObserver). Langue mémorisée dans le navigateur (« slicer-lang »).
const KEY = 'slicer-lang';
// La langue est commune à tout PrintLab (/static/i18n.js) ; repli sur l'ancien réglage du Slicer.
export function lang() { if (window.PL_LANG) return window.PL_LANG; try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'fr'; } catch { return 'fr'; } }
export function setLang(l) { if (window.plSetLang) return window.plSetLang(l); try { localStorage.setItem(KEY, l); } catch { /* stockage indisponible */ } location.reload(); }

const EN = {
  '/ Slicer': '/ Slicer', 'Accélération': 'Acceleration', 'Aide': 'Help', 'Ajouter': 'Add', 'Ajouter des modèles (Ctrl+I)': 'Add models (Ctrl+I)',
  'Ajouter un filament': 'Add filament', 'Ajouter un modificateur ou un bloqueur de support': 'Add a modifier or support blocker',
  "Ajouter à cette couche : pause, changement de filament, G-code personnalisé (comme le « + » du curseur d'Orca)": 'Add to this layer: pause, filament change, custom G-code (like the "+" on Orca\'s slider)',
  'Aligner': 'Align', 'Aligner / répartir les objets sélectionnés (Ctrl+clic), ou un objet par rapport au plateau': 'Align / distribute the selected objects (Ctrl+click), or one object to the plate',
  'Annuler': 'Undo', 'Annuler (Ctrl+Z)': 'Undo (Ctrl+Z)', 'Aperçu': 'Preview', "Arrêt d'urgence": 'Emergency stop', 'Assemblage': 'Assembly',
  "Assemblage (Y) : plaquer une face d'une pièce contre la face d'une autre": 'Assembly (Y): put a face of one part against a face of another',
  'Assembler': 'Merge', 'Assembler les objets sélectionnés (Ctrl+clic dans la liste) en un objet à plusieurs pièces': 'Merge the selected objects (Ctrl+click in the list) into one multi-part object',
  'Avancé': 'Advanced', 'Booléen': 'Boolean', "Booléen (B) : union, différence ou intersection entre deux pièces d'un même objet": 'Boolean (B): union, difference or intersection between two parts of an object',
  'Calibration…': 'Calibration…', 'Caméra': 'Camera', 'Centrer': 'Center', 'Centrer sur le plateau': 'Center on plate', 'Changements de filament': 'Filament changes',
  'Changements par couche': 'Layer changes', 'Changer de vue (Ctrl+0 défaut, Ctrl+1 dessus, Ctrl+2 dessous, Ctrl+3 face, Ctrl+4 arrière, Ctrl+5 gauche, Ctrl+6 droite)': 'Change view (Ctrl+0 default, Ctrl+1 top, Ctrl+2 bottom, Ctrl+3 front, Ctrl+4 rear, Ctrl+5 left, Ctrl+6 right)',
  'Cloner (Ctrl+K ou +)': 'Clone (Ctrl+K or +)', 'Commande G-code (ex. M104 S200)': 'G-code command (e.g. M104 S200)', 'Commandes': 'Controls', 'Couper': 'Cut',
  "Couper l'objet par un plan (avec connecteurs), comme l'outil Coupe d'Orca (C)": 'Cut the object with a plane (with connectors), like Orca\'s Cut tool (C)',
  'Coutures': 'Seams', 'Disposer': 'Arrange', 'Disposer automatiquement (A) — options : clic droit': 'Auto arrange (A) — options: right click', 'Dupliquer': 'Clone',
  'Débit volumétrique': 'Volumetric flow', "Découpe le plateau pour voir l'aperçu.": 'Slice the plate to see the preview.', 'Découper le plateau': 'Slice plate',
  'Découper tous les plateaux non vides': 'Slice all non-empty plates', 'Démarrer': 'Start', 'Démarrer la file : les impressions s\'enchaînent': 'Start the queue: prints run one after another',
  'Déplacements': 'Travel', 'Déplacer': 'Move', 'Déplacer (M)': 'Move (M)', 'Dépose tes fichiers STL, 3MF, OBJ ou STEP ici': 'Drop your STL, 3MF, OBJ or STEP files here',
  'Dérétractions': 'Deretractions', 'Développeur': 'Developer', 'Enregistrer comme profil utilisateur': 'Save as user preset', 'Enregistrer en .3mf (Orca) — Ctrl+S': 'Save as .3mf (Orca) — Ctrl+S',
  'Enregistrer le projet': 'Save project', 'Enregistrer sous…': 'Save as…', 'Envoyer': 'Send', 'Essuyages': 'Wipes', 'Face au sol': 'Lay on face',
  "Fichiers sur l'imprimante": 'Files on the printer', 'Filament': 'Filament', 'Filaments': 'Filaments', "File d'attente": 'Queue',
  'Forme SVG en relief, en creux ou en modificateur, posée sur une face': 'SVG shape, embossed, engraved or as a modifier, placed on a face', 'Global': 'Global',
  'Gérer les profils : comparer, importer, exporter, supprimer': 'Manage presets: compare, import, export, delete', 'Hauteur de couche': 'Layer height',
  'Hauteur de couche variable (adaptative, lissage, édition), comme Orca': 'Variable layer height (adaptive, smoothing, editing), like Orca', 'Hauteur de couche variable…': 'Variable layer height…',
  'Historique': 'History', 'Impression couleur': 'Color print', 'Impression en cours': 'Printing', 'Imprimante': 'Printer', 'Jerk': 'Jerk', 'Largeur de ligne': 'Line width',
  "Lecture animée de l'impression (Espace)": 'Play the print (Space)', 'Lire les RFID': 'Read RFID', 'Mesure': 'Measure', 'Mesurer (U) : clique deux points sur les objets': 'Measure (U): click two points on the objects',
  "Mettre à l'échelle (S)": 'Scale (S)', 'Miroir': 'Mirror', 'Modif.': 'Modifier', 'Modifier le profil imprimante': 'Edit printer preset', 'Modèle': 'Model', 'Moteurs off': 'Motors off',
  "Niveau d'affichage des réglages (comme Orca : Simple / Avancé ; Développeur = mode développeur des préférences)": 'Settings level (like Orca: Simple / Advanced; Developer = developer mode)',
  'Nivellement': 'Leveling', 'Nouveau projet': 'New project', 'Objet': 'Object', 'Objets': 'Objects', 'Oreilles': 'Brim ears',
  'Oreilles de bordure (E) : petites pastilles de bordure aux coins de la première couche': 'Brim ears (E): small brim pads at the corners of the first layer',
  "Orientation automatique (Q), algorithme d'Orca : objet sélectionné, ou tout le plateau (Maj+Q)": 'Auto orient (Q), Orca\'s algorithm: selected object, or the whole plate (Shift+Q)',
  'Orienter': 'Orient', 'Origine (G28)': 'Home (G28)', 'Ouvrir un projet .3mf (Orca, QIDI, Bambu)…': 'Open a .3mf project (Orca, QIDI, Bambu)…', 'Ouvrir un projet…': 'Open project…',
  'Pause': 'Pause', 'Pauses': 'Pauses', 'Peindre': 'Paint', 'Peindre (comme Orca) : supports L, couture P, couleurs N, fuzzy skin H': 'Paint (like Orca): supports L, seam P, colors N, fuzzy skin H',
  'Pivoter': 'Rotate', 'Pivoter (R)': 'Rotate (R)', 'Plateau': 'Plate', 'Poser sur une face (F) : cliquer ensuite la face à poser sur le plateau': 'Lay on face (F): then click the face to put on the plate',
  'Pressure advance': 'Pressure advance', 'Projet ▾': 'Project ▾', 'Préparer': 'Prepare', 'QIDI Box': 'QIDI Box', 'Raccourcis': 'Shortcuts', 'Raccourcis clavier (?)': 'Keyboard shortcuts (?)',
  'Rechercher un réglage…': 'Search a setting…', 'Replier / déplier': 'Collapse / expand', 'Reprendre': 'Resume', 'Retour à PrintLab': 'Back to PrintLab',
  'Récupérer les filaments chargés dans la QIDI Box': 'Get the filaments loaded in the QIDI Box', 'Réglages': 'Settings', 'Réglages modifiés (projet, filaments, objets)': 'Modified settings (project, filaments, objects)',
  'Réparer': 'Repair', 'Réparer le maillage (trous, faces inversées, doublons)': 'Repair the mesh (holes, flipped faces, duplicates)', 'Rétablir': 'Redo', 'Rétablir (Ctrl+Y)': 'Redo (Ctrl+Y)',
  'Rétractions': 'Retractions', 'Se déconnecter': 'Log out', 'Simple': 'Simple', 'Simplifier': 'Simplify', 'Simplifier : réduire le nombre de triangles (gros modèles)': 'Simplify: reduce the number of triangles (large models)',
  'Suppr.': 'Delete', 'Supprimer la sélection (Suppr) — tout supprimer : Ctrl+D': 'Delete selection (Del) — delete all: Ctrl+D', 'Sécher…': 'Dry…', 'Séparer': 'Split',
  "Séparer l'objet en objets ou en pièces (parties non reliées)": 'Split the object into objects or parts (unconnected pieces)', 'Taille X': 'Size X', 'Taille Y': 'Size Y', 'Taille Z': 'Size Z',
  'Temps de couche (linéaire)': 'Layer time (linear)', 'Temps de couche (logarithmique)': 'Layer time (logarithmic)', 'Température': 'Temperature', 'Températures': 'Temperatures',
  'Texte': 'Text', 'Texte 3D en relief, en creux ou en modificateur, posé sur une face (T)': '3D text, embossed, engraved or as a modifier, placed on a face (T)', 'Texture': 'Texture',
  "Texture en relief (D) : cuir, moletage, hexagones… appliqués à la surface de l'objet": 'Texture displacement (D): leather, knurl, hexagons… applied to the object surface',
  'Tout découper': 'Slice all', 'Type de ligne': 'Line type', 'Type de plateau': 'Plate type',
  'Type de plateau : détermine la température de plateau utilisée (réglages du filament)': 'Plate type: sets the bed temperature used (filament settings)',
  'Télécharger le plateau découpé (.3mf)': 'Download the sliced plate (.3mf)', 'Visite guidée du Slicer': 'Slicer guided tour', 'Vitesse': 'Speed', 'Vitesse de lecture': 'Playback speed',
  'Vitesse du ventilateur': 'Fan speed', 'Vitesse réelle': 'Actual speed', 'Volumes de purge': 'Flushing volumes', 'Vue': 'View', 'Éch. X %': 'Scale X %', 'Éch. Y %': 'Scale Y %',
  'Éch. Z %': 'Scale Z %', 'Échelle': 'Scale', 'Échelle uniforme': 'Uniform scale', 'Éclairage': 'Lighting', 'État détaillé': 'Detailed status',
  // panneaux et éléments dynamiques
  'Plateau vide': 'Empty plate', 'Personnalisé': 'Custom', 'Bordure': 'Brim', 'Paroi extérieure': 'Outer wall', 'Paroi intérieure': 'Inner wall', 'Surface inférieure': 'Bottom surface',
  'Surface supérieure': 'Top surface', 'Remplissage plein interne': 'Internal solid infill', 'Remplissage': 'Sparse infill', 'Pont': 'Bridge', 'Pont interne': 'Internal bridge',
  'Paroi en surplomb': 'Overhang wall', 'Remplissage d\'espace': 'Gap infill', 'Support': 'Support', 'Interface de support': 'Support interface', 'Tour de purge': 'Prime tower', 'Jupe': 'Skirt',
  'Résumé': 'Summary', 'Temps estimé': 'Estimated time', 'Fin si lancé maintenant': 'Finishes if started now', 'Couches': 'Layers', 'Filament total': 'Total filament',
  'Imprimer': 'Print', 'Envoyer sans lancer': 'Upload only', 'Ajouter à la file': 'Add to queue', 'G-code': 'G-code', '3MF': '3MF',
  '+ Ajouter un filament mixte': '+ Add mixed filament', 'Réglages du filament…': 'Filament settings…', 'Retirer ce filament': 'Remove this filament', 'Box': 'Box',
  'Qualité': 'Quality', 'Intensité': 'Strength', 'Supports': 'Support', 'Multi-matériaux': 'Multimaterial', 'Autres': 'Others',
  'Oreilles de bordure': 'Brim ears', 'Générer automatiquement': 'Auto-generate', 'Rayon': 'Radius', 'Angle max': 'Max angle', 'Rayon de détection': 'Detection radius',
  'Texture en relief': 'Texture displacement', 'Appliquer la texture': 'Apply texture', 'Profondeur (mm)': 'Depth (mm)', 'Taille du motif (mm)': 'Tile size (mm)', 'Rotation (°)': 'Rotation (°)',
  'Niveau neutre': 'Midlevel', 'Adoucir': 'Smoothing', 'Zone': 'Area', 'Côtés': 'Sides', "Tout l'objet": 'Whole object', 'Dessus': 'Top', 'Inverser': 'Invert', 'Base plane (adhérence)': 'Flat base (adhesion)',
  'Union': 'Union', 'Différence': 'Difference', 'Intersection': 'Intersection', 'Pièce 1': 'Part 1', 'Pièce 2': 'Part 2', 'Soustraire de': 'Subtract from', 'Soustraire avec': 'Subtract with',
  "Supprimer la pièce d'entrée": 'Delete input', 'Choisir les faces': 'Pick faces', 'Simplifier ': 'Simplify', 'Niveau de détail': 'Detail level', 'Taux de réduction': 'Decimate ratio',
  'Très élevé': 'Extra high', 'Élevé': 'High', 'Moyen': 'Medium', 'Bas': 'Low', 'Très bas': 'Extra low', 'Gauche': 'Left', 'Centre': 'Center', 'Droite': 'Right', 'Avant': 'Front',
  'Arrière': 'Back', 'Répartir': 'Distribute', 'Options de disposition': 'Arrange options', 'Moteur': 'Engine', 'Autoriser la rotation': 'Allow rotation', 'Raccourcis clavier': 'Keyboard shortcuts',
  'Calibration': 'Calibration', 'Préparer ': 'Prepare', 'Séparer ': 'Split', 'Coupe': 'Cut', 'Projet': 'Project', 'Édition': 'Edit', 'Placement': 'Placement', 'Outils': 'Tools', 'Peinture': 'Painting',
  'Découpe et impression': 'Slicing and printing', 'Modèle 3D': '3D model', 'Langue : English': 'Language: Français', 'Fermer': 'Close', 'OK': 'OK', 'Annuler ': 'Cancel',
};
const PATTERNS = [
  [/^(\d+) objet\(s\)$/, '$1 object(s)'], [/^Plateau (\d+)$/, 'Plate $1'], [/^couche (\d+) · ([\d.]+) mm$/, 'layer $1 · $2 mm'],
  [/^découpé en ([\d.]+) s$/, 'sliced in $1 s'],
];

function tr(s) {
  const t = s.trim();
  if (!t) return null;
  if (EN[t]) return s.replace(t, EN[t]);
  for (const [re, rep] of PATTERNS) if (re.test(t)) return s.replace(t, t.replace(re, rep));
  return null;
}

function walk(root) {
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = it.nextNode(); n; n = it.nextNode()) {
    if (n.parentElement && /SCRIPT|STYLE|TEXTAREA/.test(n.parentElement.tagName)) continue;
    const r = tr(n.nodeValue); if (r !== null && r !== n.nodeValue) n.nodeValue = r;
  }
  if (root.querySelectorAll) {
    for (const el of [root, ...root.querySelectorAll('[title],[placeholder],[aria-label]')]) {
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute?.(a); if (!v) continue;
        const r = tr(v); if (r !== null && r !== v) el.setAttribute(a, r);
      }
    }
  }
}

export function startTranslation() {
  if (window.PL_EN) return;  // traduction déjà assurée par le moteur commun de PrintLab (dictionnaire fusionné)
  if (lang() !== 'en') return;
  document.documentElement.lang = 'en';
  walk(document.body);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') { const r = tr(m.target.nodeValue); if (r !== null && r !== m.target.nodeValue) m.target.nodeValue = r; }
      else if (m.type === 'attributes') { const v = m.target.getAttribute(m.attributeName); const r = v && tr(v); if (r && r !== v) m.target.setAttribute(m.attributeName, r); }
      else m.addedNodes.forEach((n) => { if (n.nodeType === 1) walk(n); else if (n.nodeType === 3) { const r = tr(n.nodeValue); if (r !== null && r !== n.nodeValue) n.nodeValue = r; } });
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] });
}

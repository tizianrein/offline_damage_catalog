# Damage Inspector

Mobile-fähige Web-App zur Schadenserfassung an 3D-Modellen.
Offline-tauglich für Field-Work ohne Internet.

## Setup

Einmaliges Setup nach `git clone`:

```bash
bash setup-vendor.sh
```

Lädt Three.js und JSZip in `./vendor/` herunter (~1.5 MB).
**Den `vendor/`-Ordner ins Repo committen** — sonst funktioniert die
App offline nicht.

Dann optional ein 3D-Modell `model.glb` (oder `model.gltf`) ins Repo
neben `index.html` legen. Wird beim Öffnen automatisch geladen.

## Deployment auf GitHub Pages

```bash
git add .
git commit -m "deploy"
git push
```

Repo Settings → Pages → Source: `main` branch, root.
Nach 1–2 Minuten unter `https://USERNAME.github.io/REPO/` erreichbar.

## Offline-Nutzung (für Studenten in den Alpen)

Die App lädt sich beim ersten Besuch komplett in den Browser-Cache
und in IndexedDB. Damit es zuverlässig funktioniert:

1. **Vor der Tour mit Internet öffnen** und kurz warten, bis im
   Toolbar-Status "Offline-bereit" steht (grüner Punkt).
2. **Auf dem iPhone:** "Zum Home-Bildschirm hinzufügen" via Teilen-Button
   in Safari. Dann startet die App wie eine native App, ohne URL-Leiste.
3. Schäden und Fotos werden lokal in IndexedDB gespeichert, gehen also
   auch nicht beim Schließen der App verloren.
4. Am Ende: **ZIP exportieren** (mit Fotos) und per AirDrop / Mail / WLAN
   zurück an den Dozenten schicken.

## Technische Architektur

- **Storage:** IndexedDB für Damages und Photo-Blobs.
  Migration aus altem localStorage automatisch beim ersten Start.
- **Foto-Komprimierung:** Long-Edge auf 1600px, JPEG q=0.82 vor Speichern.
- **Service Worker:** Cache-first für die App-Shell + Vendor-Libs + Modell.
  Cache-Version in `sw.js` (`CACHE_VERSION`) bumpen wenn Files geändert.
- **PWA:** Manifest mit Standalone-Modus und Maskable-Icons.

## Struktur

```
.
├── index.html
├── app.js              # main UI + 3D
├── storage.js          # IndexedDB layer
├── image-compress.js   # photo resize + reencode
├── style.css
├── sw.js               # service worker
├── manifest.webmanifest
├── model.glb           # (optional) auto-loaded model
└── vendor/             # downloaded libs (run setup-vendor.sh)
    ├── three/
    └── jszip/
```

## Datenformat

Schaden:
```json
{
  "id": "d_lkj…",
  "partId": "leg_front_left",
  "type": "scratch",
  "severity": 3,
  "text": "Tiefer Kratzer entlang der Längskante",
  "point":  { "x": 0.123, "y": 0.045, "z": -0.087 },
  "normal": { "x": 0, "y": 1, "z": 0 },
  "photoIds": ["p_xyz", "p_abc"],
  "createdAt": "2026-…",
  "updatedAt": "2026-…"
}
```

Punkt und Normal sind in **Part-lokalen Koordinaten**. Solange
das Modell mit denselben Part-Namen wieder geladen wird, sitzen die
Marker exakt am richtigen Ort.

/* =============================================================
 * Damage Inspector — main app
 *
 *   - Loads a glTF/GLB into Three.js
 *   - Each named Node becomes a "part" (id = node.name)
 *   - Click on a part places a damage marker (sphere) at the
 *     hit point, stored in the part's LOCAL space
 *   - Damages are kept in localStorage, can be exported as
 *     JSON or as a ZIP with embedded photos
 *   - VR is not implemented but the architecture is friendly:
 *     markers live in part-local space, no DOM overlays for
 *     interaction; the scene is fully self-contained.
 * ============================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';

// ---------------------------------------------------------------
// 0. Constants & state
// ---------------------------------------------------------------

const STORAGE_KEY = 'damage-inspector.v1';
const PHOTO_STORAGE_KEY = 'damage-inspector.photos.v1';

const DAMAGE_TYPES = {
  scratch:     'Kratzer',
  crack:       'Riss',
  dent:        'Delle',
  missing:     'Fehlend',
  deformation: 'Verformung',
  wear:        'Verschleiß',
  stain:       'Fleck',
  other:       'Sonstiges',
};

const COLOR_MARKER          = 0xc1272d;
const COLOR_MARKER_SELECTED = 0x1f4e79;
const COLOR_MARKER_HOVER    = 0xb87a00;
const COLOR_PART_HOVER      = 0x1f4e79;

const state = {
  // model
  modelRoot: null,                      // THREE.Object3D root of loaded glTF scene
  modelMeta: null,                      // { name, partCount, fileName, bbox }
  partsById: new Map(),                 // id (node name) -> THREE.Object3D
  partsList: [],                        // [{ id, object }]

  // damages
  damages: [],                          // see schema below
  /*
    Damage = {
      id:        string,
      partId:    string,
      type:      keyof DAMAGE_TYPES,
      severity:  1..5,
      text:      string,
      point:     { x, y, z },           // LOCAL coords inside the part
      normal:    { x, y, z },           // LOCAL face normal
      photoIds:  [ photoId, ... ],      // references into photos store
      createdAt: ISO string,
      updatedAt: ISO string,
    }
  */
  photos: new Map(),                    // photoId -> { name, mime, dataUrl }

  // ui
  selectedDamageId: null,
  hoveredDamageId:  null,
  hoveredPartId:    null,
  filterPartId:     '',
  damageQuery:      '',
  partQuery:        '',
  xray:             false,
  markersVisible:   true,

  // marker meshes (id -> Mesh, parented to the corresponding part)
  markerMeshes: new Map(),
};

// ---------------------------------------------------------------
// 1. DOM references
// ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const dom = {
  viewerCanvas:   $('viewerCanvas'),
  emptyOverlay:   $('emptyOverlay'),
  status:         $('status'),
  modelMeta:      $('modelMeta'),
  partList:       $('partList'),
  partSearch:     $('partSearch'),
  hoverInfo:      $('hoverInfo'),

  damageCount:    $('damageCount'),
  damageList:     $('damageList'),
  damageSearch:   $('damageSearch'),
  damageFilter:   $('damageFilterPart'),

  markersToggle:  $('markersToggle'),
  xrayToggle:     $('xrayToggle'),

  // modal
  modal:          $('damageModal'),
  modalEyebrow:   $('modalEyebrow'),
  modalTitle:     $('modalTitle'),
  modalPart:      $('modalPart'),
  modalType:      $('modalType'),
  modalSeverity:  $('modalSeverity'),
  modalText:      $('modalText'),
  modalCoords:    $('modalCoords'),
  modalPhotos:    $('modalPhotos'),
  modalSave:      $('modalSaveBtn'),
  modalCancel:    $('modalCancelBtn'),
  modalDelete:    $('modalDeleteBtn'),
  modalClose:     $('modalCloseBtn'),
  addPhotoBtn:    $('addPhotoBtn'),
  photoInput:     $('photoInput'),
};

// ---------------------------------------------------------------
// 2. Three.js setup
// ---------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xecebe6);

const camera = new THREE.PerspectiveCamera(
  45,
  dom.viewerCanvas.clientWidth / dom.viewerCanvas.clientHeight,
  0.01, 5000,
);
camera.position.set(3, 2.5, 4);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(dom.viewerCanvas.clientWidth, dom.viewerCanvas.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
dom.viewerCanvas.appendChild(renderer.domElement);

// lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(4, 6, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xfff2e6, 0.35);
fillLight.position.set(-3, 2, -4);
scene.add(fillLight);

// soft ground reference grid
const grid = new THREE.GridHelper(20, 20, 0xb8b6ad, 0xd6d4cc);
grid.position.y = 0;
grid.material.transparent = true;
grid.material.opacity = 0.6;
scene.add(grid);

// orbit controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0, 0);

// raycaster
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// resize
const ro = new ResizeObserver(() => {
  const w = dom.viewerCanvas.clientWidth;
  const h = dom.viewerCanvas.clientHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
});
ro.observe(dom.viewerCanvas);

// render loop
function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
tick();

// ---------------------------------------------------------------
// 3. glTF loading
// ---------------------------------------------------------------

const gltfLoader = new GLTFLoader();

async function loadGltfFromFile(file) {
  setStatus(`Lade ${file.name} …`);

  const arrayBuf = await file.arrayBuffer();
  const isGlb = file.name.toLowerCase().endsWith('.glb') ||
                file.type === 'model/gltf-binary';

  let gltf;
  try {
    if (isGlb) {
      gltf = await gltfLoader.parseAsync(arrayBuf, '');
    } else {
      // .gltf (json) — may reference external buffers; if you embed via .glb
      // you don't need that. For .gltf with external resources, the user would
      // need to host them; here we accept the JSON only.
      const text = new TextDecoder().decode(arrayBuf);
      gltf = await gltfLoader.parseAsync(text, '');
    }
  } catch (err) {
    console.error(err);
    setStatus(`Fehler beim Laden: ${err.message}`);
    return;
  }

  installModel(gltf.scene, file.name);
}

/**
 * Loads a glTF/GLB by URL. Resource URL is used as base path so .gltf
 * can find external buffers/textures next to it. For .glb everything
 * is embedded so the base doesn't matter.
 *
 * Resolves with `true` if the model was loaded, `false` if the URL
 * was not found (404) — that's a soft failure: the caller can stay
 * silent and let the user load manually.
 */
async function loadGltfFromUrl(url, displayName) {
  const name = displayName || url.split('/').pop() || 'model';
  setStatus(`Lade ${name} …`);
  try {
    // probe first so a missing default model doesn't dump a stack trace
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) {
      if (head.status === 404) return false;
      throw new Error(`HTTP ${head.status}`);
    }
  } catch (err) {
    // network or CORS — surface but don't crash
    console.warn('HEAD probe failed:', err);
    setStatus(`Modell ${name} nicht erreichbar.`);
    return false;
  }

  return new Promise((resolve) => {
    gltfLoader.load(
      url,
      (gltf) => {
        installModel(gltf.scene, name);
        resolve(true);
      },
      undefined,
      (err) => {
        console.error(err);
        setStatus(`Fehler beim Laden von ${name}: ${err?.message || err}`);
        resolve(false);
      },
    );
  });
}

function installModel(rootIn, fileName) {
  // remove previous
  if (state.modelRoot) {
    scene.remove(state.modelRoot);
    disposeHierarchy(state.modelRoot);
  }
  state.modelRoot = rootIn;
  state.partsById.clear();
  state.partsList = [];
  state.markerMeshes.clear();

  // collect parts: any Object3D with a non-empty name AND containing meshes
  // we treat each NAMED node as a "part". An ID is the node name.
  // If two nodes share a name, we suffix with __<n> for uniqueness.
  const seenNames = new Map();

  rootIn.traverse((obj) => {
    if (!obj.name) return;
    // Only accept nodes that have at least one mesh in their subtree —
    // otherwise empty groups would clutter the part list.
    let hasMesh = false;
    obj.traverse((c) => { if (c.isMesh) hasMesh = true; });
    if (!hasMesh) return;

    let id = obj.name;
    const count = seenNames.get(id) || 0;
    if (count > 0) id = `${id}__${count}`;
    seenNames.set(obj.name, count + 1);

    // store stable id on the object for raycasting
    obj.userData.partId = id;
    state.partsById.set(id, obj);
    state.partsList.push({ id, object: obj });
  });

  // tag every mesh in the hierarchy with its owning partId (innermost named ancestor)
  rootIn.traverse((mesh) => {
    if (!mesh.isMesh) return;
    let cur = mesh;
    while (cur && !cur.userData.partId) cur = cur.parent;
    mesh.userData.ownerPartId = cur ? cur.userData.partId : null;
    // store original material(s) for x-ray restore
    mesh.userData.originalMaterial = mesh.material;
  });

  scene.add(rootIn);

  // frame the model
  const bbox = new THREE.Box3().setFromObject(rootIn);
  frameBox(bbox);

  // grid: place under bottom of model
  grid.position.y = bbox.min.y;

  // metadata
  state.modelMeta = {
    fileName,
    partCount: state.partsList.length,
    bbox: {
      min: bbox.min.toArray(),
      max: bbox.max.toArray(),
    },
  };
  dom.modelMeta.textContent = `${fileName} · ${state.partsList.length} Parts`;
  dom.emptyOverlay.classList.add('gone');

  // re-attach existing damages (loaded earlier from storage but
  // could not place markers yet)
  rebuildAllMarkers();

  renderPartList();
  renderDamageList();
  populatePartFilter();
  setStatus(`Geladen: ${fileName} mit ${state.partsList.length} Parts.`);
}

function frameBox(bbox) {
  const size = bbox.getSize(new THREE.Vector3());
  const center = bbox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI / 180) / 2)) * 1.6;
  const dir = new THREE.Vector3(1, 0.7, 1).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.near = maxDim / 1000;
  camera.far  = maxDim * 1000;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function disposeHierarchy(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m && m.dispose && m.dispose());
    }
  });
}

// ---------------------------------------------------------------
// 4. Raycasting & click handling
// ---------------------------------------------------------------

function clientToNDC(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function pickFromEvent(e) {
  if (!state.modelRoot) return null;
  clientToNDC(e);
  raycaster.setFromCamera(ndc, camera);

  // first try markers (they should be picked over the mesh underneath)
  const markerMeshes = [...state.markerMeshes.values()];
  if (state.markersVisible && markerMeshes.length) {
    const hit = raycaster.intersectObjects(markerMeshes, false);
    if (hit.length) return { kind: 'marker', hit: hit[0] };
  }

  // then the model
  const hits = raycaster.intersectObject(state.modelRoot, true);
  if (!hits.length) return null;
  // skip marker meshes that may slip in via traverse
  const meshHit = hits.find((h) => !h.object.userData.isMarker);
  if (!meshHit) return null;
  return { kind: 'mesh', hit: meshHit };
}

let pointerDown = null;
let pointerMoved = false;

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDown = { x: e.clientX, y: e.clientY };
  pointerMoved = false;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (pointerDown) {
    const dx = e.clientX - pointerDown.x;
    const dy = e.clientY - pointerDown.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pointerMoved = true;
  }
  // hover preview
  handleHover(e);
});
renderer.domElement.addEventListener('pointerup', (e) => {
  const wasDrag = pointerMoved;
  pointerDown = null;
  pointerMoved = false;
  if (wasDrag) return;
  handleClick(e);
});
renderer.domElement.addEventListener('pointerleave', () => {
  hideHoverInfo();
});

function handleHover(e) {
  if (!state.modelRoot) return hideHoverInfo();
  const pick = pickFromEvent(e);
  if (!pick) return hideHoverInfo();

  if (pick.kind === 'marker') {
    const id = pick.hit.object.userData.damageId;
    const dmg = state.damages.find((d) => d.id === id);
    if (dmg) {
      showHoverInfo({
        title: 'Schaden',
        rows: [
          ['Typ',  DAMAGE_TYPES[dmg.type] || dmg.type],
          ['Part', dmg.partId],
          ['Sev',  '■'.repeat(dmg.severity) + '□'.repeat(5 - dmg.severity)],
          ['Text', truncate(dmg.text, 60) || '—'],
        ],
      });
      state.hoveredDamageId = id;
      updateMarkerColors();
    }
    return;
  }

  // mesh
  const partId = pick.hit.object.userData.ownerPartId;
  const point = pick.hit.point;
  showHoverInfo({
    title: 'Part',
    rows: [
      ['ID',  partId || '—'],
      ['x',   point.x.toFixed(3)],
      ['y',   point.y.toFixed(3)],
      ['z',   point.z.toFixed(3)],
    ],
  });
  state.hoveredDamageId = null;
  state.hoveredPartId = partId;
  updateMarkerColors();
}

function handleClick(e) {
  if (!state.modelRoot) return;
  const pick = pickFromEvent(e);
  if (!pick) {
    setSelectedDamage(null);
    return;
  }

  if (pick.kind === 'marker') {
    const id = pick.hit.object.userData.damageId;
    setSelectedDamage(id);
    openDamageEditor({ damageId: id });
    return;
  }

  // create new damage
  const partId = pick.hit.object.userData.ownerPartId;
  if (!partId) {
    setStatus('Kein benannter Part getroffen — bitte Modell mit benannten Nodes verwenden.');
    return;
  }

  const partObj = state.partsById.get(partId);
  if (!partObj) return;

  // convert world hit point to part-local space
  partObj.updateWorldMatrix(true, false);
  const localPoint = partObj.worldToLocal(pick.hit.point.clone());

  // local face normal: face.normal is in mesh-local space; convert from
  // mesh-local through world to part-local
  let localNormal = new THREE.Vector3(0, 1, 0);
  if (pick.hit.face) {
    const meshObj = pick.hit.object;
    const worldNormal = pick.hit.face.normal.clone()
      .transformDirection(meshObj.matrixWorld);
    // world -> part local (inverse of partObj.matrixWorld, but for directions
    // we use transformDirection on the inverse)
    const inv = new THREE.Matrix4().copy(partObj.matrixWorld).invert();
    localNormal = worldNormal.transformDirection(inv).normalize();
  }

  openDamageEditor({
    partId,
    point:  { x: localPoint.x, y: localPoint.y, z: localPoint.z },
    normal: { x: localNormal.x, y: localNormal.y, z: localNormal.z },
  });
}

function showHoverInfo({ title, rows }) {
  dom.hoverInfo.classList.remove('hidden');
  dom.hoverInfo.innerHTML = `
    <div class="hud-title">${escapeHtml(title)}</div>
    ${rows.map(([k, v]) =>
      `<div class="hud-row"><span class="hud-key">${escapeHtml(k)}</span><span class="hud-val">${escapeHtml(v ?? '—')}</span></div>`
    ).join('')}
  `;
}
function hideHoverInfo() {
  dom.hoverInfo.classList.add('hidden');
  state.hoveredDamageId = null;
  state.hoveredPartId = null;
  updateMarkerColors();
}

// ---------------------------------------------------------------
// 5. Marker rendering
// ---------------------------------------------------------------

const markerGeo = new THREE.SphereGeometry(1, 18, 14);

function makeMarkerMesh(damage) {
  const mat = new THREE.MeshStandardMaterial({
    color: COLOR_MARKER,
    emissive: 0x3f0009,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.0,
    depthTest: true,
    transparent: false,
  });
  const mesh = new THREE.Mesh(markerGeo, mat);
  mesh.userData.isMarker = true;
  mesh.userData.damageId = damage.id;

  // marker radius scales with model bounding box so it's visible on
  // both a watch and a forklift
  const r = computeMarkerRadius();
  mesh.scale.setScalar(r);

  // place a hair above the surface along the local normal so it
  // doesn't z-fight with the part
  const offset = new THREE.Vector3(damage.normal.x, damage.normal.y, damage.normal.z)
    .normalize().multiplyScalar(r * 0.6);
  mesh.position.set(
    damage.point.x + offset.x,
    damage.point.y + offset.y,
    damage.point.z + offset.z,
  );

  return mesh;
}

function computeMarkerRadius() {
  if (!state.modelRoot) return 0.02;
  const bbox = new THREE.Box3().setFromObject(state.modelRoot);
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return THREE.MathUtils.clamp(maxDim * 0.008, 0.005, 1);
}

function rebuildAllMarkers() {
  // clear
  for (const mesh of state.markerMeshes.values()) {
    mesh.removeFromParent();
    mesh.material?.dispose?.();
  }
  state.markerMeshes.clear();

  if (!state.modelRoot) return;

  for (const dmg of state.damages) {
    const partObj = state.partsById.get(dmg.partId);
    if (!partObj) continue; // damage references missing part — keep data, skip marker
    const mesh = makeMarkerMesh(dmg);
    mesh.visible = state.markersVisible;
    partObj.add(mesh);
    state.markerMeshes.set(dmg.id, mesh);
  }
  updateMarkerColors();
}

function updateMarkerColors() {
  for (const [id, mesh] of state.markerMeshes) {
    const isSel = id === state.selectedDamageId;
    const isHov = id === state.hoveredDamageId;
    const color = isSel ? COLOR_MARKER_SELECTED
                : isHov ? COLOR_MARKER_HOVER
                : COLOR_MARKER;
    mesh.material.color.setHex(color);
    mesh.material.emissive.setHex(
      isSel ? 0x06203a : isHov ? 0x4a3000 : 0x3f0009
    );
    mesh.scale.setScalar(computeMarkerRadius() * (isSel ? 1.35 : 1.0));
  }
}

function setMarkersVisible(visible) {
  state.markersVisible = visible;
  for (const m of state.markerMeshes.values()) m.visible = visible;
}

// ---------------------------------------------------------------
// 6. X-Ray mode
// ---------------------------------------------------------------

function setXRay(on) {
  state.xray = on;
  if (!state.modelRoot) return;
  state.modelRoot.traverse((o) => {
    if (!o.isMesh || o.userData.isMarker) return;
    const orig = o.userData.originalMaterial;
    if (!orig) return;
    if (on) {
      if (!o.userData.xrayMaterial) {
        const mats = Array.isArray(orig) ? orig : [orig];
        o.userData.xrayMaterial = mats.map((m) => {
          const c = m.clone();
          c.transparent = true;
          c.opacity = 0.35;
          c.depthWrite = false;
          return c;
        });
        if (!Array.isArray(orig)) o.userData.xrayMaterial = o.userData.xrayMaterial[0];
      }
      o.material = o.userData.xrayMaterial;
    } else {
      o.material = orig;
    }
  });
}

// ---------------------------------------------------------------
// 7. Damage CRUD
// ---------------------------------------------------------------

function newId(prefix = 'd') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createDamage(data) {
  const now = new Date().toISOString();
  const dmg = {
    id:       newId(),
    partId:   data.partId,
    type:     data.type     || 'scratch',
    severity: data.severity || 3,
    text:     data.text     || '',
    point:    data.point,
    normal:   data.normal   || { x: 0, y: 1, z: 0 },
    photoIds: data.photoIds || [],
    createdAt: now,
    updatedAt: now,
  };
  state.damages.push(dmg);
  saveAll();
  rebuildAllMarkers();
  setSelectedDamage(dmg.id);
  renderDamageList();
  renderPartList();
  populatePartFilter();
  return dmg;
}

function updateDamage(id, patch) {
  const dmg = state.damages.find((d) => d.id === id);
  if (!dmg) return;
  Object.assign(dmg, patch);
  dmg.updatedAt = new Date().toISOString();
  saveAll();
  rebuildAllMarkers();
  renderDamageList();
  renderPartList();
}

function deleteDamage(id) {
  const idx = state.damages.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const dmg = state.damages[idx];
  // GC photos that nobody else references
  for (const pid of (dmg.photoIds || [])) {
    const stillUsed = state.damages.some((d) => d !== dmg && d.photoIds?.includes(pid));
    if (!stillUsed) state.photos.delete(pid);
  }
  state.damages.splice(idx, 1);
  if (state.selectedDamageId === id) state.selectedDamageId = null;
  saveAll();
  rebuildAllMarkers();
  renderDamageList();
  renderPartList();
  populatePartFilter();
}

function setSelectedDamage(id) {
  state.selectedDamageId = id;
  updateMarkerColors();
  renderDamageList(); // to reflect .selected
}

// ---------------------------------------------------------------
// 8. Storage (localStorage)
// ---------------------------------------------------------------

function saveAll() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      damages: state.damages,
      // model meta is nice to have but not authoritative
      modelMeta: state.modelMeta,
    }));
    // photos in their own key (potentially big)
    const photoObj = {};
    for (const [k, v] of state.photos) photoObj[k] = v;
    localStorage.setItem(PHOTO_STORAGE_KEY, JSON.stringify(photoObj));
  } catch (err) {
    console.warn('Storage write failed:', err);
    setStatus(`Speichern fehlgeschlagen: ${err.message} (Fotos zu groß?)`);
  }
}

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.damages = Array.isArray(parsed.damages) ? parsed.damages : [];
    }
    const rawP = localStorage.getItem(PHOTO_STORAGE_KEY);
    if (rawP) {
      const obj = JSON.parse(rawP);
      state.photos = new Map(Object.entries(obj));
    }
  } catch (err) {
    console.warn('Storage read failed:', err);
  }
}

// ---------------------------------------------------------------
// 9. Import / Export
// ---------------------------------------------------------------

function buildExportObject() {
  return {
    schemaVersion: 1,
    generator: 'Damage Inspector',
    exportedAt: new Date().toISOString(),
    model: state.modelMeta,
    damages: state.damages.map((d) => ({
      ...d,
      // photos go via filenames in ZIP; in pure JSON we keep just photoIds
      // and also list referenced filenames so a consumer knows them
      photos: (d.photoIds || []).map((pid) => {
        const p = state.photos.get(pid);
        return p ? { id: pid, fileName: photoFileName(pid, p) } : null;
      }).filter(Boolean),
    })),
  };
}

function photoFileName(pid, photo) {
  const ext = (photo.mime?.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const base = (photo.name || pid).replace(/[^a-z0-9._-]+/gi, '_');
  return `photos/${pid}__${base}.${ext}`;
}

function exportJson() {
  const data = buildExportObject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, suggestedFileName('json'));
  setStatus('JSON exportiert (ohne Bilddaten — nutze ZIP für Fotos).');
}

async function exportZip() {
  const zip = new JSZip();
  const data = buildExportObject();
  zip.file('damages.json', JSON.stringify(data, null, 2));

  const photosFolder = zip.folder('photos');
  for (const [pid, photo] of state.photos) {
    if (!isPhotoReferenced(pid)) continue;
    const dataUrl = photo.dataUrl;
    const comma = dataUrl.indexOf(',');
    const b64 = dataUrl.slice(comma + 1);
    const fileName = photoFileName(pid, photo).replace(/^photos\//, '');
    photosFolder.file(fileName, b64, { base64: true });
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, suggestedFileName('zip'));
  setStatus('ZIP exportiert (mit Fotos).');
}

function isPhotoReferenced(pid) {
  return state.damages.some((d) => d.photoIds?.includes(pid));
}

function suggestedFileName(ext) {
  const baseName = state.modelMeta?.fileName?.replace(/\.[^.]+$/, '') || 'damages';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${baseName}_damages_${stamp}.${ext}`;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip')) return importZip(file);
  if (lower.endsWith('.json')) return importJsonFile(file);
  setStatus('Unbekanntes Format. Bitte .json oder .zip wählen.');
}

async function importJsonFile(file) {
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { setStatus(`JSON ungültig: ${e.message}`); return; }
  applyImported(parsed, null);
  setStatus(`JSON importiert (${parsed.damages?.length ?? 0} Schäden).`);
}

async function importZip(file) {
  const zip = await JSZip.loadAsync(file);
  const jsonEntry = zip.file('damages.json') || zip.file(/damages\.json$/i)[0];
  if (!jsonEntry) { setStatus('ZIP enthält keine damages.json.'); return; }
  const text = await jsonEntry.async('string');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { setStatus(`JSON in ZIP ungültig: ${e.message}`); return; }

  // load photos folder
  const photoMap = new Map();
  const photoFiles = zip.folder('photos');
  if (photoFiles) {
    const entries = [];
    photoFiles.forEach((relPath, entry) => { if (!entry.dir) entries.push(entry); });
    for (const entry of entries) {
      const m = entry.name.match(/photos\/([^_]+)__/);
      // we encoded id before "__" in filename
      const idMatch = entry.name.match(/photos\/([^_]+(?:_[^_]+)*?)__/);
      const pid = idMatch ? idMatch[1] : null;
      const blob = await entry.async('blob');
      const dataUrl = await blobToDataURL(blob);
      const justName = entry.name.replace(/^photos\//, '');
      const ext = justName.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png'
                 : ext === 'gif' ? 'image/gif'
                 : ext === 'webp' ? 'image/webp'
                 : 'image/jpeg';
      const photo = { name: justName, mime, dataUrl };
      const finalPid = pid || newId('p');
      photoMap.set(finalPid, photo);
    }
  }

  applyImported(parsed, photoMap);
  setStatus(`ZIP importiert (${parsed.damages?.length ?? 0} Schäden, ${photoMap.size} Fotos).`);
}

function applyImported(parsed, photoMap) {
  if (!parsed || !Array.isArray(parsed.damages)) {
    setStatus('Datei enthält keine "damages" Liste.');
    return;
  }
  // merge strategy: replace
  state.damages = parsed.damages.map((d) => ({
    ...d,
    photoIds: d.photoIds || (d.photos || []).map((p) => p.id).filter(Boolean),
  }));
  if (photoMap) {
    state.photos = photoMap;
  }
  saveAll();
  rebuildAllMarkers();
  renderDamageList();
  renderPartList();
  populatePartFilter();
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------
// 10. Modal (damage editor)
// ---------------------------------------------------------------

let modalCtx = null;
/* modalCtx = {
     mode: 'new' | 'edit',
     damageId, partId, point, normal,
     draftPhotoIds: [],   // photoIds in this editing session (so that cancel can roll back new uploads)
   }
*/

function openDamageEditor(opts) {
  if (opts.damageId) {
    const dmg = state.damages.find((d) => d.id === opts.damageId);
    if (!dmg) return;
    modalCtx = {
      mode: 'edit',
      damageId: dmg.id,
      partId:   dmg.partId,
      point:    dmg.point,
      normal:   dmg.normal,
      draftPhotoIds: [...(dmg.photoIds || [])],
      addedPhotoIds: [],   // newly added in this session — to roll back on cancel
    };
    dom.modalEyebrow.textContent = 'Schaden bearbeiten';
    dom.modalTitle.textContent   = 'Schaden bearbeiten';
    dom.modalType.value     = dmg.type;
    dom.modalText.value     = dmg.text || '';
    setSeverityUI(dmg.severity);
    dom.modalDelete.hidden  = false;
  } else {
    modalCtx = {
      mode: 'new',
      damageId: null,
      partId:   opts.partId,
      point:    opts.point,
      normal:   opts.normal,
      draftPhotoIds: [],
      addedPhotoIds: [],
    };
    dom.modalEyebrow.textContent = 'Neuer Schaden';
    dom.modalTitle.textContent   = 'Schaden erfassen';
    dom.modalType.value = 'scratch';
    dom.modalText.value = '';
    setSeverityUI(3);
    dom.modalDelete.hidden = true;
  }

  dom.modalPart.textContent = modalCtx.partId;
  dom.modalCoords.textContent =
    `x = ${modalCtx.point.x.toFixed(4)}    ` +
    `y = ${modalCtx.point.y.toFixed(4)}    ` +
    `z = ${modalCtx.point.z.toFixed(4)}`;
  renderModalPhotos();

  dom.modal.hidden = false;
  setTimeout(() => dom.modalText.focus(), 50);
}

function closeDamageEditor(saved) {
  if (!saved && modalCtx) {
    // roll back photos that were added in this session but not committed
    for (const pid of modalCtx.addedPhotoIds) state.photos.delete(pid);
    saveAll();
  }
  modalCtx = null;
  dom.modal.hidden = true;
}

function setSeverityUI(v) {
  for (const btn of dom.modalSeverity.querySelectorAll('button')) {
    btn.classList.toggle('active', Number(btn.dataset.v) === v);
  }
}

function getSeverityUI() {
  const active = dom.modalSeverity.querySelector('button.active');
  return active ? Number(active.dataset.v) : 3;
}

function renderModalPhotos() {
  dom.modalPhotos.innerHTML = '';
  if (!modalCtx) return;
  for (const pid of modalCtx.draftPhotoIds) {
    const photo = state.photos.get(pid);
    if (!photo) continue;
    const tile = document.createElement('div');
    tile.className = 'photo-tile';
    tile.innerHTML = `
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.name || '')}" />
      <button class="photo-rm" title="Entfernen">✕</button>
    `;
    tile.querySelector('.photo-rm').addEventListener('click', () => {
      modalCtx.draftPhotoIds = modalCtx.draftPhotoIds.filter((p) => p !== pid);
      // if it was just added in this session, also drop it from store
      if (modalCtx.addedPhotoIds.includes(pid)) {
        state.photos.delete(pid);
        modalCtx.addedPhotoIds = modalCtx.addedPhotoIds.filter((p) => p !== pid);
      }
      renderModalPhotos();
    });
    dom.modalPhotos.appendChild(tile);
  }
}

async function onPhotoFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 8 * 1024 * 1024) {
      setStatus(`Foto "${file.name}" zu groß (>8 MB) — übersprungen.`);
      continue;
    }
    const dataUrl = await blobToDataURL(file);
    const pid = newId('p');
    state.photos.set(pid, { name: file.name, mime: file.type, dataUrl });
    modalCtx.draftPhotoIds.push(pid);
    modalCtx.addedPhotoIds.push(pid);
  }
  saveAll();   // persist the photos themselves so we don't lose them on refresh
  renderModalPhotos();
}

function commitDamageEditor() {
  if (!modalCtx) return;
  const data = {
    partId:   modalCtx.partId,
    point:    modalCtx.point,
    normal:   modalCtx.normal,
    type:     dom.modalType.value,
    severity: getSeverityUI(),
    text:     dom.modalText.value.trim(),
    photoIds: modalCtx.draftPhotoIds.slice(),
  };
  if (modalCtx.mode === 'new') {
    createDamage(data);
  } else {
    updateDamage(modalCtx.damageId, data);
  }
  closeDamageEditor(true);
}

// ---------------------------------------------------------------
// 11. Sidebar / panel rendering
// ---------------------------------------------------------------

function renderPartList() {
  if (!state.partsList.length) {
    dom.partList.innerHTML = '<div style="padding:10px;color:var(--ink-mute)">— keine Parts —</div>';
    return;
  }
  const counts = new Map();
  for (const d of state.damages) counts.set(d.partId, (counts.get(d.partId) || 0) + 1);

  const q = state.partQuery.toLowerCase();
  const rows = state.partsList
    .filter(({ id }) => !q || id.toLowerCase().includes(q))
    .map(({ id }) => {
      const c = counts.get(id) || 0;
      const active = state.filterPartId === id ? 'active' : '';
      return `<div class="part-row ${active}" data-part-id="${escapeHtml(id)}">
        <span>${escapeHtml(id)}</span>
        <span class="part-count ${c === 0 ? 'zero' : ''}">${c}</span>
      </div>`;
    });
  dom.partList.innerHTML = rows.join('') ||
    '<div style="padding:10px;color:var(--ink-mute)">Keine Treffer.</div>';

  for (const row of dom.partList.querySelectorAll('.part-row')) {
    row.addEventListener('click', () => {
      const id = row.dataset.partId;
      // toggle filter
      state.filterPartId = (state.filterPartId === id) ? '' : id;
      // also focus camera on the part
      const partObj = state.partsById.get(id);
      if (partObj) focusOnObject(partObj);
      renderPartList();
      renderDamageList();
      // reflect in damage filter dropdown
      dom.damageFilter.value = state.filterPartId;
    });
  }
}

function focusOnObject(obj) {
  const bbox = new THREE.Box3().setFromObject(obj);
  if (bbox.isEmpty()) return;
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 0.5;
  const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI / 180) / 2)) * 2.0;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const newPos = center.clone().add(dir.multiplyScalar(dist));
  // animate via two lerp targets, simple
  const start = camera.position.clone();
  const startT = controls.target.clone();
  const t0 = performance.now();
  const dur = 350;
  function step() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(start, newPos, e);
    controls.target.lerpVectors(startT, center, e);
    if (t < 1) requestAnimationFrame(step);
  }
  step();
}

function populatePartFilter() {
  const previous = dom.damageFilter.value;
  dom.damageFilter.innerHTML = `<option value="">Alle Parts</option>` +
    state.partsList.map(({ id }) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`
    ).join('');
  dom.damageFilter.value = previous;
}

function renderDamageList() {
  dom.damageCount.textContent = state.damages.length;

  // also update mobile FAB badge
  const badge = document.getElementById('fabBadge');
  if (badge) {
    if (state.damages.length > 0) {
      badge.textContent = state.damages.length > 99 ? '99+' : state.damages.length;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  const q = state.damageQuery.toLowerCase();
  const filterPart = state.filterPartId || dom.damageFilter.value || '';

  const filtered = state.damages
    .filter((d) => !filterPart || d.partId === filterPart)
    .filter((d) => {
      if (!q) return true;
      return (
        d.partId.toLowerCase().includes(q) ||
        (d.text || '').toLowerCase().includes(q) ||
        (DAMAGE_TYPES[d.type] || '').toLowerCase().includes(q)
      );
    })
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  if (!filtered.length) {
    dom.damageList.innerHTML = `<div class="empty-list">Keine Schäden${filterPart || q ? ' (mit aktuellen Filtern)' : ''}.</div>`;
    return;
  }

  dom.damageList.innerHTML = filtered.map((d) => {
    const sev = Array.from({ length: 5 }, (_, i) =>
      `<i class="${i < d.severity ? 'on' : ''}"></i>`
    ).join('');
    const photos = (d.photoIds || []).slice(0, 3).map((pid) => {
      const p = state.photos.get(pid);
      return p ? `<img src="${p.dataUrl}" alt="" />` : '';
    }).join('');
    const more = (d.photoIds?.length || 0) > 3
      ? `<div class="more">+${d.photoIds.length - 3}</div>`
      : '';
    const typeLabel = DAMAGE_TYPES[d.type] || d.type;
    return `
      <div class="damage-card ${state.selectedDamageId === d.id ? 'selected' : ''}" data-id="${d.id}">
        <div class="dc-head">
          <span class="dc-type">${escapeHtml(typeLabel)}</span>
          <span class="dc-sev">${sev}</span>
        </div>
        <div class="dc-part">${escapeHtml(d.partId)}</div>
        <div class="dc-text ${!d.text ? 'empty' : ''}">${
          d.text ? escapeHtml(d.text) : 'keine Beschreibung'
        }</div>
        ${photos || more
          ? `<div class="dc-photos">${photos}${more}</div>`
          : ''}
        <div class="dc-meta">
          <span>${formatRelTime(d.updatedAt)}</span>
          <span>${d.id.slice(0, 12)}</span>
        </div>
      </div>
    `;
  }).join('');

  for (const card of dom.damageList.querySelectorAll('.damage-card')) {
    const id = card.dataset.id;
    card.addEventListener('click', (e) => {
      // single click: select + focus
      setSelectedDamage(id);
      const dmg = state.damages.find((d) => d.id === id);
      if (dmg) {
        const partObj = state.partsById.get(dmg.partId);
        if (partObj) {
          // focus on marker world position
          const marker = state.markerMeshes.get(id);
          if (marker) {
            const target = new THREE.Vector3();
            marker.getWorldPosition(target);
            focusOnPoint(target);
          }
        }
      }
    });
    card.addEventListener('dblclick', () => {
      openDamageEditor({ damageId: id });
    });
  }
}

function focusOnPoint(point) {
  const start = controls.target.clone();
  const t0 = performance.now();
  const dur = 300;
  function step() {
    const t = Math.min(1, (performance.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    controls.target.lerpVectors(start, point, e);
    if (t < 1) requestAnimationFrame(step);
  }
  step();
}

// ---------------------------------------------------------------
// 12. Misc helpers
// ---------------------------------------------------------------

function setStatus(msg) { dom.status.textContent = msg; }

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatRelTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const dt = (Date.now() - t) / 1000;
  if (dt < 60) return 'gerade eben';
  if (dt < 3600) return `vor ${Math.floor(dt / 60)} min`;
  if (dt < 86400) return `vor ${Math.floor(dt / 3600)} h`;
  if (dt < 604800) return `vor ${Math.floor(dt / 86400)} d`;
  return new Date(iso).toLocaleDateString('de-DE');
}

// ---------------------------------------------------------------
// 13. Wire up DOM events
// ---------------------------------------------------------------

function wireToolbar() {
  $('loadGltfBtn').addEventListener('click', () => $('gltfInput').click());
  $('loadGltfBtn2').addEventListener('click', () => $('gltfInput').click());
  $('gltfInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadGltfFromFile(file);
    e.target.value = '';
  });

  $('importBtn').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importFile(file);
    e.target.value = '';
  });

  $('exportJsonBtn').addEventListener('click', exportJson);
  $('exportZipBtn').addEventListener('click', exportZip);

  $('clearAllBtn').addEventListener('click', () => {
    if (!state.damages.length) return;
    if (!confirm(`${state.damages.length} Schäden wirklich löschen? Bilder werden ebenfalls entfernt.`)) return;
    state.damages = [];
    state.photos.clear();
    state.selectedDamageId = null;
    saveAll();
    rebuildAllMarkers();
    renderDamageList();
    renderPartList();
    setStatus('Alle Schäden gelöscht.');
  });

  $('resetViewBtn').addEventListener('click', () => {
    if (!state.modelRoot) return;
    const bbox = new THREE.Box3().setFromObject(state.modelRoot);
    frameBox(bbox);
  });

  dom.markersToggle.addEventListener('change', () => setMarkersVisible(dom.markersToggle.checked));
  dom.xrayToggle.addEventListener('change', () => setXRay(dom.xrayToggle.checked));

  dom.partSearch.addEventListener('input', () => {
    state.partQuery = dom.partSearch.value;
    renderPartList();
  });

  dom.damageSearch.addEventListener('input', () => {
    state.damageQuery = dom.damageSearch.value;
    renderDamageList();
  });

  dom.damageFilter.addEventListener('change', () => {
    state.filterPartId = dom.damageFilter.value;
    renderDamageList();
    renderPartList();
  });
}

function wireModal() {
  dom.modalCancel.addEventListener('click', () => closeDamageEditor(false));
  dom.modalClose.addEventListener('click', () => closeDamageEditor(false));
  dom.modalSave.addEventListener('click', commitDamageEditor);
  dom.modalDelete.addEventListener('click', () => {
    if (!modalCtx?.damageId) return;
    if (!confirm('Diesen Schaden wirklich löschen?')) return;
    deleteDamage(modalCtx.damageId);
    closeDamageEditor(true);
  });

  // severity buttons
  for (const btn of dom.modalSeverity.querySelectorAll('button')) {
    btn.addEventListener('click', () => setSeverityUI(Number(btn.dataset.v)));
  }

  // photos
  dom.addPhotoBtn.addEventListener('click', () => dom.photoInput.click());
  dom.photoInput.addEventListener('change', async (e) => {
    if (!modalCtx) return;
    await onPhotoFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });

  // close modal on Escape, save on Cmd/Ctrl-Enter
  document.addEventListener('keydown', (e) => {
    if (dom.modal.hidden) return;
    if (e.key === 'Escape') closeDamageEditor(false);
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitDamageEditor();
  });
}

// drag-drop a glTF/GLB anywhere
// Mobile drawer triggers — toolbar (left) and sidebar (right) become
// slide-in panels under 900px. The backdrop closes whichever is open.
function wireDrawers() {
  const fabTools = document.getElementById('fabTools');
  const fabList  = document.getElementById('fabList');
  const backdrop = document.getElementById('drawerBackdrop');
  const closeButtons = document.querySelectorAll('.drawer-close');

  function open(which) {
    document.body.classList.remove('drawer-toolbar-open', 'drawer-sidebar-open');
    document.body.classList.add(`drawer-${which}-open`);
  }
  function closeAll() {
    document.body.classList.remove('drawer-toolbar-open', 'drawer-sidebar-open');
  }

  fabTools?.addEventListener('click', () => open('toolbar'));
  fabList?.addEventListener('click', () => open('sidebar'));
  backdrop?.addEventListener('click', closeAll);
  for (const btn of closeButtons) {
    btn.addEventListener('click', closeAll);
  }

  // close drawer with Escape (when no modal is open)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.modal.hidden) closeAll();
  });

  // when the user picks something action-y in the toolbar/sidebar that
  // navigates to the viewer, auto-close the drawer for a smoother flow
  function autoCloseOnInteraction(rootSelector) {
    const root = document.querySelector(rootSelector);
    if (!root) return;
    root.addEventListener('click', (e) => {
      if (window.innerWidth > 900) return;
      // close on actual control interactions, not on every text-input click
      const t = e.target;
      if (t.matches('button, .part-row, .damage-card')) closeAll();
    });
  }
  autoCloseOnInteraction('.toolbar');
  autoCloseOnInteraction('.sidebar');
}

function wireDragDrop() {
  const target = document.body;
  ['dragenter','dragover'].forEach(t =>
    target.addEventListener(t, (e) => { e.preventDefault(); }));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
      loadGltfFromFile(file);
    } else if (lower.endsWith('.json') || lower.endsWith('.zip')) {
      importFile(file);
    }
  });
}

// ---------------------------------------------------------------
// 14. Init
// ---------------------------------------------------------------

const DEFAULT_MODEL_URL = './model.glb';

loadAll();
wireToolbar();
wireModal();
wireDragDrop();
wireDrawers();
renderPartList();
renderDamageList();

setStatus(state.damages.length
  ? `${state.damages.length} Schäden aus localStorage geladen.`
  : 'Bereit. Suche Standardmodell …');

// Try to auto-load a default model from the same directory.
// If it doesn't exist (404), the empty-state stays visible and
// the user can load via button / drag-drop. We log clearly to
// the console so debugging works.
loadGltfFromUrl(DEFAULT_MODEL_URL).then((loaded) => {
  if (loaded || state.modelRoot) return;
  console.info(
    `[damage-inspector] No '${DEFAULT_MODEL_URL}' found alongside index.html — ` +
    `place a glTF/GLB there to enable auto-load, or use the "glTF/GLB laden" button.`
  );
  setStatus(`Kein '${DEFAULT_MODEL_URL.replace('./','')}' gefunden — Modell manuell laden.`);
});

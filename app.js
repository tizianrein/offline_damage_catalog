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
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';
import { Storage } from './storage.js';
import { compressImage, formatBytes } from './image-compress.js';

// ---------------------------------------------------------------
// 0. Constants & state
// ---------------------------------------------------------------

const DAMAGE_TYPES = {
  crack:              'Riss',
  deformation:        'Verformung',
  dent:               'Delle',
  scratch:            'Kratzer',
  abrasion:           'Abrieb',
  wear:               'Verschleiß',
  missing:            'Fehlend',
  fracture:           'Bruch',
  loose:              'Gelockert',
  detachment:         'Ablösung',
  spalling:           'Abplatzung',
  decay:              'Zersetzung',
  rot:                'Fäulnis',
  corrosion:          'Korrosion',
  moisture:           'Feuchtigkeit',
  efflorescence:      'Ausblühung',
  stain:              'Fleck',
  contamination:      'Verschmutzung',
  biological_growth:  'Biologischer Bewuchs',
  insect_damage:      'Insektenschaden',
  fungal_attack:      'Pilzbefall',
  weathering:         'Verwitterung',
  erosion:            'Erosion',
  frost_damage:       'Frostschaden',
  discoloration:      'Verfärbung',
  other:              'Sonstiges',
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
  xray:             true,
  markersVisible:   true,
  targetCursor:     null,            // {partId, point, normal} or null

  // pointcloud
  pointcloud:       null,            // THREE.Points or null
  pointcloudVisible: true,
  pointcloudColorMode: 'rgb',        // 'rgb' | 'gray' | 'height'
  pointcloudSize:   1.0,             // multiplier on auto-computed size

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

  // pointcloud
  pointcloudControls: $('pointcloudControls'),
  pointcloudToggle:   $('pointcloudToggle'),
  pcColorMode:        $('pcColorMode'),
  pcSizeSlider:       $('pcSizeSlider'),

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
// Note: cursorMesh is declared up-front so the first animation frame
// after module load doesn't hit a TDZ ReferenceError before the
// cursor module further down has been parsed.
let cursorMesh = null;

function tick() {
  controls.update();

  // gentle pulse for the target cursor so it's easy to spot
  if (cursorMesh) {
    const t = (performance.now() - cursorMesh.userData.pulseStart) / 1000;
    const pulse = 1 + Math.sin(t * 4) * 0.08;
    const baseScale = computeMarkerRadius() * 2.2;
    cursorMesh.scale.setScalar(baseScale * pulse);
  }

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

  // We used to do a HEAD-probe here to check if the file exists before
  // calling gltfLoader.load — but that's a separate request which the
  // Service Worker may not have cached, so it would falsely 404 in
  // offline mode (especially on iOS Safari). Now we just try to load
  // directly and let the loader's onError tell us if the file is gone.
  return new Promise((resolve) => {
    gltfLoader.load(
      url,
      (gltf) => {
        installModel(gltf.scene, name);
        resolve(true);
      },
      undefined,
      (err) => {
        // Distinguish "file genuinely not there" (404) from "actually broken".
        // The Three.js loader doesn't expose status cleanly, so we just log
        // and treat any failure as a soft miss — the empty state stays up
        // and the user can load manually.
        console.warn(`[loadGltfFromUrl] ${url} failed:`, err?.message || err);
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
  // cursor visual was parented to the previous model and is gone now;
  // also drop the state and the local reference
  cursorMesh = null;
  state.targetCursor = null;

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

  setXRay(state.xray);

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
  updatePlaceUI();
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
// 3b. Pointcloud (.ply) — optional overlay layer
// ---------------------------------------------------------------

const plyLoader = new PLYLoader();

// Picks an automatic point size based on the model's bounding-box size.
// Without this, points are either invisible specks or chunky blobs
// depending on whether your scan is in meters, millimeters, or feet.
function autoPointSize() {
  if (state.modelRoot) {
    const bbox = new THREE.Box3().setFromObject(state.modelRoot);
    const size = bbox.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z) * 0.0015;
  }
  if (state.pointcloud) {
    const bbox = new THREE.Box3().setFromObject(state.pointcloud);
    const size = bbox.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z) * 0.0015;
  }
  return 0.005;
}

// Build a fresh PointsMaterial respecting the current colour mode and
// size multiplier. We rebuild rather than mutate so vertex-colors flips
// don't leave stale buffers on the GPU.
function makePointcloudMaterial(geometry) {
  const mode = state.pointcloudColorMode;
  const baseSize = autoPointSize() * state.pointcloudSize;

  if (mode === 'rgb' && geometry.hasAttribute('color')) {
    return new THREE.PointsMaterial({
      size: baseSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
    });
  }

  if (mode === 'height') {
    // Build a per-vertex colour ramp from low (deep blue) to high (warm yellow)
    // based on Y. Stored on the geometry; we set vertexColors:true to use it.
    applyHeightRampColors(geometry);
    return new THREE.PointsMaterial({
      size: baseSize,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
    });
  }

  // gray fallback (also used if scan has no colour)
  return new THREE.PointsMaterial({
    size: baseSize,
    sizeAttenuation: true,
    color: 0x888888,
    transparent: true,
    opacity: 0.55,
  });
}

// Replaces the geometry's `color` buffer with a height ramp. Original
// scan colours are kept in `color_orig` so we can restore them later.
function applyHeightRampColors(geometry) {
  const positions = geometry.getAttribute('position');
  if (!positions) return;

  // backup original RGB if present and not yet stashed
  if (geometry.hasAttribute('color') && !geometry.userData._origColors) {
    geometry.userData._origColors = geometry.getAttribute('color').clone();
  }

  const n = positions.count;
  const colors = new Float32Array(n * 3);

  // We want the colour ramp to follow *visual* height (world Y),
  // not the raw Y from the buffer — those don't match if the
  // pointcloud is rotated to fix up Z-up vs Y-up. So we transform
  // each point with the current world matrix before reading Y.
  const worldMatrix = state.pointcloud
    ? state.pointcloud.matrixWorld
    : new THREE.Matrix4();
  const v = new THREE.Vector3();

  // find Y range in world space
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(positions, i).applyMatrix4(worldMatrix);
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const range = Math.max(1e-6, maxY - minY);

  const c1 = new THREE.Color(0x223a6b); // deep blue
  const c2 = new THREE.Color(0xd9b15a); // warm yellow
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(positions, i).applyMatrix4(worldMatrix);
    const t = (v.y - minY) / range;
    tmp.copy(c1).lerp(c2, t);
    colors[i * 3]     = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Restore the original RGB colours that were stashed by the height ramp.
function restoreOriginalColors(geometry) {
  if (geometry.userData._origColors) {
    geometry.setAttribute('color', geometry.userData._origColors);
  }
}

async function loadPointcloudFromUrl(url) {
  setStatus(`Lade Punktwolke …`);
  return new Promise((resolve) => {
    plyLoader.load(
      url,
      (geometry) => {
        installPointcloud(geometry);
        resolve(true);
      },
      undefined,
      (err) => {
        console.warn(`[loadPointcloud] ${url} failed:`, err?.message || err);
        resolve(false);
      },
    );
  });
}

function installPointcloud(geometry) {
  // tear down old one if present
  if (state.pointcloud) {
    scene.remove(state.pointcloud);
    state.pointcloud.geometry.dispose();
    state.pointcloud.material.dispose();
    state.pointcloud = null;
  }

  geometry.computeBoundingBox();
  // Some PLY exports come with normals we don't need; keep memory tidy.
  if (geometry.hasAttribute('normal')) geometry.deleteAttribute('normal');

  const material = makePointcloudMaterial(geometry);
  const points = new THREE.Points(geometry, material);
  points.name = 'pointcloud';
  // Render points behind the model so X-Ray reveal still feels right
  points.renderOrder = -1;
  points.visible = state.pointcloudVisible;

  // Coordinate system fix: Rhino is Z-up, Three.js / glTF is Y-up.
  // Rotating -90° around X swaps them so a point that was "high" (z=high)
  // in Rhino lands at "high" (y=high) here. If your scan still looks wrong
  // after this, see PC_ROTATION_X below.
  points.rotation.x = PC_ROTATION_X;

  scene.add(points);
  state.pointcloud = points;

  // Reflect availability in the UI
  if (dom.pointcloudControls) dom.pointcloudControls.hidden = false;

  const count = geometry.getAttribute('position')?.count ?? 0;
  setStatus(`Punktwolke geladen (${count.toLocaleString('de-DE')} Punkte).`);

  // If no model is present yet, frame the camera on the cloud so the
  // user actually sees something.
  if (!state.modelRoot) frameOnPointcloud();
}

// If the cloud lands sideways or upside down relative to the model,
// change this. -π/2 handles standard Rhino-Z-up to Three-Y-up.
// Other useful values:  0  (no rotation),  Math.PI / 2  (other way),
// Math.PI  (flipped — model is upside down).
const PC_ROTATION_X = Math.PI / 2;

function frameOnPointcloud() {
  if (!state.pointcloud) return;
  const bbox = new THREE.Box3().setFromObject(state.pointcloud);
  if (bbox.isEmpty()) return;
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3()).length();
  const dir = new THREE.Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(size * 0.9));
  camera.near = Math.max(0.001, size * 0.001);
  camera.far  = size * 10;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function setPointcloudVisible(v) {
  state.pointcloudVisible = v;
  if (state.pointcloud) state.pointcloud.visible = v;
}

function setPointcloudColorMode(mode) {
  state.pointcloudColorMode = mode;
  if (!state.pointcloud) return;
  const geom = state.pointcloud.geometry;
  // If we're going back to RGB after a height ramp, restore colours
  if (mode === 'rgb') restoreOriginalColors(geom);
  // Make sure the world matrix reflects the current rotation before
  // we sample world-Y for the height ramp.
  state.pointcloud.updateMatrixWorld(true);
  state.pointcloud.material.dispose();
  state.pointcloud.material = makePointcloudMaterial(geom);
}

function setPointcloudSize(multiplier) {
  state.pointcloudSize = multiplier;
  if (!state.pointcloud) return;
  state.pointcloud.material.size = autoPointSize() * multiplier;
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

// Pointer interaction
// -------------------
// On any device, a single short tap on the model sets a TARGET CURSOR
// (a small marker the user can move around to preview where a damage
// would land). The actual damage is created via the place-button at
// the bottom-center of the viewer.
//
// A tap on an existing damage marker opens the editor for it directly.
//
// Multi-touch (pinch / two-finger pan) is detected via the count of
// active pointers and never produces a tap, so zooming on mobile no
// longer accidentally drops markers.

const activePointers = new Map();   // pointerId -> {x, y, startTime, moved}
const TAP_MOVE_THRESHOLD = 8;       // px — anything past this is a drag, not a tap
const TAP_TIME_THRESHOLD = 500;     // ms — slow press is also not a tap
let multiTouchActive = false;       // latched true while >1 pointers down

renderer.domElement.addEventListener('pointerdown', (e) => {
  activePointers.set(e.pointerId, {
    x: e.clientX, y: e.clientY,
    startX: e.clientX, startY: e.clientY,
    startTime: performance.now(),
    moved: false,
  });
  if (activePointers.size > 1) {
    multiTouchActive = true;
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  const p = activePointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX; p.y = e.clientY;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (Math.abs(dx) > TAP_MOVE_THRESHOLD || Math.abs(dy) > TAP_MOVE_THRESHOLD) {
      p.moved = true;
    }
  }
  // hover preview only when nothing is being dragged AND we are not on touch
  if (e.pointerType !== 'touch' && activePointers.size === 0) {
    handleHover(e);
  }
});

function pointerEnd(e) {
  const p = activePointers.get(e.pointerId);
  activePointers.delete(e.pointerId);

  // Only treat as a tap if:
  //   - there is no other pointer still down
  //   - this one didn't move past the threshold
  //   - it wasn't a long press
  //   - we never went into multi-touch during this gesture
  if (!p) return;
  const dt = performance.now() - p.startTime;
  const isTap = !p.moved && dt < TAP_TIME_THRESHOLD;

  // Reset multi-touch latch only when ALL pointers are released
  const wasMulti = multiTouchActive;
  if (activePointers.size === 0) multiTouchActive = false;

  if (!isTap) return;
  if (wasMulti) return;
  if (activePointers.size > 0) return;

  handleTap(e);
}
renderer.domElement.addEventListener('pointerup', pointerEnd);
renderer.domElement.addEventListener('pointercancel', pointerEnd);
renderer.domElement.addEventListener('pointerleave', (e) => {
  // hover only — don't fire taps from a leave
  if (e.pointerType !== 'touch') hideHoverInfo();
  activePointers.delete(e.pointerId);
  if (activePointers.size === 0) multiTouchActive = false;
});

function handleTap(e) {
  if (!state.modelRoot) return;
  const pick = pickFromEvent(e);
  if (!pick) {
    // tapping empty space clears the target cursor
    setTargetCursor(null);
    return;
  }
  if (pick.kind === 'marker') {
    const id = pick.hit.object.userData.damageId;
    setSelectedDamage(id);
    openDamageEditor({ damageId: id });
    return;
  }
  // tapped a mesh: position the target cursor here
  const partId = pick.hit.object.userData.ownerPartId;
  if (!partId) {
    setStatus('Kein benannter Part getroffen — Modell mit benannten Nodes verwenden.');
    return;
  }
  const partObj = state.partsById.get(partId);
  if (!partObj) return;

  partObj.updateWorldMatrix(true, false);
  const localPoint = partObj.worldToLocal(pick.hit.point.clone());

  let localNormal = new THREE.Vector3(0, 1, 0);
  if (pick.hit.face) {
    const meshObj = pick.hit.object;
    const worldNormal = pick.hit.face.normal.clone()
      .transformDirection(meshObj.matrixWorld);
    const inv = new THREE.Matrix4().copy(partObj.matrixWorld).invert();
    localNormal = worldNormal.transformDirection(inv).normalize();
  }

  setTargetCursor({
    partId,
    point:  { x: localPoint.x, y: localPoint.y, z: localPoint.z },
    normal: { x: localNormal.x, y: localNormal.y, z: localNormal.z },
  });
}

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

// ---------------------------------------------------------------
// 4b. Target cursor (preview crosshair before placing damage)
// ---------------------------------------------------------------

const cursorRingGeo = new THREE.RingGeometry(0.7, 1.0, 32);
const cursorDotGeo  = new THREE.SphereGeometry(0.25, 16, 12);

// (cursorMesh is declared further up, before the render loop, to
//  avoid a temporal-dead-zone ReferenceError on the first frame.)

/**
 * Sets or clears the target cursor. Pass null to clear.
 * `data` = { partId, point: {x,y,z}, normal: {x,y,z} } — all in part-local space.
 */
function setTargetCursor(data) {
  // remove old visual
  if (cursorMesh) {
    cursorMesh.removeFromParent();
    cursorMesh.traverse((o) => {
      if (o.material) o.material.dispose?.();
    });
    cursorMesh = null;
  }
  state.targetCursor = data;

  if (!data) {
    updatePlaceUI();
    return;
  }

  const partObj = state.partsById.get(data.partId);
  if (!partObj) return;

  // Build a small crosshair: a flat ring oriented along the surface normal,
  // plus a center dot. Both in part-local space.
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x1f4e79,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
    depthTest: false,           // draw on top so the user always sees it
  });
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0x1f4e79,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const ring = new THREE.Mesh(cursorRingGeo, ringMat);
  const dot  = new THREE.Mesh(cursorDotGeo,  dotMat);
  // render after everything else
  ring.renderOrder = 999;
  dot.renderOrder  = 999;

  const group = new THREE.Group();
  group.add(ring);
  group.add(dot);

  // scale to model size
  const r = computeMarkerRadius() * 2.2;
  group.scale.setScalar(r);

  // position at hit point, lifted slightly along normal so it doesn't z-fight
  const normal = new THREE.Vector3(data.normal.x, data.normal.y, data.normal.z).normalize();
  const offset = normal.clone().multiplyScalar(r * 0.05);
  group.position.set(
    data.point.x + offset.x,
    data.point.y + offset.y,
    data.point.z + offset.z,
  );

  // orient ring so its plane is perpendicular to the normal
  // The ring geometry lies in the XY-plane (normal +Z); rotate +Z to match `normal`
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    normal,
  );
  group.quaternion.copy(q);

  partObj.add(group);
  cursorMesh = group;

  // animate the ring with a gentle pulse
  group.userData.pulseStart = performance.now();

  updatePlaceUI();
}

function updatePlaceUI() {
  const tc = state.targetCursor;
  const placeBtn = document.getElementById('placeDamageBtn');
  const cancelBtn = document.getElementById('cancelTargetBtn');
  const readout = document.getElementById('cursorReadout');
  if (!placeBtn) return;

  if (tc) {
    placeBtn.disabled = false;
    placeBtn.title = 'Schaden hier setzen';
    cancelBtn.hidden = false;
    readout.hidden = false;
    document.getElementById('crPart').textContent = tc.partId;
    document.getElementById('crX').textContent = tc.point.x.toFixed(3);
    document.getElementById('crY').textContent = tc.point.y.toFixed(3);
    document.getElementById('crZ').textContent = tc.point.z.toFixed(3);
  } else {
    placeBtn.disabled = !state.modelRoot;
    placeBtn.title = state.modelRoot
      ? 'Erst Punkt am Modell antippen, dann hier bestätigen'
      : 'Modell laden';
    cancelBtn.hidden = true;
    readout.hidden = true;
  }
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
    type:     data.type     || 'other',
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
    if (!stillUsed) {
      const ph = state.photos.get(pid);
      if (ph?.objectUrl) URL.revokeObjectURL(ph.objectUrl);
      state.photos.delete(pid);
      Storage.deletePhoto(pid).catch((e) => console.warn('photo delete:', e));
    }
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
// 8. Storage (IndexedDB via storage.js)
// ---------------------------------------------------------------

// Saves only damages + modelMeta. Photos are persisted separately when
// they are added (savePhoto in onPhotoFiles) and removed when their
// last referencing damage is deleted.
async function saveState() {
  try {
    await Storage.saveState({
      damages: state.damages,
      modelMeta: state.modelMeta,
    });
  } catch (err) {
    console.warn('State write failed:', err);
    setStatus(`Speichern fehlgeschlagen: ${err.message}`);
  }
}

// Pull state + photos from IndexedDB. For each stored photo, create
// an Object URL so <img src> works without round-tripping the blob
// every render.
async function loadState() {
  try {
    const persisted = await Storage.loadState();
    if (persisted && Array.isArray(persisted.damages)) {
      state.damages = persisted.damages;
    }
    // populate photos map with object URLs for display
    const photos = await Storage.getAllPhotos();
    state.photos = new Map();
    for (const p of photos) {
      const url = URL.createObjectURL(p.blob);
      state.photos.set(p.id, {
        name: p.name,
        mime: p.mime,
        objectUrl: url,
      });
    }
  } catch (err) {
    console.warn('State read failed:', err);
  }
}

// Compatibility: older code paths called saveAll() — we keep the name
// as a sync-looking wrapper that fires-and-forgets. Errors are logged.
function saveAll() {
  saveState().catch((e) => console.warn('saveAll:', e));
}

// ---------------------------------------------------------------
// 9. Import / Export
// ---------------------------------------------------------------

function buildExportObject() {
  return {
    schemaVersion: 1,
    generator: 'Fritz-Pflaum-Hütte',
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
    // Pull the actual blob from IndexedDB rather than re-encoding from
    // the in-memory object URL (URLs are browser-internal and can't be
    // turned back into bytes synchronously).
    const stored = await Storage.getPhoto(pid);
    if (!stored?.blob) continue;
    const fileName = photoFileName(pid, photo).replace(/^photos\//, '');
    photosFolder.file(fileName, stored.blob);
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
  await applyImported(parsed, null);
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

  // load photos folder. We persist each blob into IndexedDB and keep a
  // Map of {pid -> {name, mime, objectUrl}} for in-memory display.
  const photoMap = new Map();
  const photoFiles = zip.folder('photos');
  if (photoFiles) {
    const entries = [];
    photoFiles.forEach((relPath, entry) => { if (!entry.dir) entries.push(entry); });
    for (const entry of entries) {
      // we encoded id before "__" in filename
      const idMatch = entry.name.match(/photos\/([^_]+(?:_[^_]+)*?)__/);
      const pid = idMatch ? idMatch[1] : newId('p');
      const blob = await entry.async('blob');
      const justName = entry.name.replace(/^photos\//, '');
      const ext = justName.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png'
                 : ext === 'gif' ? 'image/gif'
                 : ext === 'webp' ? 'image/webp'
                 : 'image/jpeg';
      // ensure blob has a sensible mime
      const blobTyped = blob.type ? blob : new Blob([blob], { type: mime });
      try {
        await Storage.savePhoto(pid, blobTyped, justName);
      } catch (err) {
        console.warn('Could not store imported photo:', err);
        continue;
      }
      const objectUrl = URL.createObjectURL(blobTyped);
      photoMap.set(pid, { name: justName, mime, objectUrl });
    }
  }

  await applyImported(parsed, photoMap);
  setStatus(`ZIP importiert (${parsed.damages?.length ?? 0} Schäden, ${photoMap.size} Fotos).`);
}

async function applyImported(parsed, photoMap) {
  if (!parsed || !Array.isArray(parsed.damages)) {
    setStatus('Datei enthält keine "damages" Liste.');
    return;
  }
  // before replacing, revoke old object URLs to free memory
  for (const ph of state.photos.values()) {
    if (ph?.objectUrl) URL.revokeObjectURL(ph.objectUrl);
  }
  // merge strategy: replace
  state.damages = parsed.damages.map((d) => ({
    ...d,
    photoIds: d.photoIds || (d.photos || []).map((p) => p.id).filter(Boolean),
  }));
  if (photoMap) {
    state.photos = photoMap;
  }
  await saveState();
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
    dom.modalType.value = 'other';
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
    for (const pid of modalCtx.addedPhotoIds) {
      const ph = state.photos.get(pid);
      if (ph?.objectUrl) URL.revokeObjectURL(ph.objectUrl);
      state.photos.delete(pid);
      Storage.deletePhoto(pid).catch((e) => console.warn('rollback photo delete:', e));
    }
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
      <img src="${photo.objectUrl}" alt="${escapeHtml(photo.name || '')}" />
      <button class="photo-rm" title="Entfernen">✕</button>
    `;
    tile.querySelector('.photo-rm').addEventListener('click', async () => {
      modalCtx.draftPhotoIds = modalCtx.draftPhotoIds.filter((p) => p !== pid);
      // if it was just added in this session, also drop it from store + IDB
      if (modalCtx.addedPhotoIds.includes(pid)) {
        const ph = state.photos.get(pid);
        if (ph?.objectUrl) URL.revokeObjectURL(ph.objectUrl);
        state.photos.delete(pid);
        await Storage.deletePhoto(pid);
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

    // Hard upper bound: nobody should be uploading a 50 MB raw — but
    // we compress aggressively below, so the practical bound is much
    // looser than the old 8 MB cap.
    if (file.size > 30 * 1024 * 1024) {
      setStatus(`Foto "${file.name}" zu groß (>30 MB) — übersprungen.`);
      continue;
    }

    setStatus(`Komprimiere "${file.name}" …`);
    let blob;
    try {
      blob = await compressImage(file, { maxDim: 1600, quality: 0.82 });
    } catch (err) {
      console.warn('compressImage failed, using original:', err);
      blob = file;
    }

    const pid = newId('p');
    try {
      await Storage.savePhoto(pid, blob, file.name);
    } catch (err) {
      console.warn('Storage.savePhoto failed:', err);
      setStatus(`Foto "${file.name}" konnte nicht gespeichert werden: ${err.message}`);
      continue;
    }

    const objectUrl = URL.createObjectURL(blob);
    state.photos.set(pid, {
      name: file.name,
      mime: blob.type || 'image/jpeg',
      objectUrl,
    });
    modalCtx.draftPhotoIds.push(pid);
    modalCtx.addedPhotoIds.push(pid);
    setStatus(`Foto hinzugefügt (${formatBytes(blob.size)}).`);
  }
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
    // a real marker now lives where the cursor was — drop the cursor
    setTargetCursor(null);
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
      return p ? `<img src="${p.objectUrl}" alt="" />` : '';
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

  $('clearAllBtn').addEventListener('click', async () => {
    if (!state.damages.length) return;
    if (!confirm(`${state.damages.length} Schäden wirklich löschen? Bilder werden ebenfalls entfernt.`)) return;
    state.damages = [];
    // revoke all object URLs to free memory, then clear the map
    for (const ph of state.photos.values()) {
      if (ph?.objectUrl) URL.revokeObjectURL(ph.objectUrl);
    }
    state.photos.clear();
    state.selectedDamageId = null;
    try {
      await Storage.clearAll();
    } catch (e) {
      console.warn('clearAll:', e);
    }
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

  // Pointcloud controls
  if (dom.pointcloudToggle) {
    dom.pointcloudToggle.addEventListener('change', () => {
      setPointcloudVisible(dom.pointcloudToggle.checked);
    });
  }
  if (dom.pcColorMode) {
    dom.pcColorMode.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      // toggle active class
      dom.pcColorMode.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      setPointcloudColorMode(btn.dataset.mode);
    });
  }
  if (dom.pcSizeSlider) {
    dom.pcSizeSlider.addEventListener('input', () => {
      setPointcloudSize(parseFloat(dom.pcSizeSlider.value));
    });
  }

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

  // Bottom-center place button: open editor with cursor data
  $('placeDamageBtn').addEventListener('click', () => {
    const tc = state.targetCursor;
    if (!tc) {
      setStatus('Erst auf das Modell tippen, um den Punkt zu setzen.');
      return;
    }
    openDamageEditor({
      partId: tc.partId,
      point:  tc.point,
      normal: tc.normal,
    });
  });
  $('cancelTargetBtn').addEventListener('click', () => {
    setTargetCursor(null);
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
// Updates the small status banner in the toolbar to tell the user
// whether the app is fully cached and ready for offline use.
async function updateOfflineStatus() {
  const el = document.getElementById('offlineStatus');
  if (!el) return;
  const text = el.querySelector('.os-text');
  const detail = el.querySelector('.os-detail');

  if (!('serviceWorker' in navigator)) {
    el.dataset.state = 'error';
    text.textContent = 'Offline nicht unterstützt';
    detail.textContent = '';
    return;
  }

  // is a service worker active and controlling this page?
  const reg = await navigator.serviceWorker.getRegistration();
  const controllable = !!navigator.serviceWorker.controller;

  if (!reg || !controllable) {
    el.dataset.state = 'checking';
    text.textContent = 'Wird vorbereitet…';
    detail.textContent = navigator.onLine ? 'online' : 'offline';
    return;
  }

  // estimate storage usage
  let sizeNote = '';
  try {
    const est = await Storage.estimate();
    if (est.usage) sizeNote = `${formatBytes(est.usage)} lokal`;
  } catch {}

  el.dataset.state = 'ready';
  text.textContent = navigator.onLine ? 'Offline-bereit' : 'Offline-Modus';
  detail.textContent = sizeNote;
}

function wireOfflineStatus() {
  window.addEventListener('online',  updateOfflineStatus);
  window.addEventListener('offline', updateOfflineStatus);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', updateOfflineStatus);
  }
  // Also re-check periodically — e.g. after a photo is added storage usage changes
  setInterval(updateOfflineStatus, 30 * 1000);
}

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

// We probe these in order. First hit wins. .glb is preferred
// because it's self-contained; .gltf may need accompanying .bin
// or texture files next to it.
const DEFAULT_MODEL_CANDIDATES = ['./model.glb', './model.gltf'];

// One async IIFE so we can await Storage.init() before anything else.
(async () => {
  // Storage init handles: opening IndexedDB, migrating from old
  // localStorage if present, requesting persistent storage permission.
  try {
    await Storage.init();
  } catch (err) {
    console.warn('[init] Storage.init failed:', err);
    setStatus('Lokaler Speicher nicht verfügbar — Daten gehen beim Schließen verloren.');
  }

  // Pull saved damages + photo handles into memory
  await loadState();

  wireToolbar();
  wireModal();
  wireDragDrop();
  wireDrawers();
  wireOfflineStatus();
  renderPartList();
  renderDamageList();
  updatePlaceUI();
  updateOfflineStatus();

  setStatus(state.damages.length
    ? `${state.damages.length} Schäden geladen.`
    : 'Bereit. Suche Standardmodell …');

  // Service worker registration — this is what makes the app work
  // offline. If we're served via file:// or it's not supported,
  // it just no-ops.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.info('[sw] registered:', reg.scope);
      // Once ready, refresh the status banner
      navigator.serviceWorker.ready.then(updateOfflineStatus);
    } catch (err) {
      console.warn('[sw] register failed:', err);
    }
  }

  // Auto-load default model + pointcloud in parallel.
  // Pointcloud is independent — if there's no model, the cloud still
  // loads; if there's no cloud, the model still loads.
  const modelLoad = (async () => {
    for (const url of DEFAULT_MODEL_CANDIDATES) {
      const ok = await loadGltfFromUrl(url);
      if (ok) return true;
    }
    return false;
  })();

  const pointcloudLoad = loadPointcloudFromUrl('./pointcloud.ply');

  const [modelOk, pointcloudOk] = await Promise.all([modelLoad, pointcloudLoad]);

  if (!modelOk && !state.modelRoot) {
    console.info(
      `[damage-inspector] No default model found. Tried: ${DEFAULT_MODEL_CANDIDATES.join(', ')}. ` +
      `Place a glTF/GLB there to enable auto-load, or use the "glTF/GLB laden" button.`
    );
    if (!pointcloudOk) {
      setStatus(`Kein Standardmodell (${DEFAULT_MODEL_CANDIDATES.map(s=>s.replace('./','')).join(' / ')}) gefunden — bitte manuell laden.`);
    }
  }
  if (!pointcloudOk) {
    console.info('[damage-inspector] No pointcloud.ply found — pointcloud overlay disabled.');
  }
})();

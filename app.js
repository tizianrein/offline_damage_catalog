import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'https://cdn.jsdelivr.net/npm/three@0.183.0/examples/jsm/webxr/VRButton.js';

const STORAGE_KEY = 'three-cube-comments-v1';

const canvasWrap = document.getElementById('canvasWrap');
const entriesEl = document.getElementById('entries');
const statusEl = document.getElementById('status');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const resetViewBtn = document.getElementById('resetViewBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9eef5);

const camera = new THREE.PerspectiveCamera(
  50,
  canvasWrap.clientWidth / canvasWrap.clientHeight,
  0.1,
  100
);
camera.position.set(2.4, 1.8, 2.8);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
canvasWrap.appendChild(renderer.domElement);

document.body.appendChild(VRButton.createButton(renderer));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

const ambient = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
dirLight.position.set(3, 4, 5);
scene.add(dirLight);

const grid = new THREE.GridHelper(8, 16, 0x9ca3af, 0xd1d5db);
grid.position.y = -0.501;
scene.add(grid);

const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
const cubeMaterial = [
  new THREE.MeshStandardMaterial({ color: 0xfca5a5 }),
  new THREE.MeshStandardMaterial({ color: 0xfdba74 }),
  new THREE.MeshStandardMaterial({ color: 0xfde68a }),
  new THREE.MeshStandardMaterial({ color: 0x86efac }),
  new THREE.MeshStandardMaterial({ color: 0x93c5fd }),
  new THREE.MeshStandardMaterial({ color: 0xc4b5fd })
];

const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
scene.add(cube);

const edgeLines = new THREE.LineSegments(
  new THREE.EdgesGeometry(cubeGeometry),
  new THREE.LineBasicMaterial({ color: 0x111827 })
);
cube.add(edgeLines);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const markersGroup = new THREE.Group();
scene.add(markersGroup);

const faceNames = ['right', 'left', 'top', 'bottom', 'front', 'back'];

function setStatus(message) {
  statusEl.textContent = message;
}

function getEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(error);
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('de-DE');
}

function fmt(value) {
  return Number(value).toFixed(3);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function inferFaceName(faceIndex) {
  if (faceIndex == null) return 'unknown';
  const materialIndex = Math.floor(faceIndex / 2);
  return faceNames[materialIndex] || 'unknown';
}

function uvToSafeObject(intersection) {
  return {
    u: intersection.uv ? intersection.uv.x : null,
    v: intersection.uv ? 1 - intersection.uv.y : null
  };
}

function pointToObject(point) {
  return {
    x: Number(point.x.toFixed(4)),
    y: Number(point.y.toFixed(4)),
    z: Number(point.z.toFixed(4))
  };
}

function clearMarkers() {
  while (markersGroup.children.length > 0) {
    const child = markersGroup.children[0];
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
    markersGroup.remove(child);
  }
}

function createMarker(entry) {
  const geometry = new THREE.SphereGeometry(0.035, 16, 16);
  const material = new THREE.MeshStandardMaterial({
    color: 0xbe123c,
    emissive: 0x3f0012
  });
  const marker = new THREE.Mesh(geometry, material);

  const direction = new THREE.Vector3(entry.point.x, entry.point.y, entry.point.z)
    .normalize()
    .multiplyScalar(0.54);

  marker.position.copy(direction);
  marker.userData.entryId = entry.id;
  markersGroup.add(marker);
}

function renderMarkers() {
  clearMarkers();
  const entries = getEntries();
  entries.forEach(createMarker);
}

function renderEntries() {
  const entries = getEntries().slice().reverse();

  if (entries.length === 0) {
    entriesEl.innerHTML = `<div class="empty">Noch keine Kommentare vorhanden.</div>`;
    return;
  }

  entriesEl.innerHTML = entries.map((entry) => `
    <div class="entry" id="entry-${entry.id}">
      <strong>${escapeHtml(entry.face)}</strong>
      <div class="small">
        u = ${fmt(entry.uv.u)}<br>
        v = ${fmt(entry.uv.v)}<br>
        x = ${fmt(entry.point.x)}, y = ${fmt(entry.point.y)}, z = ${fmt(entry.point.z)}<br>
        ${formatDate(entry.createdAt)}
      </div>
      <div>${escapeHtml(entry.text).replace(/\n/g, '<br>')}</div>
      <div class="actions">
        <button type="button" class="locate-btn" data-id="${entry.id}">Im Viewer finden</button>
        <button type="button" class="danger delete-btn" data-id="${entry.id}">Löschen</button>
      </div>
    </div>
  `).join('');

  document.querySelectorAll('.locate-btn').forEach((btn) => {
    btn.addEventListener('click', () => focusEntry(btn.dataset.id));
  });

  document.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteEntry(btn.dataset.id));
  });
}

function focusEntry(id) {
  document.querySelectorAll('.entry').forEach((el) => {
    el.style.outline = 'none';
    el.style.background = '#fafafa';
  });

  const target = document.getElementById(`entry-${id}`);
  if (target) {
    target.style.outline = '2px solid #111827';
    target.style.background = '#f3f4f6';
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const entry = getEntries().find((item) => item.id === id);
  if (!entry) return;

  controls.target.set(0, 0, 0);
  camera.position.set(
    entry.point.x * 3.2,
    entry.point.y * 3.2 + 0.4,
    entry.point.z * 3.2
  );
  setStatus(`Kommentar auf ${entry.face} fokussiert.`);
}

function addEntryFromIntersection(intersection) {
  const face = inferFaceName(intersection.faceIndex);
  const uv = uvToSafeObject(intersection);
  const point = pointToObject(intersection.point);

  const text = window.prompt(
    `Kommentar für Fläche "${face}" eingeben:\n\nu=${fmt(uv.u)}, v=${fmt(uv.v)}`
  );

  if (!text || !text.trim()) {
    setStatus('Kein Kommentar gespeichert.');
    return;
  }

  const entries = getEntries();
  entries.push({
    id: createId(),
    face,
    uv,
    point,
    text: text.trim(),
    createdAt: new Date().toISOString()
  });

  saveEntries(entries);
  renderMarkers();
  renderEntries();
  setStatus(`Kommentar auf ${face} gespeichert.`);
}

function deleteEntry(id) {
  const entries = getEntries().filter((entry) => entry.id !== id);
  saveEntries(entries);
  renderMarkers();
  renderEntries();
  setStatus('Kommentar gelöscht.');
}

function exportEntries() {
  const entries = getEntries();

  if (entries.length === 0) {
    setStatus('Keine Daten zum Exportieren vorhanden.');
    return;
  }

  const payload = {
    model: {
      type: 'unit-cube',
      size: [1, 1, 1]
    },
    comments: entries
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json'
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'three-cube-comments.json';
  a.click();
  URL.revokeObjectURL(url);

  setStatus('JSON exportiert.');
}

function clearAll() {
  const confirmed = window.confirm('Wirklich alle Kommentare löschen?');
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEY);
  renderMarkers();
  renderEntries();
  setStatus('Alle Kommentare gelöscht.');
}

function onPointerClick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(cube, false);

  if (hits.length > 0) {
    addEntryFromIntersection(hits[0]);
  }
}

function resetView() {
  camera.position.set(2.4, 1.8, 2.8);
  controls.target.set(0, 0, 0);
  controls.update();
  setStatus('Ansicht zurückgesetzt.');
}

renderer.domElement.addEventListener('click', onPointerClick);
exportBtn.addEventListener('click', exportEntries);
clearBtn.addEventListener('click', clearAll);
resetViewBtn.addEventListener('click', resetView);

window.addEventListener('resize', () => {
  camera.aspect = canvasWrap.clientWidth / canvasWrap.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker registriert');
    } catch (error) {
      console.error('SW Registrierung fehlgeschlagen:', error);
    }
  });
}

renderMarkers();
renderEntries();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
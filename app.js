// Importiere Three.js als Modul ganz oben
import * as THREE from 'three';

const STORAGE_KEY = "cube-comments-v3";

const canvasWrap = document.getElementById("canvasWrap");
const entriesEl = document.getElementById("entries");
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const resetViewBtn = document.getElementById("resetViewBtn");

function setStatus(message) {
  statusEl.textContent = message;
}

function getEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function fmt(value) {
  return Number(value).toFixed(3);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString("de-DE");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe5e7eb);

const camera = new THREE.PerspectiveCamera(
  50,
  canvasWrap.clientWidth / canvasWrap.clientHeight,
  0.1,
  100
);
camera.position.set(0, 0.8, 3.4);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
canvasWrap.appendChild(renderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 1.0));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(3, 4, 5);
scene.add(dirLight);

const grid = new THREE.GridHelper(8, 16, 0x9ca3af, 0xcbd5e1);
grid.position.y = -0.501;
scene.add(grid);

const cubeGroup = new THREE.Group();
scene.add(cubeGroup);

const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
const materials = [
  new THREE.MeshStandardMaterial({ color: 0xfca5a5 }), // right
  new THREE.MeshStandardMaterial({ color: 0xfdba74 }), // left
  new THREE.MeshStandardMaterial({ color: 0xfde68a }), // top
  new THREE.MeshStandardMaterial({ color: 0x86efac }), // bottom
  new THREE.MeshStandardMaterial({ color: 0x93c5fd }), // front
  new THREE.MeshStandardMaterial({ color: 0xc4b5fd })  // back
];

const cube = new THREE.Mesh(cubeGeometry, materials);
cubeGroup.add(cube);

const edges = new THREE.LineSegments(
  new THREE.EdgesGeometry(cubeGeometry),
  new THREE.LineBasicMaterial({ color: 0x111827 })
);
cube.add(edges);

cubeGroup.rotation.x = -0.45;
cubeGroup.rotation.y = 0.65;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const markersGroup = new THREE.Group();
cubeGroup.add(markersGroup);

const faceNames = ["right", "left", "top", "bottom", "front", "back"];

function inferFaceName(faceIndex) {
  const materialIndex = Math.floor(faceIndex / 2);
  return faceNames[materialIndex] || "unknown";
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

function renderMarkers() {
  clearMarkers();
  const entries = getEntries();

  for (const entry of entries) {
    const geometry = new THREE.SphereGeometry(0.035, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: 0xbe123c,
      emissive: 0x3f0012
    });

    const marker = new THREE.Mesh(geometry, material);
    marker.position.set(entry.point.x, entry.point.y, entry.point.z);

    const outward = new THREE.Vector3(entry.point.x, entry.point.y, entry.point.z)
      .normalize()
      .multiplyScalar(0.04);

    marker.position.add(outward);
    marker.userData.entryId = entry.id;
    markersGroup.add(marker);
  }
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
      <div>${escapeHtml(entry.text).replace(/\n/g, "<br>")}</div>
      <div class="actions">
        <button type="button" class="locate-btn" data-id="${entry.id}">Im Viewer finden</button>
        <button type="button" class="danger delete-btn" data-id="${entry.id}">Löschen</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".locate-btn").forEach((btn) => {
    btn.addEventListener("click", () => focusEntry(btn.dataset.id));
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteEntry(btn.dataset.id));
  });
}

function focusEntry(id) {
  const entry = getEntries().find((item) => item.id === id);
  if (!entry) return;

  setStatus(`Kommentar auf ${entry.face} markiert.`);
}

function addEntryFromIntersection(intersection) {
  const face = inferFaceName(intersection.faceIndex);
  const uv = {
    u: intersection.uv ? intersection.uv.x : 0,
    v: intersection.uv ? 1 - intersection.uv.y : 0
  };
  
  // WICHTIG: Den Punkt vom Welt- in den lokalen Raum des Würfels umwandeln!
  // Wir klonen den Punkt zuerst, da worldToLocal das Originalobjekt verändert.
  const localPoint = intersection.point.clone();
  cube.worldToLocal(localPoint);
  
  const point = pointToObject(localPoint);

  const text = window.prompt(
    `Kommentar für Fläche "${face}" eingeben:\n\nu=${fmt(uv.u)}, v=${fmt(uv.v)}`
  );

  if (!text || !text.trim()) {
    setStatus("Kein Kommentar gespeichert.");
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
  setStatus("Kommentar gelöscht.");
}

function exportEntries() {
  const entries = getEntries();

  if (entries.length === 0) {
    setStatus("Keine Daten zum Exportieren vorhanden.");
    return;
  }

  const payload = {
    model: {
      type: "unit-cube",
      size: [1, 1, 1]
    },
    comments: entries
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "cube-comments.json";
  a.click();
  URL.revokeObjectURL(url);

  setStatus("JSON exportiert.");
}

function clearAll() {
  const confirmed = window.confirm("Wirklich alle Kommentare löschen?");
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEY);
  renderMarkers();
  renderEntries();
  setStatus("Alle Kommentare gelöscht.");
}

let isDragging = false;
let dragMoved = false;
let startX = 0;
let startY = 0;
let startRotX = cubeGroup.rotation.x;
let startRotY = cubeGroup.rotation.y;

renderer.domElement.addEventListener("pointerdown", (event) => {
  isDragging = true;
  dragMoved = false;
  startX = event.clientX;
  startY = event.clientY;
  startRotX = cubeGroup.rotation.x;
  startRotY = cubeGroup.rotation.y;
});

renderer.domElement.addEventListener("pointermove", (event) => {
  if (!isDragging) return;

  const dx = event.clientX - startX;
  const dy = event.clientY - startY;

  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
    dragMoved = true;
  }

  cubeGroup.rotation.y = startRotY + dx * 0.01;
  cubeGroup.rotation.x = startRotX + dy * 0.01;
  cubeGroup.rotation.x = Math.max(-1.4, Math.min(1.4, cubeGroup.rotation.x));
});

function endDrag() {
  isDragging = false;
}

renderer.domElement.addEventListener("pointerup", endDrag);
renderer.domElement.addEventListener("pointerleave", endDrag);
renderer.domElement.addEventListener("pointercancel", endDrag);

renderer.domElement.addEventListener("click", (event) => {
  if (dragMoved) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(cube, false);

  if (hits.length > 0) {
    addEntryFromIntersection(hits[0]);
  }
});

resetViewBtn.addEventListener("click", () => {
  cubeGroup.rotation.x = -0.45;
  cubeGroup.rotation.y = 0.65;
  setStatus("Ansicht zurückgesetzt.");
});

exportBtn.addEventListener("click", exportEntries);
clearBtn.addEventListener("click", clearAll);

window.addEventListener("resize", () => {
  const width = canvasWrap.clientWidth;
  const height = canvasWrap.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
      console.log("Service Worker registriert");
    } catch (error) {
      console.error("SW Registrierung fehlgeschlagen:", error);
    }
  });
}

renderMarkers();
renderEntries();

function animate() {
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);
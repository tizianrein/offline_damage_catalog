const STORAGE_KEY = "offline-cube-comments-v1";

const cube = document.getElementById("cube");
const entriesEl = document.getElementById("entries");
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const resetViewBtn = document.getElementById("resetViewBtn");

let rotationX = -20;
let rotationY = 28;

let isDragging = false;
let dragMoved = false;
let startX = 0;
let startY = 0;
let startRotationX = rotationX;
let startRotationY = rotationY;

function setStatus(message) {
  statusEl.textContent = message;
}

function formatNumber(value) {
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

function getEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Fehler beim Lesen der Einträge:", error);
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function updateCubeTransform() {
  cube.style.transform = `rotateX(${rotationX}deg) rotateY(${rotationY}deg)`;
}

function createId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function renderPins() {
  document.querySelectorAll(".pin").forEach((pin) => pin.remove());

  const entries = getEntries();

  entries.forEach((entry) => {
    const faceEl = document.querySelector(`.face.${entry.face}`);
    if (!faceEl) return;

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "pin";
    pin.style.left = `${entry.u * 100}%`;
    pin.style.top = `${entry.v * 100}%`;
    pin.title = entry.text;
    pin.dataset.id = entry.id;

    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      highlightEntry(entry.id);
      const deleteIt = window.confirm(
        `Kommentar:\n\n${entry.text}\n\nFläche: ${entry.face}\nu: ${formatNumber(entry.u)}\nv: ${formatNumber(entry.v)}\n\nDiesen Kommentar löschen?`
      );
      if (deleteIt) {
        deleteEntry(entry.id);
      }
    });

    faceEl.appendChild(pin);
  });
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
        u = ${formatNumber(entry.u)}<br>
        v = ${formatNumber(entry.v)}<br>
        ${formatDate(entry.createdAt)}
      </div>
      <div>${escapeHtml(entry.text).replace(/\n/g, "<br>")}</div>
      <div class="actions">
        <button type="button" class="secondary locate-btn" data-id="${entry.id}">Markierung finden</button>
        <button type="button" class="danger delete-btn" data-id="${entry.id}">Löschen</button>
      </div>
    </div>
  `).join("");

  document.querySelectorAll(".locate-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      highlightEntry(id);
    });
  });

  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      deleteEntry(id);
    });
  });
}

function highlightEntry(id) {
  document.querySelectorAll(".entry").forEach((el) => {
    el.style.outline = "none";
    el.style.background = "#fafafa";
  });

  const target = document.getElementById(`entry-${id}`);
  if (target) {
    target.style.outline = "2px solid #111827";
    target.style.background = "#f3f4f6";
    target.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function addCommentToFace(faceEl, clientX, clientY) {
  const rect = faceEl.getBoundingClientRect();
  let u = (clientX - rect.left) / rect.width;
  let v = (clientY - rect.top) / rect.height;

  u = Math.max(0, Math.min(1, u));
  v = Math.max(0, Math.min(1, v));

  const text = window.prompt(
    `Kommentar für Fläche "${faceEl.dataset.face}" eingeben:\n\nu=${formatNumber(u)}, v=${formatNumber(v)}`
  );

  if (!text || !text.trim()) {
    setStatus("Kein Kommentar gespeichert.");
    return;
  }

  const entries = getEntries();
  entries.push({
    id: createId(),
    face: faceEl.dataset.face,
    u,
    v,
    text: text.trim(),
    createdAt: new Date().toISOString()
  });

  saveEntries(entries);
  renderPins();
  renderEntries();
  setStatus(`Kommentar auf ${faceEl.dataset.face} gespeichert.`);
}

function deleteEntry(id) {
  const entries = getEntries().filter((entry) => entry.id !== id);
  saveEntries(entries);
  renderPins();
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
    coordinateSystem: {
      perFace: true,
      u: "0..1 left-to-right",
      v: "0..1 top-to-bottom"
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

function clearAllEntries() {
  const confirmed = window.confirm("Wirklich alle Kommentare löschen?");
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEY);
  renderPins();
  renderEntries();
  setStatus("Alle Kommentare gelöscht.");
}

function onPointerDown(event) {
  isDragging = true;
  dragMoved = false;
  cube.classList.add("dragging");

  startX = event.clientX;
  startY = event.clientY;
  startRotationX = rotationX;
  startRotationY = rotationY;

  cube.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!isDragging) return;

  const dx = event.clientX - startX;
  const dy = event.clientY - startY;

  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    dragMoved = true;
  }

  rotationY = startRotationY + dx * 0.45;
  rotationX = startRotationX - dy * 0.45;

  rotationX = Math.max(-89, Math.min(89, rotationX));

  updateCubeTransform();
}

function onPointerUp(event) {
  if (!isDragging) return;
  isDragging = false;
  cube.classList.remove("dragging");

  try {
    cube.releasePointerCapture(event.pointerId);
  } catch (error) {
    // ignore
  }
}

cube.addEventListener("pointerdown", onPointerDown);
cube.addEventListener("pointermove", onPointerMove);
cube.addEventListener("pointerup", onPointerUp);
cube.addEventListener("pointercancel", onPointerUp);
cube.addEventListener("pointerleave", onPointerUp);

document.querySelectorAll(".face").forEach((faceEl) => {
  faceEl.addEventListener("click", (event) => {
    if (dragMoved) return;
    addCommentToFace(faceEl, event.clientX, event.clientY);
  });
});

resetViewBtn.addEventListener("click", () => {
  rotationX = -20;
  rotationY = 28;
  updateCubeTransform();
  setStatus("Ansicht zurückgesetzt.");
});

exportBtn.addEventListener("click", exportEntries);
clearBtn.addEventListener("click", clearAllEntries);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
      console.log("Service Worker registriert");
    } catch (error) {
      console.error("Service Worker Registrierung fehlgeschlagen:", error);
    }
  });
}

updateCubeTransform();
renderPins();
renderEntries();
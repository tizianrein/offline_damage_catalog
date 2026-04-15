const STORAGE_KEY = "exkursion-kommentare-v1";

const form = document.getElementById("commentForm");
const entriesContainer = document.getElementById("entries");
const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");

function getEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Fehler beim Lesen der Daten:", error);
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function setStatus(message) {
  statusEl.textContent = message;
}

function formatDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString("de-DE");
}

function renderEntries() {
  const entries = getEntries();

  if (entries.length === 0) {
    entriesContainer.innerHTML = `<p class="empty">Noch keine Kommentare gespeichert.</p>`;
    return;
  }

  entriesContainer.innerHTML = "";

  entries
    .slice()
    .reverse()
    .forEach((entry, reversedIndex) => {
      const originalIndex = entries.length - 1 - reversedIndex;

      const el = document.createElement("div");
      el.className = "entry";
      el.innerHTML = `
        <h3>${escapeHtml(entry.objectId)}</h3>
        <div class="meta">
          <strong>Name:</strong> ${escapeHtml(entry.studentName)}<br>
          <strong>Zeit:</strong> ${formatDate(entry.createdAt)}
        </div>
        <div>${escapeHtml(entry.commentText).replace(/\n/g, "<br>")}</div>
        <div class="actions" style="margin-top:12px;">
          <button type="button" data-index="${originalIndex}" class="danger delete-single">Eintrag löschen</button>
        </div>
      `;
      entriesContainer.appendChild(el);
    });

  document.querySelectorAll(".delete-single").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      deleteEntry(index);
    });
  });
}

function deleteEntry(index) {
  const entries = getEntries();
  entries.splice(index, 1);
  saveEntries(entries);
  renderEntries();
  setStatus("Eintrag gelöscht.");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const studentName = document.getElementById("studentName").value.trim();
  const objectId = document.getElementById("objectId").value.trim();
  const commentText = document.getElementById("commentText").value.trim();

  if (!studentName || !objectId || !commentText) {
    setStatus("Bitte alle Felder ausfüllen.");
    return;
  }

  const entries = getEntries();
  entries.push({
    studentName,
    objectId,
    commentText,
    createdAt: new Date().toISOString()
  });

  saveEntries(entries);
  form.reset();
  renderEntries();
  setStatus("Kommentar lokal gespeichert.");
});

exportBtn.addEventListener("click", () => {
  const entries = getEntries();

  if (entries.length === 0) {
    setStatus("Keine Daten zum Export vorhanden.");
    return;
  }

  const blob = new Blob([JSON.stringify(entries, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "exkursion-kommentare.json";
  a.click();
  URL.revokeObjectURL(url);

  setStatus("JSON Export heruntergeladen.");
});

clearBtn.addEventListener("click", () => {
  const confirmed = window.confirm("Wirklich alle gespeicherten Kommentare löschen?");
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEY);
  renderEntries();
  setStatus("Alle lokalen Kommentare wurden gelöscht.");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("./sw.js");
      console.log("Service Worker registriert");
    } catch (error) {
      console.error("Service Worker konnte nicht registriert werden:", error);
    }
  });
}

renderEntries();
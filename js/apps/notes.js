// Notes — synced sticky notes, draggable across a canvas.
import { subscribeNotes, upsertNote, deleteNote } from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

const COLORS = ["#ffe066", "#ffafcc", "#a0c4ff", "#bdb2ff", "#caffbf", "#fdffb6"];

export async function mountNotes(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <button class="primary" data-act="new">＋ New note</button>
        <span class="muted grow"></span>
        <span class="muted" style="font-size:11px">Notes sync across devices</span>
      </div>
      <div class="notes">
        <div class="notes-canvas" data-bind="canvas"></div>
      </div>
    </div>
  `;

  const canvas = root.querySelector('[data-bind="canvas"]');
  let notes = [];
  const saveTimers = new Map();

  const unsub = subscribeNotes(ctx.user.uid, (list) => {
    notes = list;
    render();
  });

  function render() {
    canvas.innerHTML = "";
    if (notes.length === 0) {
      canvas.innerHTML = `<div class="muted" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">Click "New note" to add one.</div>`;
      return;
    }
    notes.forEach((n) => canvas.appendChild(renderNote(n)));
  }

  function renderNote(n) {
    const el = document.createElement("div");
    el.className = "note";
    el.style.left = (n.x ?? 30) + "px";
    el.style.top = (n.y ?? 30) + "px";
    el.style.background = n.color || COLORS[0];
    el.innerHTML = `
      <div class="note-head">
        <span>${new Date(n.updated || 0).toLocaleString()}</span>
        <div>
          <button class="note-close" data-act="color" title="Color">●</button>
          <button class="note-close" data-act="delete" title="Delete">×</button>
        </div>
      </div>
      <textarea spellcheck="false"></textarea>
    `;
    const textarea = el.querySelector("textarea");
    textarea.value = n.text || "";

    textarea.addEventListener("input", () => {
      // Debounced save
      clearTimeout(saveTimers.get(n.id));
      const t = setTimeout(() => {
        upsertNote(ctx.user.uid, { ...n, text: textarea.value });
      }, 400);
      saveTimers.set(n.id, t);
    });

    el.querySelector('[data-act="delete"]').addEventListener("click", () => {
      if (confirm("Delete this note?")) deleteNote(ctx.user.uid, n.id);
    });
    el.querySelector('[data-act="color"]').addEventListener("click", () => {
      const next = COLORS[(COLORS.indexOf(n.color) + 1) % COLORS.length] || COLORS[0];
      upsertNote(ctx.user.uid, { ...n, color: next, text: textarea.value });
    });

    // Drag by head
    const head = el.querySelector(".note-head");
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      el.classList.add("dragging");
      const startX = e.clientX, startY = e.clientY;
      const startL = parseInt(el.style.left, 10);
      const startT = parseInt(el.style.top, 10);
      function move(ev) {
        el.style.left = Math.max(0, startL + ev.clientX - startX) + "px";
        el.style.top = Math.max(0, startT + ev.clientY - startY) + "px";
      }
      function up() {
        el.classList.remove("dragging");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        upsertNote(ctx.user.uid, {
          ...n,
          x: parseInt(el.style.left, 10),
          y: parseInt(el.style.top, 10),
          text: textarea.value
        });
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    return el;
  }

  root.querySelector('[data-act="new"]').addEventListener("click", () => {
    upsertNote(ctx.user.uid, {
      text: "",
      x: 30 + Math.floor(Math.random() * 200),
      y: 30 + Math.floor(Math.random() * 100),
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    });
  });

  return () => unsub();
}

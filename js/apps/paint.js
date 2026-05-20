// Paint — minimal canvas drawing: pencil, brush, eraser, fill, rectangle, line.
// Saves to /Pictures as a .png-style data URL inside an HTML wrapper file.

import * as FS from "../fs.js";

const PRESET = ["#000000","#ffffff","#ff6b7a","#ffd66e","#5bd6a4","#5aa9ff","#bdb2ff","#ffafcc","#c8d4eb","#7c8ba8"];

export async function mountPaint(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <button data-act="clear">Clear</button>
        <button data-act="save">💾 Save to Pictures</button>
        <span class="grow"></span>
        <span class="muted" style="font-size:12px" data-bind="status"></span>
      </div>
      <div class="paint">
        <div class="paint-tools">
          <div class="paint-tool active" data-tool="pencil" title="Pencil">✏️</div>
          <div class="paint-tool" data-tool="brush" title="Brush">🖌</div>
          <div class="paint-tool" data-tool="eraser" title="Eraser">🩹</div>
          <div class="paint-tool" data-tool="fill" title="Fill">🪣</div>
          <div class="paint-tool" data-tool="line" title="Line">📏</div>
          <div class="paint-tool" data-tool="rect" title="Rectangle">▭</div>
        </div>
        <div class="paint-stage">
          <canvas class="paint-canvas" width="640" height="480"></canvas>
        </div>
        <div class="paint-side">
          <h4>Color</h4>
          <div class="paint-colors" data-bind="colors"></div>
          <input type="color" data-bind="custom" value="#000000" />
          <h4 style="margin-top:14px">Brush size</h4>
          <label><span data-bind="size-label">4 px</span>
            <input type="range" min="1" max="40" value="4" data-bind="size" />
          </label>
        </div>
      </div>
    </div>
  `;

  const canvas = root.querySelector(".paint-canvas");
  const cx = canvas.getContext("2d");
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, canvas.width, canvas.height);

  let tool = "pencil";
  let color = "#000000";
  let size = 4;
  let drawing = false;
  let last = null;
  let preview = null;

  const colorsEl = root.querySelector('[data-bind="colors"]');
  colorsEl.innerHTML = PRESET.map((c) =>
    `<div class="paint-color${c === color ? " active" : ""}" style="background:${c}" data-color="${c}"></div>`
  ).join("");
  colorsEl.querySelectorAll(".paint-color").forEach((el) =>
    el.addEventListener("click", () => {
      color = el.dataset.color;
      root.querySelector('[data-bind="custom"]').value = color;
      colorsEl.querySelectorAll(".paint-color").forEach((x) => x.classList.toggle("active", x === el));
    })
  );
  root.querySelector('[data-bind="custom"]').addEventListener("input", (e) => {
    color = e.target.value;
    colorsEl.querySelectorAll(".paint-color").forEach((x) => x.classList.remove("active"));
  });

  root.querySelectorAll(".paint-tool").forEach((el) =>
    el.addEventListener("click", () => {
      tool = el.dataset.tool;
      root.querySelectorAll(".paint-tool").forEach((x) => x.classList.toggle("active", x === el));
    })
  );

  const sizeIn = root.querySelector('[data-bind="size"]');
  const sizeLbl = root.querySelector('[data-bind="size-label"]');
  sizeIn.addEventListener("input", () => { size = parseInt(sizeIn.value, 10); sizeLbl.textContent = size + " px"; });

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.floor((e.clientX - r.left) * (canvas.width / r.width)),
      y: Math.floor((e.clientY - r.top) * (canvas.height / r.height))
    };
  }

  canvas.addEventListener("mousedown", (e) => {
    drawing = true;
    const p = pos(e);
    last = p;
    if (tool === "fill") { floodFill(cx, p.x, p.y, color); drawing = false; return; }
    if (tool === "line" || tool === "rect") {
      preview = cx.getImageData(0, 0, canvas.width, canvas.height);
      return;
    }
    drawAt(p);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    if (tool === "line") {
      cx.putImageData(preview, 0, 0);
      cx.strokeStyle = color;
      cx.lineWidth = size;
      cx.lineCap = "round";
      cx.beginPath(); cx.moveTo(last.x, last.y); cx.lineTo(p.x, p.y); cx.stroke();
    } else if (tool === "rect") {
      cx.putImageData(preview, 0, 0);
      cx.strokeStyle = color;
      cx.lineWidth = size;
      cx.strokeRect(last.x, last.y, p.x - last.x, p.y - last.y);
    } else {
      drawSegment(last, p);
      last = p;
    }
  });

  function up() { drawing = false; last = null; preview = null; }
  canvas.addEventListener("mouseup", up);
  canvas.addEventListener("mouseleave", up);

  function drawAt(p) {
    cx.fillStyle = tool === "eraser" ? "#ffffff" : color;
    cx.beginPath();
    cx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    cx.fill();
  }
  function drawSegment(a, b) {
    cx.strokeStyle = tool === "eraser" ? "#ffffff" : color;
    cx.lineWidth = tool === "brush" ? size * 1.5 : size;
    cx.lineCap = "round";
    cx.beginPath(); cx.moveTo(a.x, a.y); cx.lineTo(b.x, b.y); cx.stroke();
  }

  function floodFill(ctx, x, y, hex) {
    const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const w = img.width, h = img.height;
    const data = img.data;
    const target = idxAt(data, x, y, w);
    const fill = hexToRgba(hex);
    if (sameColor(target, fill)) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx2, cy2] = stack.pop();
      if (cx2 < 0 || cy2 < 0 || cx2 >= w || cy2 >= h) continue;
      const c = idxAt(data, cx2, cy2, w);
      if (!sameColor(c, target)) continue;
      setPixel(data, cx2, cy2, w, fill);
      stack.push([cx2 + 1, cy2], [cx2 - 1, cy2], [cx2, cy2 + 1], [cx2, cy2 - 1]);
    }
    ctx.putImageData(img, 0, 0);
  }
  function idxAt(data, x, y, w) {
    const i = (y * w + x) * 4;
    return [data[i], data[i+1], data[i+2], data[i+3]];
  }
  function setPixel(data, x, y, w, rgba) {
    const i = (y * w + x) * 4;
    data[i] = rgba[0]; data[i+1] = rgba[1]; data[i+2] = rgba[2]; data[i+3] = rgba[3];
  }
  function sameColor(a, b) { return a[0]===b[0] && a[1]===b[1] && a[2]===b[2] && a[3]===b[3]; }
  function hexToRgba(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n>>16)&0xff, (n>>8)&0xff, n&0xff, 255];
  }

  root.querySelector('[data-act="clear"]').addEventListener("click", () => {
    if (!confirm("Clear the canvas?")) return;
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, canvas.width, canvas.height);
  });

  root.querySelector('[data-act="save"]').addEventListener("click", async () => {
    const dataUrl = canvas.toDataURL("image/png");
    const name = prompt("Save as (filename):", "drawing-" + Date.now());
    if (!name) return;
    // Store as an HTML wrapper so File Explorer / Studios can open it.
    const html = `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${dataUrl}" alt=""></body>`;
    await FS.write("/Pictures/" + name + ".html", html, { type: "image" });
    root.querySelector('[data-bind="status"]').textContent = "Saved to /Pictures/" + name + ".html";
  });
}

// Calculator — basic four-function with chain operations.

export async function mountCalculator(root) {
  root.innerHTML = `
    <div class="app">
      <div class="calc">
        <div class="calc-display" data-bind="d">0</div>
        <div class="calc-keys">
          <button class="calc-key clear" data-key="C">C</button>
          <button class="calc-key" data-key="±">±</button>
          <button class="calc-key" data-key="%">%</button>
          <button class="calc-key op" data-key="÷">÷</button>

          <button class="calc-key" data-key="7">7</button>
          <button class="calc-key" data-key="8">8</button>
          <button class="calc-key" data-key="9">9</button>
          <button class="calc-key op" data-key="×">×</button>

          <button class="calc-key" data-key="4">4</button>
          <button class="calc-key" data-key="5">5</button>
          <button class="calc-key" data-key="6">6</button>
          <button class="calc-key op" data-key="−">−</button>

          <button class="calc-key" data-key="1">1</button>
          <button class="calc-key" data-key="2">2</button>
          <button class="calc-key" data-key="3">3</button>
          <button class="calc-key op" data-key="+">+</button>

          <button class="calc-key" data-key="0" style="grid-column: span 2;">0</button>
          <button class="calc-key" data-key=".">.</button>
          <button class="calc-key eq" data-key="=">=</button>
        </div>
      </div>
    </div>
  `;

  const display = root.querySelector('[data-bind="d"]');
  let cur = "0", prev = null, op = null, justEvaluated = false;

  function show() { display.textContent = cur; }

  function press(k) {
    if ("0123456789".includes(k)) {
      if (justEvaluated || cur === "0") { cur = k; justEvaluated = false; }
      else cur += k;
    } else if (k === ".") {
      if (justEvaluated) { cur = "0."; justEvaluated = false; }
      else if (!cur.includes(".")) cur += ".";
    } else if (k === "C") {
      cur = "0"; prev = null; op = null; justEvaluated = false;
    } else if (k === "±") {
      cur = String(-parseFloat(cur));
    } else if (k === "%") {
      cur = String(parseFloat(cur) / 100);
    } else if ("+−×÷".includes(k)) {
      if (op && prev !== null && !justEvaluated) {
        cur = String(apply(prev, cur, op));
      }
      prev = cur;
      op = k;
      justEvaluated = true;
    } else if (k === "=") {
      if (op && prev !== null) {
        cur = String(apply(prev, cur, op));
        op = null; prev = null;
        justEvaluated = true;
      }
    }
    show();
  }

  function apply(a, b, o) {
    const x = parseFloat(a), y = parseFloat(b);
    const r = o === "+" ? x + y : o === "−" ? x - y : o === "×" ? x * y : o === "÷" ? x / y : y;
    return Number.isFinite(r) ? Math.round(r * 1e12) / 1e12 : 0;
  }

  root.querySelectorAll(".calc-key").forEach((b) =>
    b.addEventListener("click", () => press(b.dataset.key))
  );

  // Keyboard support
  function onKey(e) {
    const k = e.key;
    if (k >= "0" && k <= "9") press(k);
    else if (k === ".") press(".");
    else if (k === "+" || k === "-" || k === "*" || k === "/") {
      press(k === "+" ? "+" : k === "-" ? "−" : k === "*" ? "×" : "÷");
    } else if (k === "Enter" || k === "=") press("=");
    else if (k === "Escape" || k === "c" || k === "C") press("C");
    else if (k === "%") press("%");
  }
  root.addEventListener("keydown", onKey);
  root.tabIndex = -1;
  root.focus();
}

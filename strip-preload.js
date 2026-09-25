// 标签条 preload: 增量渲染、切换、关闭、排序及固定宽度标签的溢出导航
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const add = document.getElementById("add");
  const tabsEl = document.getElementById("tabs");
  const bar = document.getElementById("bar");
  const left = document.getElementById("left");
  const right = document.getElementById("right");
  const all = document.getElementById("all");
  let dragId = null;
  let lastSig = "";
  let lastActiveId = null;

  add.addEventListener("click", () => ipcRenderer.send("app:new-tab"));
  left.addEventListener("click", () => tabsEl.scrollBy({ left: -354, behavior: "smooth" }));
  right.addEventListener("click", () => tabsEl.scrollBy({ left: 354, behavior: "smooth" }));
  all.addEventListener("click", () => {
    ipcRenderer.send("app:toggle-overflow", all.getBoundingClientRect().right);
  });

  function updateOverflow() {
    const overflow = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
    bar.classList.toggle("overflow", overflow);
    left.disabled = tabsEl.scrollLeft < 2;
    right.disabled = tabsEl.scrollLeft + tabsEl.clientWidth >= tabsEl.scrollWidth - 2;
  }
  tabsEl.addEventListener("scroll", updateOverflow);
  new ResizeObserver(updateOverflow).observe(tabsEl);

  // 标签多了滚轮横滑
  tabsEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY + e.deltaX;
    },
    { passive: false }
  );

  function wireTab(d, id) {
    d.addEventListener("click", () => ipcRenderer.send("app:switch-tab", id));
    d.addEventListener("keydown", (ev) => {
      if (ev.target !== d) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        ipcRenderer.send("app:switch-tab", id);
      }
    });
    d.querySelector(".x").addEventListener("click", (ev) => {
      ev.stopPropagation();
      ipcRenderer.send("app:close-tab", id);
    });
    d.addEventListener("dragstart", (ev) => {
      dragId = id;
      ev.dataTransfer.effectAllowed = "move";
    });
    d.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      d.classList.add("dragover");
    });
    d.addEventListener("dragleave", () => d.classList.remove("dragover"));
    d.addEventListener("drop", (ev) => {
      ev.preventDefault();
      d.classList.remove("dragover");
      if (dragId && dragId !== id) {
        ipcRenderer.send("app:reorder-tab", { dragId, targetId: id });
      }
    });
    d.addEventListener("dragend", () => { dragId = null; d.classList.remove("dragover"); });
  }

  ipcRenderer.on("app:tabs", (_e, state) => {
    const sig = JSON.stringify(state);
    if (sig === lastSig) return; // 无变化不重绘
    lastSig = sig;

    const seen = new Set();
    state.tabs.forEach((t, idx) => {
      seen.add(String(t.id));
      let d = tabsEl.querySelector(`[data-id="${t.id}"]`);
      if (!d) {
        d = document.createElement("div");
        d.dataset.id = String(t.id);
        d.draggable = true;
        d.tabIndex = 0;
        d.setAttribute("role", "tab");
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.className = "label";
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        x.setAttribute("aria-label", "关闭标签页");
        d.appendChild(dot);
        d.appendChild(label);
        d.appendChild(x);
        wireTab(d, t.id);
      }
      // 只更新变化的属性
      d.className = "tab" + (t.id === state.activeId ? " active" : "");
      d.setAttribute("aria-selected", t.id === state.activeId ? "true" : "false");
      d.querySelector(".dot").className =
        "dot" + (t.status === "running" ? " running" : t.status === "unread" ? " unread" : "");
      const labelEl = d.querySelector(".label");
      const text = t.title || "首页";
      if (labelEl.textContent !== text) labelEl.textContent = text;
      d.querySelector(".x").style.display = state.tabs.length > 1 ? "" : "none";
      // 位置对齐(拖拽排序/插入在当前之后)
      if (tabsEl.children[idx] !== d) tabsEl.insertBefore(d, tabsEl.children[idx] || null);
    });
    for (const child of [...tabsEl.children]) {
      if (!seen.has(child.dataset.id)) child.remove();
    }
    // 活动标签始终可见
    if (state.activeId !== lastActiveId) {
      const activeEl = tabsEl.querySelector(".tab.active");
      if (activeEl) activeEl.scrollIntoView({ inline: "nearest", block: "nearest" });
      lastActiveId = state.activeId;
    }
    updateOverflow();
  });

  ipcRenderer.on("app:bar-color", (_e, bg, fg) => {
    bar.style.background = bg;
    bar.style.color = fg;
    bar.classList.toggle("light", fg === "#1f2328");
  });
});

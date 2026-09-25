// 标签条 preload: 增量渲染(不整排重绘, 防闪跳)/切换/关闭/拖动排序/滚轮横滑 + 打开项目选择面板
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const add = document.getElementById("add");
  const tabsEl = document.getElementById("tabs");
  let dragId = null;
  let lastSig = "";

  add.addEventListener("click", () => ipcRenderer.send("app:toggle-chooser"));

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
        const dot = document.createElement("span");
        dot.className = "dot";
        const label = document.createElement("span");
        label.className = "label";
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        d.appendChild(dot);
        d.appendChild(label);
        d.appendChild(x);
        wireTab(d, t.id);
      }
      // 只更新变化的属性
      d.className = "tab" + (t.id === state.activeId ? " active" : "");
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
    const activeEl = tabsEl.querySelector(".tab.active");
    if (activeEl) activeEl.scrollIntoView({ inline: "nearest", block: "nearest" });
  });

  ipcRenderer.on("app:bar-color", (_e, bg, fg) => {
    document.getElementById("bar").style.background = bg;
    document.getElementById("bar").style.color = fg;
    document.getElementById("add").style.color = fg;
  });
});

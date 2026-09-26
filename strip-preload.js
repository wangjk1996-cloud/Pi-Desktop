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
    d.addEventListener("dblclick", (event) => {
      if (d.dataset.canRename !== "true" || event.target.closest(".x,.rename-input")) return;
      const label = d.querySelector(".label");
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = label.textContent;
      input.maxLength = 40;
      input.setAttribute("aria-label", "项目显示名称");
      d.insertBefore(input, d.querySelector(".x"));
      d.classList.add("renaming");
      input.focus();
      input.select();
      let finished = false;
      async function finish(save) {
        if (finished) return;
        finished = true;
        const next = input.value.trim();
        if (save && next !== label.textContent) {
          const result = await ipcRenderer.invoke("app:tab-rename-project", id, next);
          if (!result?.ok) {
            finished = false;
            input.classList.add("invalid");
            input.title = result?.message || "无法保存项目名称。";
            input.focus();
            return;
          }
        }
        input.remove();
        d.classList.remove("renaming");
      }
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          void finish(false);
        }
      });
      input.addEventListener("blur", () => { void finish(true); });
    });
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
        dot.setAttribute("aria-hidden", "true");
        dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        const label = document.createElement("span");
        label.className = "label";
        const x = document.createElement("button");
        x.className = "x";
        x.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5"/></svg>';
        x.setAttribute("aria-label", "关闭标签页");
        d.appendChild(dot);
        d.appendChild(label);
        d.appendChild(x);
        wireTab(d, t.id);
      }
      // 只更新变化的属性
      d.className = "tab" + (t.id === state.activeId ? " active" : "") + (d.querySelector(".rename-input") ? " renaming" : "");
      d.setAttribute("aria-selected", t.id === state.activeId ? "true" : "false");
      d.dataset.canRename = t.canRename ? "true" : "false";
      d.title = t.canRename ? "双击名称可重命名项目" : "";
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

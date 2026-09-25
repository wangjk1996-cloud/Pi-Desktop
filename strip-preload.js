// 标签条 preload: 标签渲染/切换/关闭/拖动排序 + 打开项目选择面板
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const add = document.getElementById("add");
  const tabsEl = document.getElementById("tabs");
  let dragId = null;

  add.addEventListener("click", () => ipcRenderer.send("app:toggle-chooser"));

  ipcRenderer.on("app:tabs", (_e, state) => {
    tabsEl.innerHTML = "";
    for (const t of state.tabs) {
      const d = document.createElement("div");
      d.className = "tab" + (t.id === state.activeId ? " active" : "");
      d.draggable = true;

      const dot = document.createElement("span");
      dot.className = "dot" + (t.status === "running" ? " running" : t.status === "unread" ? " unread" : "");
      d.appendChild(dot);

      const label = document.createElement("span");
      label.className = "label";
      label.textContent = t.title || "首页";
      d.appendChild(label);

      if (state.tabs.length > 1) {
        const x = document.createElement("button");
        x.className = "x";
        x.textContent = "×";
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          ipcRenderer.send("app:close-tab", t.id);
        });
        d.appendChild(x);
      }

      d.addEventListener("click", () => ipcRenderer.send("app:switch-tab", t.id));

      // 拖动排序
      d.addEventListener("dragstart", (ev) => {
        dragId = t.id;
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
        if (dragId && dragId !== t.id) {
          ipcRenderer.send("app:reorder-tab", { dragId, targetId: t.id });
        }
      });

      tabsEl.appendChild(d);
    }
  });

  ipcRenderer.on("app:bar-color", (_e, bg, fg) => {
    document.getElementById("bar").style.background = bg;
    document.getElementById("bar").style.color = fg;
    document.getElementById("add").style.color = fg;
  });
});

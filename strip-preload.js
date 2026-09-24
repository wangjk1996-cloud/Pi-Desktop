// 供顶部标签条使用的 preload: 渲染标签、转发点击事件
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const add = document.getElementById("add");
  const tabsEl = document.getElementById("tabs");

  add.addEventListener("click", () => ipcRenderer.send("app:new-tab"));

  ipcRenderer.on("app:tabs", (_e, state) => {
    add.disabled = !state.canNew;
    tabsEl.innerHTML = "";
    for (const t of state.tabs) {
      const d = document.createElement("div");
      d.className = "tab" + (t.id === state.activeId ? " active" : "");

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
      tabsEl.appendChild(d);
    }
  });

  ipcRenderer.on("app:bar-color", (_e, bg, fg) => {
    document.getElementById("bar").style.background = bg;
    document.getElementById("bar").style.color = fg;
    document.getElementById("add").style.color = fg;
  });
});

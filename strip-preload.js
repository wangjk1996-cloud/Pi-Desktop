// 供顶部标题条使用的 preload: 只暴露按钮事件与文案更新
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const add = document.getElementById("add");
  add.addEventListener("click", () => ipcRenderer.send("app:new-window"));
  ipcRenderer.on("app:title", (_e, t) => {
    document.getElementById("title").textContent = t;
  });
  ipcRenderer.on("app:can-new", (_e, ok) => {
    add.disabled = !ok;
  });
  ipcRenderer.on("app:bar-color", (_e, bg, fg) => {
    document.getElementById("bar").style.background = bg;
    document.getElementById("bar").style.color = fg;
    document.getElementById("add").style.color = fg;
  });
});

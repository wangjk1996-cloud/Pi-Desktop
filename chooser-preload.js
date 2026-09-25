// 项目选择面板 preload: 渲染项目列表, 转发选择事件
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("list");
  const newBtn = document.getElementById("new");

  newBtn.addEventListener("click", () => ipcRenderer.send("app:browse-project"));

  ipcRenderer.on("app:projects", (_e, projects) => {
    list.innerHTML = "";
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无项目";
      list.appendChild(empty);
      return;
    }
    for (const p of projects) {
      const row = document.createElement("div");
      row.className = "row";
      const main = document.createElement("div");
      main.className = "row-main";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.name;
      const cwd = document.createElement("div");
      cwd.className = "cwd";
      cwd.textContent = p.cwd;
      main.appendChild(name);
      main.appendChild(cwd);
      const count = document.createElement("div");
      count.className = "count";
      count.textContent = String(p.count);
      row.appendChild(main);
      row.appendChild(count);
      row.addEventListener("click", () => ipcRenderer.send("app:open-project", p.cwd));
      list.appendChild(row);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ipcRenderer.send("app:close-chooser");
  });
});

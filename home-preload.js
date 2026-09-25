const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  if (window.location.protocol !== "data:") return;
  const list = document.getElementById("projects");
  const browse = document.getElementById("browse");
  if (!list || !browse) return;

  const hour = new Date().getHours();
  document.getElementById("greeting").textContent = hour >= 5 && hour < 12
    ? "上午好，愿今天进展顺利"
    : hour >= 12 && hour < 18 ? "下午好，继续保持节奏"
    : hour >= 18 && hour < 23 ? "晚上好，辛苦了"
    : "夜深了，记得适时休息";

  browse.addEventListener("click", () => ipcRenderer.send("app:home-browse"));
  ipcRenderer.on("app:home-projects", (_e, projects) => {
    list.replaceChildren();
    document.getElementById("project-count").textContent = projects.length > 5
      ? `${projects.length} 个 · 滚动查看`
      : `${projects.length} 个`;
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "尚无最近项目。";
      list.appendChild(empty);
      return;
    }
    for (const project of projects) {
      const row = document.createElement("button");
      row.className = "project";
      const folder = document.createElement("span");
      folder.className = "folder";
      folder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
      const details = document.createElement("span");
      details.className = "details";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = project.name;
      const cwd = document.createElement("span");
      cwd.className = "cwd";
      cwd.textContent = project.cwd;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${project.count} 个会话`;
      details.append(name, cwd);
      row.append(folder, details, count);
      row.addEventListener("click", () => ipcRenderer.send("app:home-open-project", project.cwd));
      list.appendChild(row);
    }
  });
  ipcRenderer.send("app:home-ready");
});

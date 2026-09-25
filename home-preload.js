const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  if (window.location.protocol !== "data:") return;
  const list = document.getElementById("projects");
  const browse = document.getElementById("browse");
  if (!list || !browse) return;
  let draggedCwd = "";
  let ignoreClicksUntil = 0;

  function clearDropMarkers() {
    for (const row of list.querySelectorAll(".project")) {
      row.classList.remove("dragging", "drop-before", "drop-after");
    }
  }

  function beginRename(project, name) {
    const input = document.createElement("input");
    input.className = "name-editor";
    input.value = project.name;
    input.maxLength = 40;
    input.setAttribute("aria-label", "项目显示名称");
    name.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    async function finish(save) {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (save && next !== project.name) {
        const result = await ipcRenderer.invoke("app:home-rename-project", project.cwd, next);
        if (!result?.ok) {
          finished = false;
          input.classList.add("invalid");
          input.title = result?.message || "无法保存项目名称。";
          input.focus();
          return;
        }
        name.textContent = next;
      }
      input.replaceWith(name);
    }
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => { void finish(true); });
  }

  const greetings = [
    { until: 5, lines: ["夜深了，愿思路清晰，也别忘了休息", "深夜好，忙完这一段就安心休息吧", "夜色很静，愿手头的事顺利收尾"] },
    { until: 8, lines: ["早安，愿新的一天从容开始", "清晨好，愿今天有个轻松的开头", "清晨好，今天也许会有新灵感"] },
    { until: 11, lines: ["上午好，愿今天进展顺利", "早上好，带着好心情开始吧", "上午好，愿每一步都有清晰的方向"] },
    { until: 12, lines: ["快到午间了，记得稍作休息", "上午将尽，先给自己一点喘息时间", "临近中午，愿手头的事顺利收尾"] },
    { until: 14, lines: ["中午好，记得好好吃饭", "午安，愿忙碌暂时慢下来", "中午好，稍作休息再继续吧"] },
    { until: 17, lines: ["下午好，愿灵感如约而至", "午后好，给自己一杯茶的时间", "下午好，愿接下来的事顺利展开"] },
    { until: 19, lines: ["傍晚好，今天也辛苦了", "天色渐晚，愿忙碌慢慢收尾", "傍晚好，给今天一个从容的收尾"] },
    { until: 22, lines: ["晚上好，愿今晚过得轻松一些", "晚上好，愿思路顺畅，也留点时间给自己", "晚上好，今天辛苦了，愿你放松片刻"] },
    { until: 24, lines: ["夜深了，忙完记得早点休息", "晚些了，愿手头的事顺利收尾", "夜深了，愿今晚有个安稳的结束"] },
  ];
  function updateGreeting() {
    const now = new Date();
    const lines = greetings.find((band) => now.getHours() < band.until).lines;
    const text = lines[now.getDate() % lines.length];
    const greeting = document.getElementById("greeting");
    if (greeting.textContent !== text) greeting.textContent = text;
  }
  updateGreeting();
  setInterval(updateGreeting, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) updateGreeting();
  });

  browse.addEventListener("click", () => ipcRenderer.send("app:home-browse"));
  ipcRenderer.on("app:home-projects", (_e, projects) => {
    list.replaceChildren();
    document.getElementById("project-count").textContent = projects.length > 1
      ? `${projects.length} 个 · 拖动排序`
      : `${projects.length} 个`;
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "尚无最近项目。";
      list.appendChild(empty);
      return;
    }
    for (const project of projects) {
      const row = document.createElement("div");
      row.className = "project";
      row.draggable = true;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      const grip = document.createElement("span");
      grip.className = "grip";
      grip.title = "拖动调整顺序";
      grip.innerHTML = '<svg viewBox="0 0 16 20" aria-hidden="true"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="16" r="1.5"/><circle cx="11" cy="16" r="1.5"/></svg>';
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
      const rename = document.createElement("button");
      rename.className = "rename";
      rename.title = "重命名项目显示名称";
      rename.setAttribute("aria-label", `重命名 ${project.name}`);
      rename.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10.8-10.8a2 2 0 0 0-2.8-2.8L5.7 16.2 4 20Z"/><path d="m14.8 6.9 2.8 2.8"/></svg>';
      details.append(name, cwd);
      row.append(grip, folder, details, count, rename);
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        beginRename(project, name);
      });
      row.addEventListener("click", (event) => {
        if (Date.now() < ignoreClicksUntil || event.target.closest(".rename,.name-editor")) return;
        ipcRenderer.send("app:home-open-project", project.cwd);
      });
      row.addEventListener("keydown", (event) => {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          ipcRenderer.send("app:home-open-project", project.cwd);
        }
      });
      row.addEventListener("dragstart", (event) => {
        draggedCwd = project.cwd;
        ignoreClicksUntil = Date.now() + 500;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", project.cwd);
        row.classList.add("dragging");
      });
      row.addEventListener("dragover", (event) => {
        if (!draggedCwd || draggedCwd === project.cwd) return;
        event.preventDefault();
        clearDropMarkers();
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        row.classList.add(after ? "drop-after" : "drop-before");
      });
      row.addEventListener("drop", (event) => {
        if (!draggedCwd || draggedCwd === project.cwd) return;
        event.preventDefault();
        const source = draggedCwd;
        const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        draggedCwd = "";
        clearDropMarkers();
        void ipcRenderer.invoke("app:home-move-project", source, project.cwd, after);
      });
      row.addEventListener("dragend", () => {
        draggedCwd = "";
        clearDropMarkers();
      });
      list.appendChild(row);
    }
  });
  ipcRenderer.send("app:home-ready");
});

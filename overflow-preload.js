const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("list");
  let lastActiveId = null;
  ipcRenderer.on("app:overflow-tabs", (_e, state) => {
    document.getElementById("head").textContent = `全部标签页 · ${state.tabs.length}`;
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    state.tabs.forEach((tab, index) => {
      const row = document.createElement("button");
      row.className = "row" + (tab.id === state.activeId ? " active" : "");
      const number = document.createElement("span");
      number.className = "num";
      number.textContent = String(index + 1);
      const dot = document.createElement("span");
      dot.className = "dot" + (tab.status === "running" ? " running" : tab.status === "unread" ? " unread" : "");
      dot.setAttribute("aria-hidden", "true");
      dot.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = tab.title || "首页";
      const check = document.createElement("span");
      check.className = "check";
      check.textContent = tab.id === state.activeId ? "✓" : "";
      row.append(number, dot, label, check);
      row.addEventListener("click", () => ipcRenderer.send("app:overflow-switch", tab.id));
      list.appendChild(row);
    });
    list.scrollTop = scrollTop;
    if (state.activeId !== lastActiveId || state.revealActive) {
      list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    }
    lastActiveId = state.activeId;
    ipcRenderer.send("app:overflow-rendered");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ipcRenderer.send("app:overflow-close");
  });
});

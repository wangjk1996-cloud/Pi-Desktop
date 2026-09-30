const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-project-sync-"));
fs.mkdirSync(path.join(root, "build"));
for (const file of ["home-preload.js", "strip-preload.js", "overflow-preload.js"]) {
  fs.copyFileSync(path.join(repo, file), path.join(root, file));
}
fs.copyFileSync(path.join(repo, "build", "icon.ico"), path.join(root, "build", "icon.ico"));
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
  name: "pi-desktop-project-sync-test", version: "1.0.0", main: "main.js",
}));

async function setupTestServer() {
  const dirs = {
    a: path.join(__dirname, "alpha", "project"),
    b: path.join(__dirname, "beta", "project"),
    worktree: path.join(__dirname, "beta", "project", ".worktrees", "topic"),
  };
  for (const cwd of Object.values(dirs)) fs.mkdirSync(cwd, { recursive: true });
  getProjectPreferences().names[projectKey(dirs.b)] = "第二个项目";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/sessions") {
      res.end(JSON.stringify({
        sessions: [{ id: "first", cwd: dirs.a, modified: "2026-01-01T00:00:00Z" }],
        runningSessionIds: [],
      }));
    } else if (url.pathname === "/api/worktrees") {
      // Keep the response pending to verify synchronization does not wait for it.
      setTimeout(() => res.end("{}"), 2000);
    } else if (url.pathname.startsWith("/api/")) {
      res.end("{}");
    } else {
      const cwd = url.searchParams.get("cwd") || dirs.a;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end('<html><head><title>Pi Web</title></head><body><button id="cwd" title="' +
        cwd + '">' + cwd + '</button><script>window.requestsSettled=0;window.selectDirectory=' +
        function (next, projectRoot = next) {
          history.replaceState({}, "", "/");
          document.getElementById("cwd").title = projectRoot;
          document.title = next.split(/[\\/]/).pop() + " - Pi Web";
          void fetch("/api/worktrees?cwd=" + encodeURIComponent(next)).then(() => {
            window.requestsSettled += 1;
          });
        }.toString() + ";</script></body></html>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverPort = server.address().port;
  return { dirs, server };
}

async function runTests({ dirs, server }) {
  const assert = require("node:assert/strict");
  async function until(check, label) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out: " + label);
  }
  const a = tabs.get(activeTabId);
  await until(() => a.homeReady && stripReady, "initial home");
  openProjectInTab(a, dirs.a);
  await until(() => a.cwd === dirs.a && !a.pendingContent, "first project");
  newTab();
  const second = tabs.get(activeTabId);
  await until(() => second.homeReady, "second home");
  openProjectInTab(second, dirs.a);
  await until(() => second.cwd === dirs.a && !second.pendingContent, "second project");
  newTab();
  const home = tabs.get(activeTabId);
  await until(() => home.homeReady, "remaining home");
  switchTab(a.id);
  a.running = true;
  a.unread = true;
  await a.content.webContents.executeJavaScript(
    "window.selectDirectory(" + JSON.stringify(dirs.b) + ")"
  );
  await until(() => a.cwd === dirs.b, "directory switch without page reload");
  assert.equal(a.project, "第二个项目");
  assert.equal(a.running, false);
  assert.equal(a.unread, false);
  assert.equal(second.cwd, dirs.a);
  assert.equal(new URL(a.url).pathname, "/");
  assert.equal(new URL(a.url).search, "");
  assert.equal(mainWindow.getTitle(), "Pi Desktop - 第二个项目 | Powered by Pi");
  assert.equal(await a.content.webContents.executeJavaScript("window.requestsSettled"), 0);
  await until(() => home.content.webContents.executeJavaScript(
    "[...document.querySelectorAll('.project')].some(row => row.dataset.cwd === " +
    JSON.stringify(dirs.b) + ")"
  ), "new directory appears on an existing home");
  console.log("PASS: immediate full-path sync, status reset, home update, independent tabs");

  switchTab(home.id);
  await home.content.webContents.executeJavaScript(
    "(() => { const row = [...document.querySelectorAll('.project')].find(row => row.dataset.cwd === " +
    JSON.stringify(dirs.b) + "); row.querySelector('.rename').click(); " +
    "row.querySelector('.name-editor').value = '改名后的项目'; " +
    "row.querySelector('.decision.primary').click(); })()"
  );
  await until(() => a.project === "改名后的项目", "home rename updates switched project");
  assert.equal(second.project, "project");
  await a.content.webContents.executeJavaScript("document.title = 'Stale - Pi Web'");
  assert.equal(a.project, "改名后的项目");
  await until(() => stripView.webContents.executeJavaScript(
    "document.body.textContent.includes('改名后的项目')"
  ), "rendered tab title");
  console.log("PASS: homepage rename reaches the correct tab and survives page title changes");

  await a.content.webContents.executeJavaScript(
    "window.selectDirectory(" + JSON.stringify(dirs.worktree) + "," + JSON.stringify(dirs.b) + ")"
  );
  await until(() => a.cwd === dirs.worktree, "worktree under the same project root");
  assert.equal(a.project, "topic");
  assert.equal(mainWindow.getTitle(), "Pi Desktop - 首页 | Powered by Pi");
  await a.content.webContents.executeJavaScript(
    "fetch('/api/cwd/browse?path=' + encodeURIComponent(" + JSON.stringify(dirs.b) + "))"
  );
  assert.equal(a.cwd, dirs.worktree);
  await a.content.webContents.executeJavaScript(
    "window.selectDirectory(" + JSON.stringify(dirs.a) + ")"
  );
  await until(() => a.cwd === dirs.a, "switch back");
  assert.equal(a.project, "project");
  assert.equal(getProjectPreferences().names[projectKey(dirs.b)], "改名后的项目");
  console.log("PASS: background worktree sync, directory browsing does not select, switch back");
  server.close();
}

let source = fs.readFileSync(process.argv[2] || path.join(repo, "main.js"), "utf8").replace(/\r\n/g, "\n");
const migrationStart = source.indexOf("// 旧版数据目录迁移");
const migrationEnd = source.indexOf("const DEFAULT_PORT");
assert(migrationStart >= 0 && migrationEnd > migrationStart);
source = source.slice(0, migrationStart) +
  'app.setPath("userData", path.join(__dirname, "data"));\n' + source.slice(migrationEnd);
const startupStart = source.indexOf("    try {\n      // 1. 首次运行:");
const startupEnd = source.indexOf("    createMainWindow();", startupStart);
assert(startupStart >= 0 && startupEnd > startupStart);
source = source.slice(0, startupStart) +
  "    const testSetup = await (" + setupTestServer.toString() + ")();\n" +
  source.slice(startupEnd);
source = source.replace("    createTray();", "");
source = source.replace("    setupShellAutoUpdate();", "");
source = source.replace("    startWatchdog();", "");
source = source.replace("    setTimeout(() => backgroundGlobalToolsUpdate(), 8000);",
  "    (" + runTests.toString() + ")(testSetup).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });");
fs.writeFileSync(path.join(root, "main.js"), source);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(require("electron"), [root], {
  cwd: repo, env, stdio: "inherit", windowsHide: true, timeout: 60000,
});
if (result.error) console.error(result.error.message);
if (result.status === 0) {
  assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "pi-desktop-project-sync-")));
  fs.rmSync(root, { recursive: true, force: true });
} else {
  console.error("Test files retained: " + root);
}
process.exitCode = result.status ?? 1;

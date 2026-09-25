// Pi Desktop —— Electron 主进程
// 职责:
//   1. 内核: pi-web 私有副本, 首次运行自动下载; 每次退出应用时检查官方新版,
//      有新版则静默更新(此时服务已停, 无文件锁), 下次启动自动生效
//   2. 顺带更新: 本机全局 npm 里的 pi / pi-web(cmd 用的那两个)在启动后后台更新,
//      被占用更新失败就下次再试, 不影响应用本身
//   3. 服务: 用 Electron 内置 Node 运行时起 pi-web, 不依赖本机 Node.js
//   4. 桌面体验: 独立窗口 / 托盘驻留 / 单实例 / 外部链接走系统浏览器
//   5. 壳自更新: electron-updater 从 GitHub Releases 检查下载
"use strict";

const { app, BrowserWindow, WebContentsView, Tray, Menu, dialog, shell, ipcMain } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

// 旧版数据目录迁移: %APPDATA%\pi-web-app -> %APPDATA%\pi-desktop (一次性, 项目更名遗留)
try {
  const roaming = process.env.APPDATA;
  if (roaming) {
    const oldDir = path.join(roaming, "pi-web-app");
    const newDir = app.getPath("userData");
    if (fs.existsSync(oldDir) && oldDir !== newDir) {
      if (!fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
      } else {
        // Electron 可能已提前创建新目录: 逐项迁移关键数据(内核/运行时/日志)
        for (const item of ["kernel", "npm-runtime", "pi-desktop-server.log", "update.log", "update-state.json"]) {
          const from = path.join(oldDir, item);
          const to = path.join(newDir, item);
          try {
            if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
          } catch {
            /* 单项失败跳过 */
          }
        }
      }
    }
  }
} catch {
  /* 迁移失败则按全新安装处理, 内核会自动重新下载 */
}

const DEFAULT_PORT = 30141;
const APP_URL_HOST = "127.0.0.1";
const NPM_REGISTRY = "https://registry.npmmirror.com";
const PI_WEB_PKG = "@agegr/pi-web";
const PI_AGENT_PKG = "@earendil-works/pi-coding-agent";
const GLOBAL_TOOLS_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 全局工具更新检查最小间隔
const QUIT_UPDATE_TIMEOUT_MS = 3 * 60 * 1000; // 退出时内核更新最长耗时

// ---------------------------------------------------------------------------
// 路径与状态
// ---------------------------------------------------------------------------
function privatePrefix() {
  return path.join(app.getPath("userData"), "kernel");
}
function kernelBin() {
  return path.join(privatePrefix(), "node_modules", "@agegr", "pi-web", "bin", "pi-web.js");
}
function kernelPkgJson() {
  return path.join(privatePrefix(), "node_modules", "@agegr", "pi-web", "package.json");
}
function globalPrefix() {
  return path.join(process.env.APPDATA || "", "npm");
}
function globalHas(pkgName) {
  return fs.existsSync(path.join(globalPrefix(), "node_modules", ...pkgName.split("/")));
}
function npmRuntimeCli() {
  return path.join(app.getPath("userData"), "npm-runtime", "npm", "bin", "npm-cli.js");
}
function logFile() {
  return path.join(app.getPath("userData"), "pi-desktop-server.log");
}
function updateLogFile() {
  return path.join(app.getPath("userData"), "update.log");
}
function stateFile() {
  return path.join(app.getPath("userData"), "update-state.json");
}

let tray = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;
let quitting = false;
let quitUpdateDone = false;
let reusedExternal = false; // 当前复用的是外部 pi-web 服务(可能随时退出)
let watchdog = null;

// 标签页: id -> { id, content, url, project, cwdBase, unread, running, lastSeen }
const STRIP_HEIGHT = 40;
const tabs = new Map();
let tabSeq = 0;
let activeTabId = null;
let mainWindow = null;
let stripView = null;

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text);
  } catch {
    /* ignore */
  }
}

// 日志超过 5MB 时只保留末尾 512KB, 防无限增长
function trimLog(file) {
  try {
    const st = fs.statSync(file);
    if (st.size > 5 * 1024 * 1024) {
      const content = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, content.slice(-512 * 1024));
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 端口工具
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, APP_URL_HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function portResponds(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: APP_URL_HOST, port, path: "/", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    setTimeout(() => {
      req.destroy();
      resolve(false);
    }, timeoutMs);
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: APP_URL_HOST, port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
    setTimeout(() => {
      sock.destroy();
      resolve(true);
    }, 1500);
  });
}

function waitForServer(port, timeoutMs = 40000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      http
        .get({ host: APP_URL_HOST, port, path: "/", timeout: 2000 }, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`服务启动超时 (${timeoutMs}ms)`));
          } else {
            setTimeout(tryOnce, 250);
          }
        })
        .on("timeout", function () {
          this.destroy();
        });
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// 内置 npm 运行时
// 打包版以 tar.gz 随应用携带(electron-builder 会过滤裸目录里的 node_modules,
// 只能带压缩包), 首次需要时解压到用户数据目录, 之后复用
// ---------------------------------------------------------------------------
function ensureNpmRuntime() {
  if (!app.isPackaged) {
    return Promise.resolve(path.join(__dirname, "vendor", "npm", "bin", "npm-cli.js"));
  }
  const cli = npmRuntimeCli();
  if (fs.existsSync(cli)) return Promise.resolve(cli);
  const tarFile = path.join(process.resourcesPath, "npm-runtime.tar.gz");
  const dest = path.join(app.getPath("userData"), "npm-runtime");
  fs.mkdirSync(dest, { recursive: true });
  appendLog(updateLogFile(), `${new Date().toISOString()} 解压内置 npm 运行时...\n`);
  return new Promise((resolve, reject) => {
    // 用系统 tar 的绝对路径, 避免 PATH 里其他 tar(如 Git Bash 的 GNU tar)
    // 把 "C:\..." 误认为远程主机地址
    const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const child = spawn(tarExe, ["-xzf", tarFile, "-C", dest], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && fs.existsSync(cli)) resolve(cli);
      else reject(new Error(`内置 npm 运行时解压失败 (code=${code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// npm 操作 (全部经内置运行时, 与本机 Node 无关)
// ---------------------------------------------------------------------------
async function npmInstall(prefix, packages, useGlobalFlag) {
  const cli = await ensureNpmRuntime();
  return new Promise((resolve) => {
    const args = [cli, "install"];
    if (useGlobalFlag) args.push("-g");
    args.push(
      `--prefix`, prefix,
      `--registry=${NPM_REGISTRY}`,
      "--no-audit", "--no-fund", "--loglevel=error",
      ...packages
    );
    appendLog(updateLogFile(), `\n===== ${new Date().toISOString()} npm ${args.slice(1).join(" ")} =====\n`);
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => appendLog(updateLogFile(), d.toString()));
    child.stderr.on("data", (d) => appendLog(updateLogFile(), d.toString()));
    child.on("error", (err) => {
      appendLog(updateLogFile(), `spawn 失败: ${err.message}\n`);
      resolve(false);
    });
    child.on("exit", (code) => {
      appendLog(updateLogFile(), `===== 退出 code=${code} =====\n`);
      resolve(code === 0);
    });
  });
}

async function npmLatestVersion(pkg) {
  const cli = await ensureNpmRuntime();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, "view", `${pkg}@latest`, "version", `--registry=${NPM_REGISTRY}`],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() || null : null));
  });
}

// pi-web 的 postinstall(prepare-terminal)可能被本机 npm 的脚本审批机制拦截,
// 安装/更新后手动补跑一次, 保证终端组件就位
function runPrepareTerminal(prefix) {
  return new Promise((resolve) => {
    const script = path.join(
      prefix, "node_modules", "@agegr", "pi-web", "bin", "prepare-terminal.js"
    );
    if (!fs.existsSync(script)) {
      resolve();
      return;
    }
    appendLog(updateLogFile(), `${new Date().toISOString()} 运行 prepare-terminal\n`);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => appendLog(updateLogFile(), d.toString()));
    child.stderr.on("data", (d) => appendLog(updateLogFile(), d.toString()));
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

// ---------------------------------------------------------------------------
// 内核: 首次安装 / 退出时更新
// ---------------------------------------------------------------------------
function kernelVersion() {
  try {
    return JSON.parse(fs.readFileSync(kernelPkgJson(), "utf8")).version || null;
  } catch {
    return null;
  }
}

// 首次运行: 私有内核不存在 -> 显示初始化窗口, 下载 pi-web
async function firstRunInstall() {
  const win = new BrowserWindow({
    width: 460,
    height: 260,
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    title: "Pi Desktop",
    backgroundColor: "#0b1220",
  });
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;background:#0b1220;color:#dbe4f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">
          <h2 style="margin:0 0 12px">Pi Desktop</h2>
          <p style="margin:0;color:#8fa3bf">正在初始化必要组件，请保持网络连接。</p>
          <p style="color:#5b6b84;font-size:12px">此过程仅在首次运行时执行。</p>
        </body>`
      )
    );
  const ok = await npmInstall(
    privatePrefix(),
    [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`],
    false
  );
  if (ok) await runPrepareTerminal(privatePrefix());
  try {
    win.destroy();
  } catch {
    /* ignore */
  }
  if (!ok || !fs.existsSync(kernelBin())) {
    throw new Error(
      "初始化失败：组件下载未完成，请检查网络连接后重试。\n日志文件：" + updateLogFile()
    );
  }
}

// 退出时更新内核: 此刻服务已停, 文件无锁, 安静替换
async function updateKernelOnQuit() {
  try {
    const cur = kernelVersion();
    const latest = await npmLatestVersion(PI_WEB_PKG);
    appendLog(updateLogFile(), `${new Date().toISOString()} 退出检查: 当前=${cur} 最新=${latest}\n`);
    if (!latest || latest === cur) return;
    appendLog(updateLogFile(), `发现新版本 ${latest}, 退出前更新内核...\n`);
    const ok = await npmInstall(
    privatePrefix(),
    [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`],
    false
  );
    if (ok) await runPrepareTerminal(privatePrefix());
  } catch (err) {
    appendLog(updateLogFile(), `退出更新异常(忽略): ${err && err.message}\n`);
  }
}

// 启动后后台更新本机全局 npm 里的 pi / pi-web(cmd 用的两个工具)
// 被占用(EBUSY)或断网就下次再试, 永远不影响应用本身
async function backgroundGlobalToolsUpdate() {
  try {
    if (!globalHas("@agegr/pi-web") && !globalHas("@earendil-works/pi-coding-agent")) return;
    let last = 0;
    try {
      last = JSON.parse(fs.readFileSync(stateFile(), "utf8")).lastGlobalToolsUpdate || 0;
    } catch {
      /* ignore */
    }
    if (Date.now() - last < GLOBAL_TOOLS_UPDATE_INTERVAL_MS) return;

    // 成功后才记录时间, 失败(占用/断网)下次启动立即重试
    const ok = await npmInstall(
      globalPrefix(),
      [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`],
      true
    );
    if (ok) {
      await runPrepareTerminal(globalPrefix());
      fs.writeFileSync(stateFile(), JSON.stringify({ lastGlobalToolsUpdate: Date.now() }));
    }
  } catch (err) {
    appendLog(updateLogFile(), `全局工具更新异常(忽略): ${err && err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------
function stopServer() {
  if (!serverProcess) return Promise.resolve();
  const child = serverProcess;
  serverProcess = null;
  // 返回 Promise: 等服务真正退出(否则退出时更新内核会撞上文件锁)
  const exited = new Promise((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 2500); // 兜底
  });
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      }
    } catch {
      /* ignore */
    }
  }, 1500);
  return exited;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const bin = kernelBin();
    if (!fs.existsSync(bin)) {
      reject(new Error(`未找到服务组件：${bin}`));
      return;
    }
    appendLog(logFile(), `\n===== ${new Date().toISOString()} 启动服务 (port=${port}) =====\n`);

    // ELECTRON_RUN_AS_NODE=1: 用 Electron 内置的 Node 运行时跑 pi-web,
    // 不依赖本机安装的 Node.js
    serverProcess = spawn(
      process.execPath,
      [bin, "--no-open", "-p", String(port)],
      {
        cwd: privatePrefix(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    serverProcess.stdout.on("data", (d) => appendLog(logFile(), d.toString()));
    serverProcess.stderr.on("data", (d) => appendLog(logFile(), d.toString()));
    serverProcess.on("error", (err) => reject(new Error(`服务进程启动失败：${err.message}`)));
    serverProcess.on("exit", (code, signal) => {
      appendLog(logFile(), `===== ${new Date().toISOString()} 服务退出 code=${code} signal=${signal} =====\n`);
      serverProcess = null;
      if (!quitting) {
        dialog.showErrorBox(
          "服务异常终止",
          `服务进程意外退出（代码：${code}）。\n日志文件：${logFile()}`
        );
      }
    });

    waitForServer(port).then(() => resolve(port)).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘
// ---------------------------------------------------------------------------
function appIcon() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "build", "icon.ico");
}

function homeUrl() {
  return `http://${APP_URL_HOST}:${serverPort}`;
}

function stripHtml() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:${STRIP_HEIGHT}px;overflow:hidden;background:#101010}
#bar{display:flex;align-items:center;height:${STRIP_HEIGHT}px;padding:0 150px 0 8px;
  -webkit-app-region:drag;color:#dbe4f0;font:12px "Segoe UI",sans-serif;user-select:none}
#add{-webkit-app-region:no-drag;order:2;width:26px;height:26px;min-width:26px;border:none;border-radius:6px;
  background:transparent;color:#dbe4f0;font-size:16px;cursor:pointer;line-height:1}
#add:hover{background:rgba(255,255,255,.12)}
#add:disabled{opacity:.3;cursor:default}
#tabs{order:1;display:flex;align-items:center;gap:6px;overflow:hidden}
.tab{-webkit-app-region:no-drag;display:flex;align-items:center;gap:7px;width:150px;min-width:150px;
  padding:5px 8px;border-radius:8px;background:#1c1c22;color:#9aa4b2;cursor:pointer;white-space:nowrap;box-sizing:border-box}
.tab.active{background:#2c2c34;color:#ffffff}
.tab .label{flex:1;overflow:hidden;text-overflow:ellipsis}
.tab .x{border:none;background:transparent;color:inherit;font-size:12px;cursor:pointer;border-radius:4px;padding:0 4px;opacity:.6;line-height:1}
.tab .x:hover{background:rgba(255,255,255,.15);opacity:1}
.tab.dragover{outline:1px dashed #3b82f6;outline-offset:-1px}
.dot{width:8px;height:8px;min-width:8px;border-radius:50%;background:#6b7280}
.dot.unread{background:#3b82f6}
.dot.running{width:10px;height:10px;min-width:10px;background:transparent;
  border:2px solid #3b82f6;border-top-color:transparent;animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div id="bar"><div id="tabs"></div><button id="add" title="打开项目">+</button></div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function isLightColor(rgb) {
  const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const l = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
  return l > 150;
}

function toHexColor(rgb) {
  const m = String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const h = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
}

// 单个主窗口 + 顶部标签条(浏览器式标签页); 每个标签一个 pi-web 内容视图
function pushTabState() {
  if (!stripView || stripView.webContents.isDestroyed()) return;
  const list = [...tabs.values()].map((t) => ({
    id: t.id,
    title: t.project,
    status: t.running ? "running" : t.unread ? "unread" : "idle",
  }));
  stripView.webContents.send("app:tabs", {
    tabs: list,
    activeId: activeTabId,
    canNew: true, // 无上限
  });
  rebuildTray();
}

function layoutWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  if (stripView) stripView.setBounds({ x: 0, y: 0, width: w, height: STRIP_HEIGHT });
  const active = tabs.get(activeTabId);
  if (active) active.content.setBounds({ x: 0, y: STRIP_HEIGHT, width: w, height: h - STRIP_HEIGHT });
}

function destroyTabContent(entry) {
  if (!entry.content) return;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.contentView.removeChildView(entry.content);
    }
  } catch {
    /* ignore */
  }
  try {
    entry.content.webContents.close();
  } catch {
    /* ignore */
  }
  entry.content = null;
}

function ensureTabContent(entry) {
  if (entry.content && !entry.content.webContents.isDestroyed()) return;
  const content = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 每个标签独立的内存存储分区: 不读 pi-web 记住的"上次项目", 落在首页
      partition: `tab-${entry.id}`,
    },
  });
  entry.content = content;
  wireContentEvents(entry);
  content.webContents.loadURL(entry.url);
}

function switchTab(id) {
  if (!tabs.has(id) || !mainWindow || mainWindow.isDestroyed()) return;
  const prev = tabs.get(activeTabId);
  if (prev && prev.id !== id) {
    prev.lastSeen = Date.now();
    // 后台标签只从窗口卸下, 不销毁: 切回瞬时无刷新, 页面状态完整保留
    try {
      if (prev.content && !prev.content.webContents.isDestroyed()) {
        mainWindow.contentView.removeChildView(prev.content);
      }
    } catch {
      /* ignore */
    }
  }
  activeTabId = id;
  const t = tabs.get(id);
  t.unread = false; // 切到该标签即视为已读
  ensureTabContent(t);
  try {
    mainWindow.contentView.addChildView(t.content);
  } catch {
    /* ignore */
  }
  layoutWindow();
  mainWindow.setTitle(
    t.project ? `Pi Desktop - ${t.project} | Powered by Pi` : "Pi Desktop | Powered by Pi"
  );
  pushTabState();
}

function wireContentEvents(entry) {
  const { content } = entry;

  content.webContents.on("page-title-updated", (e, title) => {
    e.preventDefault();
    entry.project = title.replace(/\s*-\s*Pi Web\s*$/i, "").trim();
    if (entry.id === activeTabId) {
      mainWindow.setTitle(
        entry.project
          ? `Pi Desktop - ${entry.project} | Powered by Pi`
          : "Pi Desktop | Powered by Pi"
      );
    } else {
      entry.unread = true; // 后台标签有动态, 标记未读
    }
    pushTabState();
  });
  content.webContents.on("did-navigate", (_e, navUrl) => {
    entry.url = navUrl;
  });

  // 内容加载后同步标签条/原生按钮配色, 与 pi-web 顶栏协调
  content.webContents.on("did-finish-load", async () => {
    // 抓取项目路径按钮文本, 提取项目目录名(供状态轮询匹配)
    content.webContents
      .executeJavaScript(
        `(() => { const b = [...document.querySelectorAll("button")].find((x) => /[A-Za-z]:\\\\/.test(x.textContent || ""));
          return b ? b.textContent.trim() : ""; })()`
      )
      .then((cwd) => {
        if (cwd) entry.cwdBase = String(cwd).split(/[\\/]/).filter(Boolean).pop();
      })
      .catch(() => {});
    if (entry.id !== activeTabId || !mainWindow || mainWindow.isDestroyed()) return;
    try {
      const bg = await content.webContents.executeJavaScript(
        `(() => { const el = document.querySelector("header") || document.body;
          const c = getComputedStyle(el).backgroundColor;
          return c && c !== "rgba(0, 0, 0, 0)" ? c : "rgb(16,16,16)"; })()`
      );
      const hex = toHexColor(bg);
      if (hex) {
        const fg = isLightColor(bg) ? "#1f2328" : "#dbe4f0";
        mainWindow.setTitleBarOverlay({ color: hex, symbolColor: fg, height: STRIP_HEIGHT });
        if (stripView && !stripView.webContents.isDestroyed()) {
          stripView.webContents.send("app:bar-color", hex, fg);
        }
      }
    } catch {
      /* ignore */
    }
  });

  // 服务未就绪/被重启时自动重试加载, 不留白板错误页
  content.webContents.on("did-fail-load", () => {
    setTimeout(() => {
      if (!content.webContents.isDestroyed()) content.webContents.loadURL(entry.url);
    }, 3000);
  });

  // 外部链接交给系统浏览器
  content.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  content.webContents.on("will-navigate", (e, navUrl) => {
    if (!navUrl.startsWith(`http://${APP_URL_HOST}:${serverPort}`)) {
      e.preventDefault();
      if (/^https?:/i.test(navUrl)) shell.openExternal(navUrl);
    }
  });
}

function newTab(url, cwdBase) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const id = ++tabSeq;
  const entry = {
    id,
    content: null, // 后台标签不持有页面实例, 激活时才创建
    url: url || homeUrl(),
    project: cwdBase || "",
    cwdBase: cwdBase || "",
    unread: false,
    running: false,
    lastSeen: Date.now(),
  };
  tabs.set(id, entry);
  switchTab(id);
}

function closeTab(id) {
  const entry = tabs.get(id);
  if (!entry || tabs.size <= 1 || !mainWindow || mainWindow.isDestroyed()) return;
  destroyTabContent(entry);
  tabs.delete(id);
  if (activeTabId === id) {
    activeTabId = null;
    switchTab([...tabs.keys()][tabs.size - 1]);
  } else {
    pushTabState();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: "Pi Desktop",
    icon: appIcon(),
    backgroundColor: "#0b1220",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#101010", symbolColor: "#dbe4f0", height: STRIP_HEIGHT },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });

  stripView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "strip-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(stripView);
  stripView.webContents.loadURL(stripHtml());
  stripView.webContents.on("did-finish-load", () => pushTabState());

  layoutWindow();
  mainWindow.on("resize", layoutWindow);

  // 关窗 -> 托盘驻留, 标签页与服务都保留
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    for (const t of tabs.values()) destroyTabContent(t);
    tabs.clear();
    activeTabId = null;
    if (chooserWin && !chooserWin.isDestroyed()) chooserWin.close();
    chooserWin = null;
    chooserOpen = false;
    mainWindow = null;
    stripView = null;
    rebuildTray();
  });

  newTab();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// 项目选择面板: 点「+」弹出, 列出现有项目 + 新建项目; 选定后才开标签并直达项目
// ---------------------------------------------------------------------------
let chooserWin = null;
let chooserOpen = false;

function ensureChooser() {
  if (chooserWin && !chooserWin.isDestroyed()) return chooserWin;
  chooserWin = new BrowserWindow({
    parent: mainWindow,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    width: 380,
    height: 300,
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, "chooser-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  chooserWin.setMenu(null);
  chooserWin.webContents.loadURL(chooserHtml());
  chooserWin.on("blur", () => hideChooser());
  return chooserWin;
}

function hideChooser() {
  if (chooserWin && chooserOpen) {
    chooserWin.hide();
    chooserOpen = false;
  }
}

// 先弹出面板(加载中), 再异步填充项目列表, 避免等待造成"卡死"感
async function toggleChooser() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (chooserOpen) {
    hideChooser();
    return;
  }
  const w = ensureChooser();
  const b = mainWindow.getBounds();
  const rowsHint = 4;
  w.setSize(380, 48 + rowsHint * 46 + 48);
  w.setPosition(b.x + 10, b.y + STRIP_HEIGHT + 6);
  w.show();
  w.focus();
  chooserOpen = true;
  const wc = w.webContents;
  const fill = async () => {
    const projects = await fetchProjects();
    if (wc.isDestroyed()) return;
    const rows = Math.min(Math.max(projects.length, 1), 8);
    w.setSize(380, 48 + rows * 46 + 48);
    wc.send("app:projects", projects);
  };
  if (wc.isLoading()) wc.once("did-finish-load", fill);
  else fill();
}

function chooserHtml() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font:13px "Segoe UI","Microsoft YaHei",sans-serif}
#panel{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;
  background:#16161b;border:1px solid #2e2e38;border-radius:10px;overflow:hidden;color:#dbe4f0}
#head{padding:11px 14px 9px;font-size:12px;letter-spacing:.04em;color:#8fa3bf;
  border-bottom:1px solid #232329;display:flex;align-items:center;justify-content:space-between}
#list{flex:1;overflow-y:auto;padding:6px}
#list::-webkit-scrollbar{width:8px}
#list::-webkit-scrollbar-thumb{background:#2e2e38;border-radius:4px}
.row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer}
.row:hover{background:#232329}
.row:active{background:#2a2a31}
.fic{width:30px;height:30px;min-width:30px;border-radius:8px;background:#232329;display:flex;
  align-items:center;justify-content:center;color:#8fa3bf;font-size:15px}
.row-main{flex:1;min-width:0}
.name{font-size:13px;color:#e6edf7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cwd{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.count{font-size:11px;color:#8fa3bf;background:#26262e;border-radius:9px;padding:2px 9px}
#new{display:flex;align-items:center;gap:10px;margin:6px;padding:9px 10px;border-radius:8px;
  cursor:pointer;color:#7cb3ff;border-top:1px solid #232329;font-size:13px}
#new:hover{background:#232329}
.empty{padding:20px;color:#64748b;text-align:center}
.loading{padding:20px;color:#64748b;text-align:center}
</style></head><body><div id="panel"><div id="head">打开项目</div><div id="list"><div class="loading">加载中…</div></div><div id="new">＋ 新建项目（选择目录）…</div></div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

// 从 pi-web API 汇总项目列表(按会话目录去重, 最近活跃的排前面)
async function fetchProjects() {
  try {
    const res = await fetch(`http://${APP_URL_HOST}:${serverPort}/api/sessions`);
    const data = await res.json();
    const byCwd = new Map();
    for (const s of data.sessions || []) {
      if (!s.cwd) continue;
      const cur = byCwd.get(s.cwd) || { cwd: s.cwd, name: String(s.cwd).split(/[\\/]/).filter(Boolean).pop(), count: 0, last: 0 };
      cur.count += 1;
      cur.last = Math.max(cur.last, Date.parse(s.modified) || 0);
      byCwd.set(s.cwd, cur);
    }
    return [...byCwd.values()].sort((a, b) => b.last - a.last);
  } catch {
    return [];
  }
}

function openProjectInNewTab(cwd) {
  hideChooser();
  const base = String(cwd).split(/[\\/]/).filter(Boolean).pop();
  newTab(`${homeUrl()}/?cwd=${encodeURIComponent(cwd)}`, base);
}

// 标签条按钮事件
ipcMain.on("app:toggle-chooser", (e) => {
  if (stripView && e.sender === stripView.webContents) toggleChooser();
});
ipcMain.on("app:switch-tab", (e, id) => {
  if (stripView && e.sender === stripView.webContents) {
    hideChooser();
    switchTab(id);
  }
});
ipcMain.on("app:close-tab", (e, id) => {
  if (stripView && e.sender === stripView.webContents) {
    hideChooser();
    closeTab(id);
  }
});
ipcMain.on("app:reorder-tab", (e, { dragId, targetId }) => {
  if (!stripView || e.sender !== stripView.webContents) return;
  if (!tabs.has(dragId) || !tabs.has(targetId)) return;
  const entries = [...tabs.entries()];
  const from = entries.findIndex(([k]) => k === dragId);
  const to = entries.findIndex(([k]) => k === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = entries.splice(from, 1);
  entries.splice(to, 0, moved);
  tabs.clear();
  for (const [k, v] of entries) tabs.set(k, v);
  pushTabState();
});

// 选择面板事件
ipcMain.on("app:open-project", (e, cwd) => {
  if (chooserWin && !chooserWin.isDestroyed() && e.sender === chooserWin.webContents && typeof cwd === "string" && cwd) {
    openProjectInNewTab(cwd);
  }
});
ipcMain.on("app:browse-project", async (e) => {
  if (!chooserWin || chooserWin.isDestroyed() || e.sender !== chooserWin.webContents) return;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (!r.canceled && r.filePaths[0]) openProjectInNewTab(r.filePaths[0]);
  else hideChooser();
});
ipcMain.on("app:close-chooser", (e) => {
  if (chooserWin && !chooserWin.isDestroyed() && e.sender === chooserWin.webContents) hideChooser();
});

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip("Pi Desktop");
  tray.on("click", () => showMainWindow());
  rebuildTray();
}

// 托盘菜单动态重建: 「已打开的项目」列出当前标签页
function rebuildTray() {
  if (!tray) return;
  const items = [
    { label: "打开 Pi Desktop", click: () => showMainWindow() },
    { label: "在浏览器中打开", click: () => shell.openExternal(homeUrl()) },
  ];
  if (tabs.size) {
    items.push({ type: "separator" });
    items.push({ label: "已打开的项目", enabled: false });
    for (const entry of tabs.values()) {
      items.push({
        label: entry.project || "首页",
        click: () => {
          showMainWindow();
          switchTab(entry.id);
        },
      });
    }
  }
  items.push({ type: "separator" });
  items.push({
    label: "退出",
    click: () => {
      quitting = true;
      app.quit();
    },
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------------------------------------------------------------------------
// 壳自更新 (GitHub Releases)
// ---------------------------------------------------------------------------
function setupShellAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => {
      const r = dialog.showMessageBoxSync({
        type: "info",
        title: "软件更新",
        message: `新版本 ${info.version} 已下载完成`,
        detail: "重新启动应用程序以完成更新。",
        buttons: ["立即重新启动", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) {
        quitting = true;
        stopServer();
        quitUpdateDone = true;
        autoUpdater.quitAndInstall();
      }
    });
    autoUpdater.on("error", (err) => {
      appendLog(updateLogFile(), `壳更新检查失败(可忽略): ${err && err.message}\n`);
    });
    autoUpdater.checkForUpdates().catch(() => {});
  } catch {
    /* dev 模式或缺少更新配置时忽略 */
  }
}

// ---------------------------------------------------------------------------
// 看门狗: 复用的外部服务一旦退出(比如用户关掉 cmd 的 pi-web),
// 自动起应用自己的服务并让窗口重新加载
// ---------------------------------------------------------------------------
function startWatchdog() {
  watchdog = setInterval(async () => {
    if (quitting || !reusedExternal) return;
    if (await portResponds(serverPort, 3000)) return;
    appendLog(logFile(), `${new Date().toISOString()} 外部服务已退出, 启动内置服务\n`);
    reusedExternal = false;
    try {
      serverPort = (await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : await getFreePort();
      await startServer(serverPort);
      for (const entry of tabs.values()) {
        entry.url = `http://${APP_URL_HOST}:${serverPort}`;
        if (entry.content && !entry.content.webContents.isDestroyed()) {
          entry.content.webContents.loadURL(entry.url);
        }
      }
    } catch (err) {
      appendLog(logFile(), `看门狗重启服务失败: ${err && err.message}\n`);
    }
  }, 5000);
}

// 标签状态轮询: 主进程直接查 pi-web API(不触碰页面, 零渲染开销)
// 运行中(该标签项目下有会话在跑) -> 旋转圈; 后台标签项目有新动态 -> 蓝点; 其余 -> 灰点
let statusTimer = null;
function startStatusPoller() {
  statusTimer = setInterval(async () => {
    if (quitting || !tabs.size) return;
    try {
      const res = await fetch(`http://${APP_URL_HOST}:${serverPort}/api/sessions`);
      const data = await res.json();
      const runningIds = new Set(data.runningSessionIds || []);
      const baseName = (cwd) => String(cwd || "").split(/[\\/]/).filter(Boolean).pop();
      const runningCwds = new Set();
      for (const s of data.sessions || []) {
        if (runningIds.has(s.id)) runningCwds.add(baseName(s.cwd));
      }
      const now = Date.now();
      let changed = false;
      for (const entry of tabs.values()) {
        if (!entry.cwdBase) continue;
        const running = runningCwds.has(entry.cwdBase);
        if (running !== !!entry.running) {
          if (entry.running && !running && entry.id !== activeTabId) entry.unread = true;
          entry.running = running;
          changed = true;
        }
        // 后台标签的项目下有会话内容更新 -> 未读蓝点
        if (entry.id !== activeTabId && !entry.unread) {
          const latest = Math.max(
            0,
            ...(data.sessions || [])
              .filter((s) => baseName(s.cwd) === entry.cwdBase)
              .map((s) => Date.parse(s.modified) || 0)
          );
          if (latest > entry.lastSeen) {
            entry.unread = true;
            changed = true;
          }
        }
      }
      if (changed) pushTabState();
    } catch {
      /* 服务暂不可达时跳过本轮 */
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.github.wangjk1996-cloud.pidesktop");
    // 移除默认菜单栏(否则 Alt/Ctrl 组合键会唤出)
    Menu.setApplicationMenu(null);
    trimLog(logFile());
    trimLog(updateLogFile());
    try {
      // 1. 首次运行: 下载私有内核(一次性)
      if (!fs.existsSync(kernelBin())) await firstRunInstall();

      // 2. 端口策略: 默认端口空闲则启动服务; 已有 pi-web 在跑则直接复用; 否则换空闲端口
      if (await isPortFree(DEFAULT_PORT)) {
        serverPort = DEFAULT_PORT;
        await startServer(serverPort);
      } else if (await portResponds(DEFAULT_PORT)) {
        serverPort = DEFAULT_PORT;
        reusedExternal = true; // 复用的是别人的服务, 由看门狗盯防它退出
      } else {
        serverPort = await getFreePort();
        await startServer(serverPort);
      }
    } catch (err) {
      dialog.showErrorBox("启动失败", String((err && err.message) || err));
      app.exit(1);
      return;
    }

    createMainWindow();
    createTray();
    setupShellAutoUpdate();
    startWatchdog();
    startStatusPoller();
    console.log(`[pi-desktop] 服务就绪: http://${APP_URL_HOST}:${serverPort}`);

    // 3. 窗口出来后后台顺带更新全局的 pi / pi-web (cmd 用的), 失败就下次
    setTimeout(() => backgroundGlobalToolsUpdate(), 8000);
  });

  app.on("before-quit", (e) => {
    quitting = true;
    if (watchdog) clearInterval(watchdog);
    if (statusTimer) clearInterval(statusTimer);
    // 退出时检查内核更新: 先等服务真正退出(无文件锁), 有新版则静默更新完再退出
    if (!quitUpdateDone && fs.existsSync(kernelBin())) {
      quitUpdateDone = true;
      e.preventDefault();
      const timer = setTimeout(() => app.quit(), QUIT_UPDATE_TIMEOUT_MS);
      stopServer()
        .then(() => updateKernelOnQuit())
        .finally(() => {
          clearTimeout(timer);
          app.quit();
        });
    } else {
      stopServer();
    }
  });

  app.on("window-all-closed", () => {
    // 托盘驻留模式: 不自动退出
  });

  app.on("activate", () => {
    showMainWindow();
  });
}

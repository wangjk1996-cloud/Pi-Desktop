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

const { app, BrowserWindow, WebContentsView, Tray, Menu, dialog, shell, screen, ipcMain } = require("electron");
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

function projectPreferencesFile() {
  return path.join(app.getPath("userData"), "project-preferences.json");
}
function projectKey(cwd) {
  return path.resolve(String(cwd)).toLowerCase();
}
let projectPreferences = null;
function getProjectPreferences() {
  if (projectPreferences) return projectPreferences;
  try {
    const saved = JSON.parse(fs.readFileSync(projectPreferencesFile(), "utf8"));
    projectPreferences = {
      names: saved.names && typeof saved.names === "object" ? saved.names : {},
      order: Array.isArray(saved.order) ? saved.order : [],
      opened: Array.isArray(saved.opened) ? saved.opened : [],
      hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
    };
  } catch {
    projectPreferences = { names: {}, order: [], opened: [], hidden: [] };
  }
  return projectPreferences;
}
function saveProjectPreferences() {
  fs.writeFileSync(projectPreferencesFile(), JSON.stringify(getProjectPreferences(), null, 2));
}
function projectDisplayName(cwd) {
  return getProjectPreferences().names[projectKey(cwd)] || path.basename(cwd);
}
function recordOpenedProject(cwd) {
  const preferences = getProjectPreferences();
  const key = projectKey(cwd);
  preferences.opened = preferences.opened.filter((item) => item && typeof item.cwd === "string" && projectKey(item.cwd) !== key);
  preferences.opened.unshift({ cwd, last: Date.now() });
  preferences.hidden = preferences.hidden.filter((item) => item !== key);
  try {
    saveProjectPreferences();
  } catch {
    /* 最近项目仍保留在本次运行的内存中 */
  }
  void refreshHomeProjects();
}

let tray = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;
let quitting = false;
let quitUpdateDone = false;
let reusedExternal = false; // 当前复用的是外部 pi-web 服务(可能随时退出)
let watchdog = null;

// 标签页: id -> { id, content, url, project, cwd, cwdBase, unread, running, lastSeen }
const STRIP_HEIGHT = 40;
const OVERFLOW_WIDTH = 224;
const tabs = new Map();
let tabSeq = 0;
let activeTabId = null;
let mainWindow = null;
let stripView = null;
let stripReady = false;
let firstContentReady = false;
let initialWindowShown = false;

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

function tabHomeUrl() {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#1b1d22;color:#eff1f5;font-family:"Segoe UI","Microsoft YaHei",sans-serif;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
svg{shape-rendering:geometricPrecision}
body{box-sizing:border-box;padding:clamp(64px,18vh,148px) 32px 24px}
main{width:min(100%,840px);height:100%;min-height:0;margin:0 auto;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:18px;flex:none;color:#f2f3f6;font:700 58px/1 "Times New Roman",serif;letter-spacing:.027em}
.mark{width:64px;height:64px;border-radius:14px;flex:none}
.welcome{flex:none;margin-top:34px}
h1{font:500 28px/1.3 "Noto Serif SC",serif;letter-spacing:0;margin:0 0 8px}
.intro{font-size:14px;line-height:1.7;color:#9da6b5;margin:0}
#browse{display:inline-flex;align-items:center;gap:8px;height:40px;margin-top:28px;padding:0 12px;
  border:1px solid transparent;border-radius:10px;background:#dce6f8;color:#1b2940;
  box-shadow:inset 0 0 0 1px #c4d0e8;cursor:pointer;font:700 16px "Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),box-shadow .14s cubic-bezier(.25,1,.5,1)}
#browse:hover{background:#eef3fd;box-shadow:inset 0 0 0 1px #eef3fd}
#browse:focus-visible,.project:focus-visible{outline:2px solid #8eafe8;outline-offset:2px}
#browse svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.recent{display:flex;flex:1;flex-direction:column;min-height:0;margin-top:30px}
.heading{display:flex;flex:none;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:15px;
  border-bottom:1px solid #383b43;font-size:15px;font-weight:600;color:#e5e8ef}
#project-count{font-size:12px;font-weight:400;color:#858e9d}
#projects{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#414650 transparent;padding:7px 4px 0 0}
#projects::-webkit-scrollbar{width:6px}
#projects::-webkit-scrollbar-thumb{background:#414650;border-radius:5px}
.project{display:flex;align-items:center;gap:15px;width:100%;min-height:90px;padding:10px 13px;margin-top:7px;
  box-sizing:border-box;border:1px solid transparent;border-radius:10px;box-shadow:inset 0 0 0 1px #2a2e36;background:#22252b;color:#eef0f4;text-align:left;cursor:pointer;font:inherit;
  transition:background-color .14s cubic-bezier(.25,1,.5,1)}
.project:hover{background:#2b3039}
.project.editing,.project.confirming{background:#2b3039}
.project.opening{cursor:progress}
.project.dragging{opacity:.45}
.project.drop-before{box-shadow:inset 0 2px #8eafe8}
.project.drop-after{box-shadow:inset 0 -2px #8eafe8}
.grip{display:grid;place-items:center;flex:0 0 15px;color:#727c8d;cursor:grab}
.grip svg{width:15px;height:19px;fill:currentColor}
.folder{display:grid;place-items:center;flex:0 0 23px;color:#9aa6ba}
.folder svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.details{flex:1;min-width:0}.name,.cwd{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.name{font-size:15px;font-weight:700}.cwd{font-size:12px;color:#8f98a8;margin-top:5px}
.project.confirming .name{color:#f0c6c9}
.project.opening .cwd{color:#a9c4f1}
.count{flex:none;font-size:11px;color:#858e9d}
.actions{display:flex;align-items:center;gap:3px;flex:none}
.rename,.remove{display:grid;place-items:center;width:29px;height:29px;padding:0;border:0;border-radius:8px;
  background:transparent;color:#aeb8c8;cursor:pointer;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),color .14s cubic-bezier(.25,1,.5,1)}
.rename:hover,.rename:focus-visible{background:#354055;color:#d0dfff;outline:none}
.remove:hover,.remove:focus-visible{background:#43343a;color:#f0b9bc;outline:none}
.rename svg,.remove svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.name-editor{min-width:0;width:min(100%,280px);height:27px;box-sizing:border-box;padding:2px 6px;margin:-3px 0;
  border:1px solid #8eafe8;border-radius:5px;outline:none;background:#171b22;color:#fff;font:700 15px "Segoe UI","Microsoft YaHei",sans-serif}
.name-editor.invalid{border-color:#ef8888}
.decision{height:30px;padding:0 10px;border:1px solid #4b5260;border-radius:8px;
  background:#303640;color:#dce4ef;cursor:pointer;font:600 12px "Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),border-color .14s cubic-bezier(.25,1,.5,1),color .14s cubic-bezier(.25,1,.5,1)}
.decision:hover,.decision:focus-visible{background:#404858;border-color:#65728a;outline:none}
.decision.primary{background:#dce6f8;border-color:#dce6f8;color:#1b2940}
.decision.primary:hover,.decision.primary:focus-visible{background:#eef3fd;border-color:#eef3fd}
.decision.danger{background:#614049;border-color:#78505a;color:#ffe4e6}
.decision.danger:hover,.decision.danger:focus-visible{background:#77505a;border-color:#95636c}
.decision:disabled{opacity:.55;cursor:default}
.project.editing .actions,.project.confirming .actions{animation:actions-in .18s cubic-bezier(.25,1,.5,1) both}
@keyframes actions-in{from{opacity:.55;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
.empty{padding:30px 13px;color:#929cac;font-size:12px}
@media(max-height:650px){body{padding-top:64px}.welcome{margin-top:25px}.project{min-height:76px}}
@media(prefers-reduced-motion:reduce){#browse,.project,.rename,.remove,.decision{transition:none}.project.editing .actions,.project.confirming .actions{animation:none}}
</style></head><body><main><div class="brand"><svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-label="Pi Desktop"><rect x="0" y="0" width="1024" height="1024" rx="230" ry="230" fill="#101010"/><text x="512" y="866" font-family="'Times New Roman'" font-weight="bold" font-size="1450" fill="#fff" text-anchor="middle">π</text></svg><span>Pi Desktop</span></div><header class="welcome"><h1 id="greeting">欢迎使用 Pi Desktop</h1><p class="intro">从最近项目继续，或指定其他工作目录。</p><button id="browse"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>打开项目目录</button></header><section class="recent"><div class="heading">最近项目<span id="project-count"></span></div><div id="projects"><div class="empty">正在加载项目…</div></div></section></main></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function stripHtml() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:${STRIP_HEIGHT}px;overflow:hidden;background:#15161a;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
svg{shape-rendering:geometricPrecision}
#bar{display:flex;align-items:center;gap:5px;height:${STRIP_HEIGHT}px;padding:0 146px 0 9px;
  box-sizing:border-box;-webkit-app-region:drag;color:#d9dce3;font:14px "Segoe UI","Microsoft YaHei",sans-serif;user-select:none}
#tabs{display:flex;align-items:center;gap:5px;flex:0 1 auto;min-width:0;height:100%;
  overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-app-region:no-drag}
#tabs::-webkit-scrollbar{display:none}
.tab{display:flex;align-items:center;gap:7px;flex:0 0 148px;width:148px;height:29px;
  padding:0 8px 0 10px;border:1px solid transparent;border-radius:9px;
  background:#22242a;color:#aeb4c0;cursor:pointer;white-space:nowrap;box-sizing:border-box;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),color .14s cubic-bezier(.25,1,.5,1)}
.tab:hover{background:#2b2e36;color:#f0f2f6}
.tab.active{background:#353944;box-shadow:inset 0 0 0 1px #4c5260;color:#fff}
.tab:focus-visible,#add:focus-visible,.nav:focus-visible{outline:2px solid #7eaeff;outline-offset:-2px}
.tab .label{flex:1;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.tab.renaming .label{display:none}
.rename-input{flex:1;min-width:0;height:22px;padding:0 4px;border:1px solid #8eafe8;border-radius:4px;
  outline:none;background:#171b22;color:#fff;font:600 13px "Segoe UI","Microsoft YaHei",sans-serif}
.rename-input.invalid{border-color:#ef8888}
.tab .x{display:grid;place-items:center;border:none;background:transparent;color:inherit;cursor:pointer;border-radius:6px;
  width:19px;height:19px;padding:0;opacity:.65}
.tab .x svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.tab .x:hover{background:rgba(255,255,255,.16);opacity:1}
.tab.dragover{outline:1px dashed #3b82f6;outline-offset:-1px}
.dot{display:grid;place-items:center;flex:0 0 14px;width:14px;height:14px}
.dot::before{content:"";width:8px;height:8px;border-radius:50%;background:#6b7280}
.dot.unread::before{background:#fbbf24}
.dot.running::before{display:none}
.dot svg{display:none;width:13px;height:13px;color:#a4c2f4}
.dot.running svg{display:block;animation:tab-spin 1s linear infinite}
@keyframes tab-spin{to{transform:rotate(360deg)}}
#add,.nav{-webkit-app-region:no-drag;flex:0 0 28px;width:28px;height:28px;border:0;border-radius:9px;
  background:transparent;color:#b9c0cc;cursor:pointer;display:grid;place-items:center;padding:0;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),color .14s cubic-bezier(.25,1,.5,1)}
#add svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.nav svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}
#add:hover,.nav:hover{background:#30343d;color:#fff}
.nav:disabled{opacity:.3;cursor:default;background:transparent}
#nav{display:none;align-items:center;gap:2px;margin-left:3px;-webkit-app-region:no-drag}
#bar.overflow #nav{display:flex}
#all{margin-left:2px;background:#2c3039;border:1px solid transparent;box-shadow:inset 0 0 0 1px #444a56}
#bar.light .tab{background:#e9ebef;color:#555f6c}
#bar.light .tab:hover{background:#dde1e8;color:#1f2328}
#bar.light .tab.active{background:#fff;box-shadow:inset 0 0 0 1px #c6cdd7;color:#1f2328}
#bar.light .tab .x:hover{background:#d9dee6}
#bar.light #add,#bar.light .nav{color:#4c5665}
#bar.light #add:hover,#bar.light .nav:hover{background:#dce2e9;color:#1f2328}
#bar.light #all{background:#e9ebef;box-shadow:inset 0 0 0 1px #c6cdd7}
@media(prefers-reduced-motion:reduce){.tab,#add,.nav{transition:none}.dot.running svg{animation:none}}
</style></head><body><div id="bar"><div id="tabs" role="tablist"></div><button id="add" title="新建标签页" aria-label="新建标签页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><div id="nav"><button class="nav" id="left" title="向左滚动标签页" aria-label="向左滚动标签页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><button class="nav" id="right" title="向右滚动标签页" aria-label="向右滚动标签页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button><button class="nav" id="all" title="全部标签页" aria-label="全部标签页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div></div></body></html>`;
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

async function syncTabColor(entry, content) {
  if (entry.id !== activeTabId || entry.content !== content || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bg = await content.webContents.executeJavaScript(
      `(() => { const el = document.querySelector("header") || document.body;
        const c = getComputedStyle(el).backgroundColor;
        return c && c !== "rgba(0, 0, 0, 0)" ? c : "rgb(16,16,16)"; })()`
    );
    if (entry.id !== activeTabId || entry.content !== content) return;
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
}

// 单个主窗口 + 顶部标签条(浏览器式标签页); 每个标签一个 pi-web 内容视图
function pushTabState() {
  if (!stripView || stripView.webContents.isDestroyed()) return;
  const list = [...tabs.values()].map((t) => ({
    id: t.id,
    title: t.project,
    canRename: !!t.cwd,
    status: t.running ? "running" : t.unread ? "unread" : "idle",
  }));
  stripView.webContents.send("app:tabs", {
    tabs: list,
    activeId: activeTabId,
    canNew: true, // 无上限
  });
  if (overflowOpen && overflowWin && !overflowWin.isDestroyed()) {
    overflowWin.webContents.send("app:overflow-tabs", { tabs: list, activeId: activeTabId });
  }
  rebuildTray();
}

function layoutWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w, h] = mainWindow.getContentSize();
  if (stripView) stripView.setBounds({ x: 0, y: 0, width: w, height: STRIP_HEIGHT });
  const active = tabs.get(activeTabId);
  if (active?.content) active.content.setBounds({ x: 0, y: STRIP_HEIGHT, width: w, height: h - STRIP_HEIGHT });
  if (active?.pendingContent) active.pendingContent.setBounds({ x: 0, y: STRIP_HEIGHT, width: w, height: h - STRIP_HEIGHT });
  const visible = mainWindow.contentView.children.find((view) => view !== stripView);
  if (visible && visible !== active?.content) visible.setBounds({ x: 0, y: STRIP_HEIGHT, width: w, height: h - STRIP_HEIGHT });
}

function showTabView(entry) {
  if (!mainWindow || mainWindow.isDestroyed() || !entry.content) return;
  layoutWindow();
  if (entry.pendingContent && !mainWindow.contentView.children.includes(entry.pendingContent)) {
    const index = mainWindow.contentView.children.indexOf(entry.content);
    mainWindow.contentView.addChildView(entry.pendingContent, index < 0 ? undefined : index);
  }
  if (!mainWindow.contentView.children.includes(entry.content)) mainWindow.contentView.addChildView(entry.content);
  const keep = new Set([stripView, entry.content, entry.pendingContent]);
  for (const view of [...mainWindow.contentView.children]) {
    if (!keep.has(view)) mainWindow.contentView.removeChildView(view);
  }
  for (const tab of tabs.values()) {
    if (tab.retiringContent && !mainWindow.contentView.children.includes(tab.retiringContent)) {
      tab.retiringContent.webContents.close();
      tab.retiringContent = null;
    }
  }
}

function showInitialWindowIfReady() {
  if (!initialWindowShown && stripReady && firstContentReady && mainWindow && !mainWindow.isDestroyed()) {
    initialWindowShown = true;
    mainWindow.show();
  }
}

function destroyTabContent(entry) {
  if (entry.retiringContent) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.children.includes(entry.retiringContent)) {
      mainWindow.contentView.removeChildView(entry.retiringContent);
    }
    entry.retiringContent.webContents.close();
    entry.retiringContent = null;
  }
  if (entry.pendingContent) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.children.includes(entry.pendingContent)) {
      mainWindow.contentView.removeChildView(entry.pendingContent);
    }
    entry.pendingContent.webContents.close();
    entry.pendingContent = null;
  }
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
      preload: path.join(__dirname, "home-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 每个标签独立的内存存储分区: 不读 pi-web 记住的"上次项目", 落在首页
      partition: `tab-${entry.id}`,
    },
  });
  content.setBackgroundColor("#1b1d22");
  entry.content = content;
  entry.homeReady = !entry.url.startsWith("data:text/html");
  wireContentEvents(entry);
  content.webContents.loadURL(entry.url);
}

function switchTab(id) {
  if (!tabs.has(id) || !mainWindow || mainWindow.isDestroyed()) return;
  const prev = tabs.get(activeTabId);
  if (prev && prev.id !== id) {
    prev.lastSeen = Date.now();
  }
  activeTabId = id;
  const t = tabs.get(id);
  t.unread = false; // 切到该标签即视为已读
  ensureTabContent(t);
  if (t.homeReady) showTabView(t);
  layoutWindow();
  mainWindow.setTitle(
    `Pi Desktop - ${t.project || "首页"} | Powered by Pi`
  );
  pushTabState();
  if (t.url.startsWith("data:text/html")) void refreshHomeProjects();
}

function wireContentEvents(entry) {
  const { content } = entry;

  content.webContents.on("page-title-updated", (e, title) => {
    e.preventDefault();
    if (entry.url.startsWith("data:text/html")) return;
    entry.project = entry.cwd && getProjectPreferences().names[projectKey(entry.cwd)]
      ? projectDisplayName(entry.cwd)
      : title.replace(/\s*-\s*Pi Web\s*$/i, "").trim();
    if (entry.id === activeTabId) {
      mainWindow.setTitle(
        entry.project
          ? `Pi Desktop - ${entry.project} | Powered by Pi`
          : "Pi Desktop - 首页 | Powered by Pi"
      );
    } else {
      entry.unread = true; // 后台标签有动态, 标记未读
    }
    pushTabState();
  });
  content.webContents.on("did-navigate", (_e, navUrl) => {
    entry.url = navUrl;
    try {
      const cwd = new URL(navUrl).searchParams.get("cwd");
      if (cwd && cwd !== entry.cwd) {
        entry.cwd = cwd;
        entry.cwdBase = path.basename(cwd);
        entry.project = projectDisplayName(cwd);
        pushTabState();
        recordOpenedProject(cwd);
      }
    } catch {
      /* 首页 data URL 不含项目路径 */
    }
  });

  // 内容加载后同步标签条/原生按钮配色, 与 pi-web 顶栏协调
  content.webContents.on("did-finish-load", async () => {
    if (entry.url.startsWith("data:text/html")) {
      entry.homeReady = true;
      if (entry.id === activeTabId && mainWindow && !mainWindow.isDestroyed()) {
        showTabView(entry);
        firstContentReady = true;
        showInitialWindowIfReady();
      }
    }
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
    await syncTabColor(entry, content);
  });

  // 服务未就绪/被重启时自动重试加载, 不留白板错误页
  content.webContents.on("did-fail-load", (_e, errorCode, _description, _url, isMainFrame) => {
    if (errorCode === -3 || !isMainFrame) return;
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

function newTab() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const id = ++tabSeq;
  const entry = {
    id,
    content: null, // 后台标签不持有页面实例, 激活时才创建
    url: tabHomeUrl(),
    project: "",
    cwd: "",
    cwdBase: "",
    unread: false,
    running: false,
    lastSeen: Date.now(),
  };
  // "+" 位于标签栏末尾，新标签也追加到末尾
  tabs.set(id, entry);
  switchTab(id);
}

function closeTab(id) {
  const entry = tabs.get(id);
  if (!entry || tabs.size <= 1 || !mainWindow || mainWindow.isDestroyed()) return;
  const ids = [...tabs.keys()];
  const index = ids.indexOf(id);
  const nextId = ids[index + 1] || ids[index - 1];
  destroyTabContent(entry);
  tabs.delete(id);
  if (activeTabId === id) {
    activeTabId = null;
    switchTab(nextId);
  } else {
    pushTabState();
  }
}

function createMainWindow() {
  stripReady = false;
  firstContentReady = false;
  initialWindowShown = false;
  mainWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: "Pi Desktop",
    icon: appIcon(),
    backgroundColor: "#1b1d22",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#101010", symbolColor: "#dbe4f0", height: STRIP_HEIGHT },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<html style="height:100%;background:#1b1d22"><body style="margin:0"></body></html>'));

  stripView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "strip-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(stripView);
  stripView.webContents.on("did-finish-load", () => {
    stripReady = true;
    pushTabState();
    showInitialWindowIfReady();
  });
  stripView.webContents.loadURL(stripHtml());

  layoutWindow();
  mainWindow.on("resize", () => { layoutWindow(); hideOverflow(); });
  mainWindow.on("move", hideOverflow);

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
    if (overflowWin && !overflowWin.isDestroyed()) overflowWin.close();
    overflowWin = null;
    overflowOpen = false;
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
// 溢出标签面板
// ---------------------------------------------------------------------------
let overflowWin = null;
let overflowOpen = false;

function ensureOverflow() {
  if (overflowWin && !overflowWin.isDestroyed()) return overflowWin;
  overflowWin = new BrowserWindow({
    parent: mainWindow,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    width: OVERFLOW_WIDTH,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, "overflow-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  overflowWin.setMenu(null);
  overflowWin.webContents.loadURL(overflowHtml());
  overflowWin.on("blur", hideOverflow);
  return overflowWin;
}

function hideOverflow() {
  if (overflowWin && overflowOpen) {
    overflowWin.hide();
    overflowOpen = false;
  }
}

function toggleOverflow(anchorRight) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (overflowOpen) {
    hideOverflow();
    return;
  }
  const w = ensureOverflow();
  const b = mainWindow.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  w.setSize(OVERFLOW_WIDTH, 52 + Math.min(tabs.size, 8) * 42);
  const x = Math.max(work.x, Math.min(b.x + Math.round(Number(anchorRight) || 0) - OVERFLOW_WIDTH, work.x + work.width - OVERFLOW_WIDTH));
  const y = Math.max(work.y, Math.min(b.y + STRIP_HEIGHT + 4, work.y + work.height - w.getSize()[1]));
  w.setPosition(x, y);
  overflowOpen = true;
  const wc = w.webContents;
  const fill = () => {
    if (!wc.isDestroyed() && overflowOpen) wc.send("app:overflow-tabs", {
      tabs: [...tabs.values()].map((t) => ({ id: t.id, title: t.project, status: t.running ? "running" : t.unread ? "unread" : "idle" })),
      activeId: activeTabId,
      revealActive: true,
    });
  };
  if (wc.isLoading()) wc.once("did-finish-load", fill);
  else fill();
}

function overflowHtml() {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font:13px "Segoe UI","Microsoft YaHei",sans-serif;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}
svg{shape-rendering:geometricPrecision}
#panel{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;
  background:#1b1d23;border:1px solid transparent;border-radius:12px;overflow:hidden;color:#e8ebf0;
  box-shadow:inset 0 0 0 1px #3b404a,0 12px 30px rgba(0,0,0,.38)}
#head{padding:15px 16px 9px;font-size:12px;font-weight:600;color:#c7ccd6}
#list{flex:1;overflow-y:auto;scrollbar-width:none;padding:3px 7px 8px}
#list::-webkit-scrollbar{display:none}
.row{display:flex;align-items:center;gap:10px;width:100%;height:42px;padding:0 11px;border:0;
  border-radius:9px;background:transparent;color:#dce1e9;text-align:left;cursor:pointer;font:inherit;
  transition:background-color .14s cubic-bezier(.25,1,.5,1),color .14s cubic-bezier(.25,1,.5,1)}
.row:hover,.row:focus-visible{background:#30343d;outline:none}
.row.active{background:#2e3440;color:#fff}
.num{color:#7f8998;font-size:11px;width:18px;flex:0 0 18px}
.label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dot{display:grid;place-items:center;flex:0 0 14px;width:14px;height:14px}
.dot::before{content:"";width:8px;height:8px;border-radius:50%;background:#687383}
.dot.unread::before{background:#fbbf24}
.dot.running::before{display:none}
.dot svg{display:none;width:13px;height:13px;color:#a4c2f4}
.dot.running svg{display:block;animation:tab-spin 1s linear infinite}
@keyframes tab-spin{to{transform:rotate(360deg)}}
.check{width:15px;color:#9ec1ff;text-align:center}
@media(prefers-reduced-motion:reduce){.row{transition:none}.dot.running svg{animation:none}}
</style></head><body><div id="panel"><div id="head">全部标签页</div><div id="list"></div></div></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

// pi-web 会话与 Pi Desktop 打开过的目录合并；无会话的新项目也立即出现在首页
function projectsFromSessions(data) {
  const byCwd = new Map();
  const preferences = getProjectPreferences();
  const hidden = new Set(preferences.hidden);
  for (const session of data.sessions || []) {
    if (!session.cwd) continue;
    const key = projectKey(session.cwd);
    if (hidden.has(key)) continue;
    const project = byCwd.get(key) || { cwd: session.cwd, name: projectDisplayName(session.cwd), count: 0, last: 0 };
    project.count += 1;
    project.last = Math.max(project.last, Date.parse(session.modified) || 0);
    byCwd.set(key, project);
  }
  for (const item of preferences.opened) {
    if (!item || typeof item.cwd !== "string") continue;
    const key = projectKey(item.cwd);
    if (hidden.has(key)) continue;
    const project = byCwd.get(key) || { cwd: item.cwd, name: projectDisplayName(item.cwd), count: 0, last: 0 };
    project.last = Math.max(project.last, Number(item.last) || 0);
    byCwd.set(key, project);
  }
  const ranks = new Map(preferences.order.map((key, index) => [key, index]));
  return [...byCwd.values()].sort((a, b) => {
    const aRank = ranks.get(projectKey(a.cwd)) ?? Infinity;
    const bRank = ranks.get(projectKey(b.cwd)) ?? Infinity;
    return aRank - bRank || b.last - a.last;
  });
}

async function fetchProjects() {
  try {
    const res = await fetch(`http://${APP_URL_HOST}:${serverPort}/api/sessions`);
    return projectsFromSessions(await res.json());
  } catch {
    return projectsFromSessions({ sessions: [] });
  }
}

function sendHomeProjects(projects) {
  for (const entry of tabs.values()) {
    if (entry.url.startsWith("data:text/html") && entry.content && !entry.content.webContents.isDestroyed()) {
      entry.content.webContents.send("app:home-projects", projects);
    }
  }
}
async function refreshHomeProjects() {
  sendHomeProjects(await fetchProjects());
}

function renameProjectDisplay(cwd, name) {
  const displayName = String(name || "").trim();
  if (!displayName || displayName.length > 40 || /[\r\n]/.test(displayName)) {
    return { ok: false, message: "项目名称应为 1–40 个字。" };
  }
  const preferences = getProjectPreferences();
  const key = projectKey(cwd);
  const previous = preferences.names[key];
  if (displayName === path.basename(cwd)) delete preferences.names[key];
  else preferences.names[key] = displayName;
  try {
    saveProjectPreferences();
  } catch {
    if (previous === undefined) delete preferences.names[key];
    else preferences.names[key] = previous;
    return { ok: false, message: "无法保存项目名称。" };
  }
  for (const entry of tabs.values()) {
    if (entry.cwd && projectKey(entry.cwd) === key) {
      entry.project = displayName;
      if (entry.id === activeTabId) mainWindow.setTitle(`Pi Desktop - ${displayName} | Powered by Pi`);
    }
  }
  pushTabState();
  void refreshHomeProjects();
  return { ok: true };
}

function homeEntryForSender(sender) {
  return [...tabs.values()].find((t) => t.content && t.content.webContents === sender && t.url.startsWith("data:text/html"));
}

function openProjectInTab(entry, cwd) {
  if (entry.pendingContent) {
    if (mainWindow.contentView.children.includes(entry.pendingContent)) mainWindow.contentView.removeChildView(entry.pendingContent);
    entry.pendingContent.webContents.close();
  }
  const home = entry.content;
  const url = `${homeUrl()}/?cwd=${encodeURIComponent(cwd)}`;
  const pending = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "home-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: `tab-${entry.id}`,
    },
  });
  pending.setBackgroundColor("#1b1d22");
  entry.pendingContent = pending;
  if (entry.id === activeTabId) showTabView(entry);
  home.webContents.send("app:home-opening", cwd);
  let finished = false;
  const fail = () => {
    if (finished || entry.pendingContent !== pending) return;
    finished = true;
    entry.pendingContent = null;
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.children.includes(pending)) {
      mainWindow.contentView.removeChildView(pending);
    }
    pending.webContents.close();
    if (!home.webContents.isDestroyed()) home.webContents.send("app:home-open-failed", cwd);
  };
  pending.webContents.on("did-fail-load", (_e, code, _description, _url, mainFrame) => {
    if (code !== -3 && mainFrame) fail();
  });
  pending.webContents.once("did-finish-load", async () => {
    try {
      const ready = await pending.webContents.executeJavaScript(`new Promise((resolve) => {
        const cwd = ${JSON.stringify(cwd)}.toLowerCase();
        const check = () => [...document.querySelectorAll("button[title]")]
          .some((button) => button.title.toLowerCase() === cwd);
        if (check()) return resolve(true);
        const observer = new MutationObserver(() => {
          if (check()) { observer.disconnect(); resolve(true); }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title"] });
        setTimeout(() => { observer.disconnect(); resolve(false); }, 15000);
      })`);
      if (!ready) return fail();
      if (finished || entry.pendingContent !== pending || !tabs.has(entry.id)) return;
      finished = true;
      entry.pendingContent = null;
      entry.content = pending;
      entry.project = projectDisplayName(cwd);
      entry.cwd = cwd;
      entry.cwdBase = path.basename(cwd);
      entry.url = url;
      wireContentEvents(entry);
      entry.retiringContent = home;
      if (entry.id === activeTabId) {
        showTabView(entry);
        mainWindow.setTitle(`Pi Desktop - ${entry.project} | Powered by Pi`);
        void syncTabColor(entry, pending);
      }
      if (entry.retiringContent && !mainWindow.contentView.children.includes(home)) {
        home.webContents.close();
        entry.retiringContent = null;
      }
      pushTabState();
      recordOpenedProject(cwd);
    } catch {
      fail();
    }
  });
  pending.webContents.loadURL(url).catch(fail);
}

// 标签条按钮事件
ipcMain.on("app:new-tab", (e) => {
  if (stripView && e.sender === stripView.webContents) newTab();
});
ipcMain.on("app:toggle-overflow", (e, anchorRight) => {
  if (stripView && e.sender === stripView.webContents) toggleOverflow(anchorRight);
});
ipcMain.on("app:switch-tab", (e, id) => {
  if (stripView && e.sender === stripView.webContents) {
    hideOverflow();
    switchTab(id);
  }
});
ipcMain.on("app:close-tab", (e, id) => {
  if (stripView && e.sender === stripView.webContents) {
    hideOverflow();
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

// 首页项目选择
ipcMain.on("app:home-ready", async (e) => {
  const entry = homeEntryForSender(e.sender);
  if (!entry) return;
  const projects = await fetchProjects();
  if (!e.sender.isDestroyed() && homeEntryForSender(e.sender) === entry) {
    e.sender.send("app:home-projects", projects);
  }
});
ipcMain.on("app:home-open-project", (e, cwd) => {
  const entry = homeEntryForSender(e.sender);
  if (entry && typeof cwd === "string" && cwd) openProjectInTab(entry, cwd);
});
ipcMain.on("app:home-browse", async (e) => {
  const entry = homeEntryForSender(e.sender);
  if (!entry) return;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (!r.canceled && r.filePaths[0] && homeEntryForSender(e.sender) === entry) {
    openProjectInTab(entry, r.filePaths[0]);
  }
});
ipcMain.handle("app:home-rename-project", (e, cwd, name) => {
  if (!homeEntryForSender(e.sender) || typeof cwd !== "string" || !cwd) return { ok: false };
  return renameProjectDisplay(cwd, name);
});
ipcMain.handle("app:home-remove-project", (e, cwd) => {
  if (!homeEntryForSender(e.sender) || typeof cwd !== "string" || !cwd) return { ok: false };
  const preferences = getProjectPreferences();
  const key = projectKey(cwd);
  const previousOpened = preferences.opened;
  const previousHidden = preferences.hidden;
  preferences.opened = preferences.opened.filter((item) => item && typeof item.cwd === "string" && projectKey(item.cwd) !== key);
  preferences.hidden = [...preferences.hidden.filter((item) => item !== key), key];
  try {
    saveProjectPreferences();
  } catch {
    preferences.opened = previousOpened;
    preferences.hidden = previousHidden;
    return { ok: false };
  }
  void refreshHomeProjects();
  return { ok: true };
});
ipcMain.handle("app:tab-rename-project", (e, id, name) => {
  if (!stripView || e.sender !== stripView.webContents) return { ok: false };
  const entry = tabs.get(id);
  if (!entry || !entry.cwd) return { ok: false };
  return renameProjectDisplay(entry.cwd, name);
});
ipcMain.handle("app:home-move-project", async (e, sourceCwd, targetCwd, after) => {
  if (!homeEntryForSender(e.sender)) return { ok: false };
  const projects = await fetchProjects();
  const order = projects.map((project) => projectKey(project.cwd));
  const source = order.indexOf(projectKey(sourceCwd));
  const target = order.indexOf(projectKey(targetCwd));
  if (source < 0 || target < 0 || source === target) return { ok: false };
  const [moved] = order.splice(source, 1);
  order.splice(order.indexOf(projectKey(targetCwd)) + (after ? 1 : 0), 0, moved);
  const preferences = getProjectPreferences();
  const previous = preferences.order;
  preferences.order = order;
  try {
    saveProjectPreferences();
  } catch {
    preferences.order = previous;
    return { ok: false };
  }
  void refreshHomeProjects();
  return { ok: true };
});
// 溢出面板事件
ipcMain.on("app:overflow-switch", (e, id) => {
  if (!overflowWin || overflowWin.isDestroyed() || e.sender !== overflowWin.webContents) return;
  hideOverflow();
  switchTab(id);
});
ipcMain.on("app:overflow-close", (e) => {
  if (overflowWin && !overflowWin.isDestroyed() && e.sender === overflowWin.webContents) hideOverflow();
});
ipcMain.on("app:overflow-rendered", (e) => {
  if (!overflowOpen || !overflowWin || overflowWin.isDestroyed() || e.sender !== overflowWin.webContents) return;
  if (!overflowWin.isVisible()) {
    overflowWin.show();
    overflowWin.focus();
  }
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
        if (!entry.url.startsWith("http://")) continue;
        const next = new URL(entry.url);
        next.port = String(serverPort);
        entry.url = next.href;
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
// 运行中(该标签项目下有会话在跑) -> 蓝色旋转圈; 后台标签项目有新动态 -> 黄点; 其余 -> 灰点
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
        // 后台标签的项目下有会话内容更新 -> 未读黄点
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
      sendHomeProjects(projectsFromSessions(data));
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

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

const { app, BrowserWindow, Tray, Menu, dialog, shell } = require("electron");
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

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;
let quitting = false;
let quitUpdateDone = false;
let reusedExternal = false; // 当前复用的是外部 pi-web 服务(可能随时退出)
let watchdog = null;

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
      if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: "Pi Desktop",
    icon: appIcon(),
    autoHideMenuBar: true,
    backgroundColor: "#0b1220",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://${APP_URL_HOST}:${serverPort}`);

  // 服务未就绪/被重启时自动重试加载, 不留白板错误页
  mainWindow.webContents.on("did-fail-load", () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://${APP_URL_HOST}:${serverPort}`);
      }
    }, 3000);
  });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://${APP_URL_HOST}:${serverPort}`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 关窗 -> 托盘驻留, 服务不断
  mainWindow.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("page-title-updated", (e, title) => {
    e.preventDefault();
    const base = title.replace(/\s*-\s*Pi Web\s*$/i, "").trim();
    mainWindow.setTitle(
      base ? `Pi Desktop - ${base} | Powered by Pi` : "Pi Desktop | Powered by Pi"
    );
  });
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip("Pi Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Pi Desktop",
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) createWindow();
          else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      {
        label: "在浏览器中打开",
        click: () => shell.openExternal(`http://${APP_URL_HOST}:${serverPort}`),
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://${APP_URL_HOST}:${serverPort}`);
      }
    } catch (err) {
      appendLog(logFile(), `看门狗重启服务失败: ${err && err.message}\n`);
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
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

    createWindow();
    createTray();
    setupShellAutoUpdate();
    startWatchdog();
    console.log(`[pi-desktop] 服务就绪: http://${APP_URL_HOST}:${serverPort}`);

    // 3. 窗口出来后后台顺带更新全局的 pi / pi-web (cmd 用的), 失败就下次
    setTimeout(() => backgroundGlobalToolsUpdate(), 8000);
  });

  app.on("before-quit", (e) => {
    quitting = true;
    if (watchdog) clearInterval(watchdog);
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
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

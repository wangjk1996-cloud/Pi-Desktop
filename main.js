// Pi Web 桌面客户端 —— Electron 主进程
// 职责:
//   1. 内核自更新: 后台静默把 pi / pi-web 更新到官方最新版(npm 镜像源)
//   2. 拉起 pi-web 服务(用 Electron 内置 Node 运行时, 不依赖本机 Node)
//   3. 桌面体验: 独立窗口 / 托盘驻留 / 单实例 / 外部链接走系统浏览器
//   4. 壳自更新: electron-updater 从 GitHub Releases 检查下载
"use strict";

const { app, BrowserWindow, Tray, Menu, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const DEFAULT_PORT = 30141;
const APP_URL_HOST = "127.0.0.1";
const NPM_REGISTRY = "https://registry.npmmirror.com";
const PI_WEB_PKG = "@agegr/pi-web";
const PI_AGENT_PKG = "@earendil-works/pi-coding-agent";
const KERNEL_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 内核更新检查最小间隔

// ---------------------------------------------------------------------------
// 路径与状态
// ---------------------------------------------------------------------------
// 内核优先用本机全局 npm 目录(与 cmd 里的 pi/pi-web 共享同一份, 更新一处处处新);
// 全局不存在时用应用私有目录兜底(应对本机没有/坏了 Node 环境的情况)
function globalPrefix() {
  return path.join(process.env.APPDATA || "", "npm");
}
function privatePrefix() {
  return path.join(app.getPath("userData"), "packages");
}
function kernelBin(prefix) {
  return path.join(prefix, "node_modules", "@agegr", "pi-web", "bin", "pi-web.js");
}
function npmCliJs() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "npm", "bin", "npm-cli.js")
    : path.join(__dirname, "vendor", "npm", "bin", "npm-cli.js");
}
function logFile() {
  return path.join(app.getPath("userData"), "pi-web-server.log");
}
function updateLogFile() {
  return path.join(app.getPath("userData"), "kernel-update.log");
}
function stateFile() {
  return path.join(app.getPath("userData"), "update-state.json");
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = DEFAULT_PORT;
let quitting = false;

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text);
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
// 内核: 定位 / 首次安装 / 后台自更新
// ---------------------------------------------------------------------------
function findKernel() {
  const globalBin = kernelBin(globalPrefix());
  if (fs.existsSync(globalBin)) return { bin: globalBin, prefix: globalPrefix(), global: true };
  const privateBin = kernelBin(privatePrefix());
  if (fs.existsSync(privateBin)) return { bin: privateBin, prefix: privatePrefix(), global: false };
  return null;
}

function npmInstall(prefix, packages, useGlobalFlag) {
  return new Promise((resolve) => {
    const args = [npmCliJs(), "install"];
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

// 后台静默更新内核(pi + pi-web), 不影响当前运行, 下次启动生效
async function backgroundKernelUpdate(kernel) {
  try {
    // 节流: 距上次检查不足间隔则跳过
    let last = 0;
    try {
      last = JSON.parse(fs.readFileSync(stateFile(), "utf8")).lastKernelUpdate || 0;
    } catch {
      /* ignore */
    }
    if (Date.now() - last < KERNEL_UPDATE_INTERVAL_MS) return;
    fs.writeFileSync(stateFile(), JSON.stringify({ lastKernelUpdate: Date.now() }));

    // 内核所在处(全局或私有)更新 pi-web + pi
    await npmInstall(
      kernel.prefix,
      [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`],
      kernel.global
    );
    // 若内核在私有目录, 但全局也装着 pi/pi-web(cmd 在用), 顺带把全局也更新到最新
    if (!kernel.global) {
      const g = globalPrefix();
      const hasGlobalPiWeb = fs.existsSync(kernelBin(g));
      const hasGlobalPi = fs.existsSync(
        path.join(g, "node_modules", "@earendil-works", "pi-coding-agent")
      );
      if (hasGlobalPiWeb || hasGlobalPi) {
        await npmInstall(g, [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`], true);
      }
    }
  } catch (err) {
    appendLog(updateLogFile(), `后台更新异常: ${err && err.message}\n`);
  }
}

// 首次运行: 没有任何内核 -> 先显示进度窗口, 下载内核到私有目录
async function firstRunInstall() {
  const win = new BrowserWindow({
    width: 460,
    height: 260,
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    title: "Pi Web — 首次运行",
    backgroundColor: "#0b1220",
  });
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<body style="margin:0;background:#0b1220;color:#dbe4f0;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh">
          <h2 style="margin:0 0 12px">Pi Web 首次运行</h2>
          <p style="margin:0;color:#8fa3bf">正在下载必需组件, 请保持联网…</p>
          <p style="color:#5b6b84;font-size:12px">仅此一次, 之后启动无需等待</p>
        </body>`
      )
    );
  const ok = await npmInstall(
    privatePrefix(),
    [`${PI_WEB_PKG}@latest`, `${PI_AGENT_PKG}@latest`],
    false
  );
  try {
    win.destroy();
  } catch {
    /* ignore */
  }
  if (!ok || !fs.existsSync(kernelBin(privatePrefix()))) {
    throw new Error(
      "首次运行组件下载失败, 请检查网络后重试。\n日志: " + updateLogFile()
    );
  }
  return { bin: kernelBin(privatePrefix()), prefix: privatePrefix(), global: false };
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------
function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
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
}

function startServer(bin, cwd, port) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(bin)) {
      reject(new Error(`未找到 pi-web 服务入口: ${bin}`));
      return;
    }
    appendLog(logFile(), `\n===== ${new Date().toISOString()} 启动服务 (port=${port}) =====\n`);

    // ELECTRON_RUN_AS_NODE=1: 用 Electron 内置的 Node 运行时跑 pi-web,
    // 不依赖本机安装的 Node.js
    serverProcess = spawn(
      process.execPath,
      [bin, "--no-open", "-p", String(port)],
      {
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    serverProcess.stdout.on("data", (d) => appendLog(logFile(), d.toString()));
    serverProcess.stderr.on("data", (d) => appendLog(logFile(), d.toString()));
    serverProcess.on("error", (err) => reject(new Error(`服务进程启动失败: ${err.message}`)));
    serverProcess.on("exit", (code, signal) => {
      appendLog(logFile(), `===== ${new Date().toISOString()} 服务退出 code=${code} signal=${signal} =====\n`);
      serverProcess = null;
      if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          "Pi Web 服务异常退出",
          `pi-web 服务进程已退出 (code=${code})。\n日志: ${logFile()}`
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
  const p = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "build", "icon.ico");
  return p;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    title: "Pi Web",
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
    mainWindow.setTitle(`Pi Web — ${title}`);
  });
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip("Pi Web");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开 Pi Web",
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
        title: "Pi Web 更新",
        message: `新版本 ${info.version} 已下载完成`,
        detail: "重启应用即可生效。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) {
        quitting = true;
        stopServer();
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
    app.setAppUserModelId("com.github.wangjk1996-cloud.piweb");
    try {
      // 1. 定位内核; 首次运行则先下载
      let kernel = findKernel();
      if (!kernel) kernel = await firstRunInstall();

      // 2. 端口策略: 默认端口空闲则启动服务; 已有 pi-web 在跑则直接复用; 否则换空闲端口
      if (await isPortFree(DEFAULT_PORT)) {
        serverPort = DEFAULT_PORT;
        await startServer(kernel.bin, path.dirname(path.dirname(path.dirname(path.dirname(kernel.bin)))), serverPort);
      } else if (await portResponds(DEFAULT_PORT)) {
        serverPort = DEFAULT_PORT;
      } else {
        serverPort = await getFreePort();
        await startServer(kernel.bin, path.dirname(path.dirname(path.dirname(path.dirname(kernel.bin)))), serverPort);
      }
    } catch (err) {
      dialog.showErrorBox("Pi Web 启动失败", String((err && err.message) || err));
      app.exit(1);
      return;
    }

    createWindow();
    createTray();
    setupShellAutoUpdate();
    console.log(`[pi-web-app] 服务就绪: http://${APP_URL_HOST}:${serverPort}`);

    // 3. 窗口出来后再后台静默更新内核, 不拖慢启动
    const kernel = findKernel();
    if (kernel) setTimeout(() => backgroundKernelUpdate(kernel), 5000);
  });

  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });

  app.on("window-all-closed", () => {
    // 托盘驻留模式: 不自动退出
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

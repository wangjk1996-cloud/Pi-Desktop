const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(repo, "main.js"), "utf8");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-component-test-"));
const web = "@agegr/pi-web";
const pi = "@earendil-works/pi-coding-agent";
let privateDir, globalDir, calls, windows, blocked, latest;
const context = vm.createContext({
  fs, path, spawn, console, Date, AbortSignal,
  PI_WEB_PKG: web, PI_AGENT_PKG: pi, NPM_REGISTRY: "https://registry.npmmirror.com",
  GLOBAL_TOOLS_UPDATE_INTERVAL_MS: 4 * 60 * 60 * 1000,
  privatePrefix: () => privateDir, globalPrefix: () => globalDir,
  globalHas: pkg => fs.existsSync(path.join(globalDir, "node_modules", ...pkg.split("/"), "package.json")),
  kernelBin: () => path.join(privateDir, "node_modules", "@agegr", "pi-web", "bin", "pi-web.js"),
  stateFile: () => path.join(root, "state.json"),
  appIcon: () => path.join(repo, "build", "icon.ico"),
  updateLogFile: () => path.join(root, "update.log"), logFile: () => path.join(root, "server.log"),
  appendLog: (file, text) => fs.appendFileSync(file, text),
  runPrepareTerminal: async () => {},
  BrowserWindow: class {
    constructor(options) { this.options = options; windows.push(this); this.webContents = { executeJavaScript: async () => {} }; }
    async loadURL(url) { this.html = decodeURIComponent(url.slice(url.indexOf(",") + 1)); }
    destroy() { this.destroyed = true; }
  },
  npmInstall: async (prefix, packages, global) => {
    calls.push({ prefix, packages: [...packages], global });
    if (packages.some(item => blocked.has(item))) return false;
    for (const item of packages) {
      const split = item.lastIndexOf("@");
      writePackage(prefix, item.slice(0, split), item.slice(split + 1));
    }
    const bin = context.kernelBin();
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "");
    return true;
  },
});
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert(start >= 0 && end > start, from);
  return source.slice(start, end);
}
vm.runInContext(section("async function npmLatestVersion(pkg)", "// pi-web 的 postinstall"), context);
const fetchLatest = context.npmLatestVersion;
vm.runInContext(section("function componentVersion(", "// ---------------------------------------------------------------------------\n// 服务生命周期"), context);
vm.runInContext(section("function stopServer()", "function startServer(port)"), context);

function writePackage(prefix, pkg, version) {
  const dir = path.join(prefix, "node_modules", ...pkg.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
}
function reset(name, versions) {
  privateDir = path.join(root, name, "private");
  globalDir = path.join(root, name, "global");
  fs.mkdirSync(privateDir, { recursive: true });
  calls = []; windows = []; blocked = new Set();
  latest = { [web]: "0.10.0", [pi]: "1.0.2" };
  context.npmLatestVersion = async pkg => latest[pkg];
  if (versions) {
    writePackage(privateDir, web, versions[0]);
    writePackage(privateDir, pi, versions[1]);
    fs.mkdirSync(path.dirname(context.kernelBin()), { recursive: true });
    fs.writeFileSync(context.kernelBin(), "");
  }
}
function savePreview(mode) {
  const dir = path.join(repo, "dist", "component-preview");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, mode + ".html"), windows[0].html);
}
async function main() {
  reset("install");
  await context.prepareKernel();
  assert.deepEqual(calls[0].packages, [web + "@0.10.0", pi + "@1.0.2"]);
  assert(windows[0].html.includes("首次安装"));
  assert(windows[0].html.includes("安装完成后将自动启动。"));
  savePreview("install");

  reset("pi-only", ["0.10.0", "1.0.1"]);
  await context.prepareKernel();
  assert.deepEqual(calls[0].packages, [pi + "@1.0.2"]);
  assert(windows[0].html.includes("组件更新"));
  assert(windows[0].html.includes("1.0.1 → 1.0.2"));
  assert(!windows[0].html.includes("首次安装"));

  reset("web-only", ["0.9.3", "1.0.2"]);
  await context.prepareKernel();
  assert.deepEqual(calls[0].packages, [web + "@0.10.0"]);
  assert(windows[0].html.includes("0.9.3 → 0.10.0"));
  savePreview("update");
  console.log("PASS: first install and independent Pi/Pi Web updates with distinct UI");

  reset("repair", ["0.10.0", "1.0.2"]);
  fs.unlinkSync(context.kernelBin());
  await context.prepareKernel();
  assert(windows[0].html.includes("组件修复"));
  savePreview("repair");

  reset("current", ["0.10.0", "1.0.2"]);
  await context.prepareKernel();
  assert.equal(calls.length, 0);
  assert.equal(windows.length, 0);
  latest = { [web]: null, [pi]: null };
  await context.prepareKernel();
  assert.equal(calls.length, 0);
  assert.equal(windows.length, 0);

  reset("failed", ["0.9.3", "1.0.2"]);
  blocked.add(web + "@0.10.0");
  await assert.rejects(context.prepareKernel(), /组件更新未完成/);
  assert.equal(windows[0].destroyed, true);
  console.log("PASS: repair, no unnecessary installs, offline launch and clear failure");

  reset("global");
  writePackage(globalDir, web, "0.9.3");
  writePackage(globalDir, pi, "1.0.1");
  blocked.add(web + "@0.10.0");
  await context.backgroundGlobalToolsUpdate();
  assert.equal(calls.length, 2);
  assert.equal(context.componentVersion(globalDir, pi), "1.0.2");
  assert(!fs.existsSync(context.stateFile()));
  console.log("PASS: locked global Pi Web does not block Pi or record false success");

  context.fetch = async () => ({ ok: true, json: async () => ({ version: "1.0.2" }) });
  assert.equal(await fetchLatest(pi), "1.0.2");
  context.fetch = async () => { throw new Error("offline"); };
  assert.equal(await fetchLatest(pi), null);

  // Only these two test-owned processes are stopped; no user services are touched.
  const script = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);";
  const parent = spawn(process.execPath, ["-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  context.serverProcess = parent;
  const pid = await new Promise((resolve, reject) => {
    parent.stdout.once("data", data => resolve(Number(data.toString().trim())));
    parent.once("error", reject);
  });
  await context.stopServer();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  console.log("PASS: shutdown stops the actual parent and child process tree");
}
main().then(() => {
  assert(path.resolve(root).startsWith(path.join(os.tmpdir(), "pi-desktop-component-test-")));
  fs.rmSync(root, { recursive: true, force: true });
}).catch(error => { console.error(error); console.error("Test files retained: " + root); process.exitCode = 1; });

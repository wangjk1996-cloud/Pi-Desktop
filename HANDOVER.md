# Pi Desktop — 项目交接文档（给接手的 AI）

## 0. 一句话

Pi Desktop 是 pi coding agent 的 Windows 桌面客户端：Electron 壳 + 内嵌 pi-web 内核（本地网页 UI），浏览器式标签页（一标签一项目），三层自动更新，托盘驻留。

- 仓库：https://github.com/wangjk1996-cloud/Pi-Desktop
- 本地路径：`C:\Users\Leo\Documents\GitHub\Pi-Desktop`
- 当前版本：v1.6.2
- 环境：Windows 11、Git Bash、Node 24、Electron 39、electron-builder 26

## 1. 架构（读代码前先看这个）

### 进程模型
- `main.js`：Electron 主进程，负责一切（内核管理、服务拉起、窗口、标签、托盘、更新）。
- pi-web 服务：以子进程运行，用 **Electron 内置 Node 运行时**（`ELECTRON_RUN_AS_NODE=1`，`spawn(process.execPath, [pi-web.js, "--no-open", "-p", port])`），**不依赖用户本机 Node**。仅监听 127.0.0.1。
- 端口策略：30141 空闲则起内置服务；被外部 pi-web 占用则复用（此时 watchdog 每 5s 盯防，外部死了自动起内置服务接管）。

### 内核与 npm 运行时（都在用户数据目录，不在安装目录）
- 用户数据目录：`%APPDATA%\pi-desktop-app\`
- `kernel/`：私有 npm prefix，装 `@agegr/pi-web` + `@earendil-works/pi-coding-agent`，首次启动下载（有进度窗口）。
- `npm-runtime/`：内置 npm（打包时以 `vendor/npm-runtime.tar.gz` 携带，首次需要时用 `C:\Windows\System32\tar.exe` 解压）。**必须用系统 tar 的绝对路径**（见坑 #2）。
- 日志：`pi-desktop-server.log`（服务）、`update.log`（更新），超 5MB 自动截断。

### 窗口/标签
- 单主窗口：`titleBarStyle:"hidden"` + `titleBarOverlay`（原生最小化/最大化/关闭按钮保留）。
- 窗口内多个 `WebContentsView`：顶部标签条（strip，40px，可拖动，有「+」）+ 每个标签一个内容视图 + 项目选择面板（独立无边框子窗口）。
- `strip-preload.js`：标签条的渲染/交互（增量渲染、拖放排序、滚轮横滑）。
- `chooser-preload.js`：项目选择面板。
- 每个标签独立内存存储分区（`partition: "tab-N"`）→ 不触发 pi-web 的"恢复上次页面"行为，新标签停在首页。
- 后台标签保持存活但从窗口卸下（`removeChildView`），不切回零绘制开销。
- pi-web 官方 URL 参数：`/?cwd=<路径>` 直达项目工作区（跳过项目选择）；`/?session=<id>` 直达会话。

## 2. 三层自动更新

| 层 | 对象 | 机制 |
|---|---|---|
| 内核 | 私有 kernel 的 pi/pi-web | 退出应用时（服务停止后）npm view 比对版本，静默更新，下次启动生效 |
| 全局工具 | 用户全局 npm 的 pi/pi-web（命令行用） | 启动 8s 后后台 `npm install -g ...@latest`（npmmirror 源）；仅当全局已安装；成功才记录节流时间（4h） |
| 壳 | 应用本身 | electron-updater → GitHub Releases（repo: `wangjk1996-cloud/Pi-Desktop`），下载完弹窗"立即重新启动/稍后" |

## 3. 构建 / 测试 / 发布（照抄即可）

```bash
cd /c/Users/Leo/Documents/GitHub/Pi-Desktop
npm install                      # 装依赖（Electron 若没下载二进制，先 npm install-scripts approve electron && npm rebuild electron）
node -e "new Function(require('fs').readFileSync('main.js','utf8'))"   # 语法快检
npm run dist                     # 打包 → dist/PiDesktop-<版本>-setup.exe
cmd //c "dist\PiDesktop-<版本>-setup.exe /S"   # 静默安装（必须走 cmd，见坑 #5）
cmd //c start "" "C:\Users\Leo\AppData\Local\Programs\Pi Desktop\Pi Desktop.exe"
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:30141   # 验证 200
```

发布（先打 tag 再发布，否则 GitHub 422）：
```bash
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2-) \
  npx electron-builder --win --publish always
```

图标生成：`build/logo.svg` → Edge headless 截图 1024px（`--headless=new --default-background-color=00000000 --screenshot=...`）→ `scripts/downscale-icon.ps1` 降采样 → `scripts/pngs-to-ico.js` 打包成 `build/icon.ico`。

## 4. 踩过的坑（每条都是血泪，别再犯）

1. **electron-builder 的 extraResources 会过滤裸目录里的 node_modules** → 内置 npm 必须打 tar.gz 携带，运行时解压。
2. **Git Bash 的 GNU tar 把 `C:\...` 当远程主机**（"Cannot connect to C:"）→ 永远用 `C:\Windows\System32\tar.exe` 绝对路径。
3. **运行中的服务锁目录（EBUSY）** → 更新内核只能在服务停止后（所以放在退出时做）。
4. **Windows 图标缓存** → 换图标后桌面图标不变，需 `ie4uinit.exe -show` 或清 iconcache 重启 explorer。
5. **NSIS 静默安装**要用 `cmd //c "xxx.exe /S"`；直接 `./xxx.exe /S` 在 Git Bash 里会莫名失败。
6. **PowerShell 脚本文件不能含中文注释**（无 BOM 的 UTF-8 会被按 GBK 解析，注释乱码吞掉下一行）。
7. PowerShell 里 `$size * 0.5` 不能直接当构造函数参数，先赋值变量。
8. **npm 11 的 allow-scripts 机制会拦 postinstall** → 装完 pi-web 要手动补跑 `bin/prepare-terminal.js`。
9. **electron-builder 发布会产生重复 Release**（一个只有 blockmap）→ 用 GitHub API 合并清理（先把缺的资产搬到资产全的那条，再 DELETE 多余的）。
10. 同名 Release 发布超 2 小时后不允许覆盖资产 → 升版本号重发。
11. curl 向 GitHub API POST 中文 body 会 400 → 描述用英文。
12. 仓库改名后旧 URL 301 重定向有效，electron-updater 不受影响。
13. **PowerShell 命令经 bash 传参会丢 `$` 变量** → 写成 .ps1 文件再执行。
14. cmd 的 `/min` 之类开关在 Git Bash 里会被转成路径 → 写成 `//min`。

## 5. 甲方的硬性要求（UX 红线，别回归）

- 文案：正式商业软件书面语，禁止口语。
- 窗口标题格式：`Pi Desktop - 项目名 | Powered by Pi`（短横线 + 竖线，不要别的符号）。
- 图标：黑底圆角方块 + Times New Roman Bold 白色 π，字形占 3/4、留白 1/4（源文件 `build/logo.svg`）。
- 不要有默认菜单（Alt/Ctrl 唤出隐藏菜单算 bug，已 `Menu.setApplicationMenu(null)`）。
- 新标签必须停在首页/项目选择，**绝不自动跳进上次项目**（靠独立 partition 实现，别删）。
- 标签条交互对齐 Chrome：+ 跟在最后标签后、新标签插在当前右侧、等宽收窄、溢出滚轮、可拖拽排序、增量渲染不闪跳。
- 讨厌：页面闪跳、白屏、跳来跳去、大小写不规范。
- 用户是非英文母语中文用户，沟通用中文。

## 6. 注意事项

- **别碰 `%APPDATA%\pi-desktop`**——那是另一个应用的目录（撞过名，已避让为 `pi-desktop-app`）。
- 用户机器上还有命令行版 pi/pi-web 在用，数据共享 `~/.pi/agent`，别动。
- 测试必须实测：打包→安装→启动→curl 200，不许只看编译通过。
- 发布前确认 Releases 里没有重复 release（坑 #9）。

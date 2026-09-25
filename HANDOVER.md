# Pi Desktop — 项目交接文档（给接手的 AI）

## 0. 一句话

Pi Desktop 是 pi coding agent 的 Windows 桌面客户端，提供多项目标签页、托盘驻留和自动更新。技术架构为 Electron 壳 + 内嵌 pi-web 内核（本地网页 UI）。

- 仓库：https://github.com/wangjk1996-cloud/Pi-Desktop
- 本地路径：`C:\Users\Leo\Documents\GitHub\Pi-Desktop`
- 当前版本：v1.7.1
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
- 窗口内多个 `WebContentsView`：顶部标签条（strip，40px，可拖动，有「+」）+ 每个标签一个内容视图；溢出标签列表使用独立无边框子窗口。
- `strip-preload.js`：标签条的渲染/交互（增量渲染、拖放排序、固定宽度横向滚动、溢出导航）。
- `home-preload.js`：壳内置首页的最近项目列表与目录选择；`overflow-preload.js`：溢出标签列表。
- 每个标签独立内存存储分区（`partition: "tab-N"`）。新标签先打开壳内置首页；直接加载 pi-web 根地址仍会自动恢复最近项目，不能以分区隔离代替首页。
- 「+」直接新建首页标签；首页中选择最近项目或目录后，在当前标签通过 `?cwd=` 直达项目。标签固定宽度 148px，超出时可用左右按钮、滚轮或固定宽度 224px 的自绘「全部标签页」列表切换。
- 首页采用居中的内容列：Logo 与品牌名、按本地时间变化的问候、主要「打开项目目录」按钮、最近项目列表。品牌名采用与图标中的 π 一致的 Times New Roman Bold 字形；Logo 不加白色描边。首页问候分为九个时段，每段三句，按日期轮换；跨时段自动更新。首页本身固定在窗口可视区内，最近项目列表占用剩余空间并在内部滚动；不能让整个页面右侧出现滚动条。品牌和问候位置固定。新首页视图加载完成后再显示，避免新建标签时出现白屏。溢出标签菜单可滚动，但不显示突兀的滚动条；收到状态更新时保留列表位置，内容渲染完成后才显示菜单。
- 首页项目可拖动排序并修改显示名称；已打开的标签同步使用显示名称，双击标签名也可改名。所有已打开的首页会同步更新项目列表、顺序和名称；无会话的新项目也会显示。设置及打开过的目录保存在 `%APPDATA%\pi-desktop-app\project-preferences.json`，不移动文件夹、不修改 pi-web 会话数据。
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
npm run dist                     # 打包 → dist/PiDesktop-<版本>-setup.exe（已配置 normal 压缩）
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
15. 机器可用虚拟内存不足时，NSIS 默认最高压缩会报 `7za.exe ... Can't allocate required memory` → `package.json` 已设置 `compression: normal`；仍不足时先关闭自己的 Pi Desktop 测试进程，不要结束用户的其他应用。

## 5. 甲方的硬性要求（UX 红线，别回归）

- 文案：正式商业软件书面语，禁止口语。
- 首页问候语与操作说明各司其职，不要重复说「选择项目」。
- 窗口标题格式：`Pi Desktop - 项目名 | Powered by Pi`（短横线 + 竖线，不要别的符号）。
- 图标：黑底圆角方块 + Times New Roman Bold 白色 π，字形占 3/4、留白 1/4（源文件 `build/logo.svg`）。
- 不要有默认菜单（Alt/Ctrl 唤出隐藏菜单算 bug，已 `Menu.setApplicationMenu(null)`）。
- 新标签必须停在壳内置首页/项目选择，**绝不自动跳进上次项目**。pi-web 根地址会自动恢复最近项目；不要把它当作空白标签的首页。独立 partition 仍须保留。
- 标签条交互：+ 跟在可见标签后并直接新建首页标签，新标签始终追加到列表末尾；首页内选择项目后在原标签进入项目；标签保持固定宽度，溢出时用左右按钮、滚轮和与首页风格一致的自绘「全部标签页」列表；可拖拽排序，增量渲染不闪跳。关闭当前标签后切到相邻标签。
- 讨厌：页面闪跳、白屏、跳来跳去、大小写不规范。
- 用户是非英文母语中文用户，沟通用中文。

## 6. 注意事项

- **别碰 `%APPDATA%\pi-desktop`**——那是另一个应用的目录（撞过名，已避让为 `pi-desktop-app`）。
- 用户机器上还有命令行版 pi/pi-web 在用，数据共享 `~/.pi/agent`，别动。
- 测试必须实测：打包→安装→启动→curl 200，不许只看编译通过。
- 发布前确认 Releases 里没有重复 release（坑 #9）。

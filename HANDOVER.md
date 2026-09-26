# Pi Desktop — 项目交接文档（给接手的 AI）

## 0. 一句话

Pi Desktop 是 pi coding agent 的 Windows 桌面客户端，提供多项目标签页、托盘驻留和自动更新。技术架构为 Electron 壳 + 内嵌 pi-web 内核（本地网页 UI）。

- 仓库：https://github.com/wangjk1996-cloud/Pi-Desktop
- 本地路径：`C:\Users\Leo\Documents\GitHub\Pi-Desktop`
- 当前版本：v1.7.7
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
- 主窗口显示后会在后台预先加载一个独立分区的首页视图；点击「+」时直接接入该视图，再准备下一个。项目列表使用最近一次数据先显示，后台刷新与状态轮询共用进行中的 `/api/sessions` 请求，只在列表变化时通知首页。托盘菜单仅在标签数量、顺序或名称变化时重建。
- 标签状态图标固定占 14px：运行中使用与 pi-web 相同的 13px 蓝色旋转弧线，完成未读为黄点，已读为灰点；状态变化不得移动标题。溢出标签列表保持同一状态语义和图标样式，尊重系统“减少动态效果”。
- 首页采用居中的内容列：Logo 与品牌名、按本地时间变化的问候、主要「打开项目目录」按钮、最近项目列表。品牌名采用与图标中的 π 一致的 Times New Roman Bold 字形；Logo 不加白色描边。首页问候分为九个时段，每段三句，按日期轮换；跨时段自动更新。首页本身固定在窗口可视区内，最近项目列表占用剩余空间并在内部滚动；不能让整个页面右侧出现滚动条。品牌和问候位置固定。主窗口等首页与标签栏就绪后才显示；切换到尚未就绪的新首页时保留旧视图。首页进入 pi-web 时另建同分区内容视图，等工作区项目路径出现在页面后再替换首页；加载失败时保留首页并允许重试。壳界面只使用短促的颜色反馈和拖动排序位移，避免整页过渡和按钮弹跳，并遵从系统“减少动态效果”设置。溢出标签菜单可滚动，但不显示突兀的滚动条；收到状态更新时保留列表位置，内容渲染完成后才显示菜单。
- 首页项目可拖动排序、修改显示名称、从最近项目移除；改名和移除在项目卡片内显示明确的保存/移除与取消按钮，失焦不自动保存。移除不删除目录或会话，再次打开目录会恢复列表条目。已打开的标签同步使用显示名称，双击标签名也可改名。所有已打开的首页会同步更新项目列表、顺序和名称；无会话的新项目也会显示。设置及打开过的目录保存在 `%APPDATA%\pi-desktop-app\project-preferences.json`，不移动文件夹、不修改 pi-web 会话数据。
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

发布（先打 tag，再通过 GitHub Releases 页面或 API 创建**一条** Release）：
```bash
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
```

Release 标题、正文和资产规则见第 7 节。上传 `PiDesktop-X.Y.Z-setup.exe`、同名 `.blockmap`、`latest.yml` 三个文件；发布后确认同一 tag 只有一条 Release、三个资产齐全且 `latest.yml` 可访问。**不要执行 `npm run release` 或 `electron-builder --publish always`**：旧发布流程曾生成重复 Release。

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
9. **electron-builder 自动发布曾产生重复 Release**（一个只有 blockmap）→ v1.5.1、v1.6.1 的缺失资产已合并，重复记录已清理；后续按第 7 节创建单条 Release。
10. 同名 Release 发布超 2 小时后不允许覆盖资产 → 升版本号重发。
11. Windows shell 用 curl 向 GitHub API 发送中文正文曾遇到编码 400 → 使用明确的 UTF-8 请求体；发布说明保持中文。
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

## 7. 发行记录与提交规范

- `CHANGELOG.md` 是各版本更新内容的文本来源。发布前根据已合入代码写 1–3 条简短、可验证的中文要点；不要复制项目简介或填写未经验证的改动。README、交接文档的当前版本、`package.json` 和 GitHub Release 应一致。
- tag 固定为 `vX.Y.Z`；Release 标题固定为 `Pi Desktop vX.Y.Z`。正文固定使用以下结构，更新要点与 `CHANGELOG.md` 对应：

  ```markdown
  ## 更新内容

  - 具体改动一。
  - 具体改动二。

  ## 下载

  下载本页的 `PiDesktop-X.Y.Z-setup.exe` 安装。
  ```

- 新版本每个 tag 只创建一条 Release，保留安装包、`.blockmap`、`latest.yml` 三个资产。旧版本若原本缺少资产，保留实际文件，不补造安装文件或更新元数据。
- 提交标题统一用 `feat: 中文简述`、`fix: 中文简述`、`perf: 中文简述`、`docs: 中文简述` 或 `chore: 中文简述`。标题写具体改动，不再混用版本号前缀、英文长句与中文说明；版本由 tag 和 Release 标识。
- 已发布提交关联 tag、Release 和安装包。常规整理只规范后续提交，不改写旧提交信息或强推历史，以免原有提交链接和版本指向失效。
- 2026-09-26 曾一次性统一 36 条历史提交标题，并将 28 个 tag 移到文件内容相同的新提交；Release 标题、正文和资产未变。旧 SHA 不再被主分支或 tag 引用。改写前的 Git bundle 和旧新 SHA 对照表保存在本机仓库旁的 `Pi-Desktop-history-20260926/`；已有克隆需重新同步主分支与标签。

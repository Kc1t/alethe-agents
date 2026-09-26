<a id="readme-top"></a>

<br />
<div align="center">
  <a href="https://github.com/Kc1t/alethe-agents">
    <img src="./src/assets/theme-icons/elite-indigo.png" alt="Alethe Logo" width="160">
  </a>

  <h1 align="center">Alethe</h1>

  <p align="center">
    <b>多智能体编程工作区。</b>
    <br />
    在同一款本地优先的桌面应用里，并排运行 Claude Code、Codex、Copilot 以及你的 Shell。
    <br />
    <a href="./README.md">English</a>
  </p>

  <p align="center">
    <a href="https://github.com/Kc1t/alethe-agents/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Kc1t/alethe-agents/ci.yml?branch=main&label=ci&style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/graphs/contributors"><img alt="Contributors" src="https://img.shields.io/github/contributors/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/Kc1t/alethe-agents?style=flat-square"></a>
    <a href="https://github.com/Kc1t/alethe-agents/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/Kc1t/alethe-agents?style=flat-square"></a>
  </p>

  <p align="center">
    <a href="https://github.com/Kc1t/alethe-agents/releases">下载</a>
    ·
    <a href="https://github.com/Kc1t/alethe-agents/issues/new?labels=bug">报告问题</a>
    ·
    <a href="https://github.com/Kc1t/alethe-agents/issues/new?labels=enhancement">功能建议</a>
    ·
    <a href="./SECURITY.md">安全</a>
    ·
    <a href="./docs/PRIVACY.md">隐私</a>
    ·
    <a href="#contributing">参与贡献</a>
  </p>
</div>

> [!IMPORTANT]
> Alethe 目前仍是早期公开发布版本。桌面应用免费、开源，并且是**本地优先**（local-first），但并非完全离线：默认会进行更新检查与提供商用量轮询；其他网络功能多为可选，或由用户操作触发。手动的 GitHub Gist Sync 已经可用；官方托管同步或云备份可能会在之后单独提供。详见
> [隐私与数据流说明](./docs/PRIVACY.md)。

<div align="center">
  <img src="./docs/assets/alethe-preview.gif" alt="Alethe 多智能体编程工作区预览" width="760">
</div>

> 本文为社区中文说明，内容对应英文 [README.md](./README.md)。若中英文不一致，以英文版为准。

## Alethe 是什么

单个终端里跑一个智能体很容易。真正难的是：三个仓库、五个智能体同时干活——这时普通终端标签页就不够用了：会话容易丢、MCP 服务在智能体之间不同步，也没人清楚「谁在做什么、在哪里做」。

**Alethe 就是为这种情况打造的桌面工作区。** 每个智能体都在真实的 PTY 里运行，嵌在持久化的项目布局中，各自保留会话与历史；你调整界面时它们也不会因此中断。在此之上，Alethe 还统一管理智能体共享的部分：CLI、MCP 服务器、Skills，以及你在智能体之间流转的对话。

跨平台（Windows、macOS、Linux），本地优先，基于 Tauri、Rust、React 与 `xterm.js` 构建。
「本地优先」描述的是工作区持久化方式，并不保证完全无网络；当前的网络默认行为、凭据与保留策略见
[`docs/PRIVACY.md`](./docs/PRIVACY.md)。

## 支持的平台

<table>
  <tr>
    <th width="33.33%">macOS</th>
    <th width="33.33%">Windows</th>
    <th width="33.33%">Linux</th>
  </tr>
  <tr>
    <td align="center">
      <img src="./docs/screenshots/alethe-macos.png" alt="在 macOS 上运行的 Alethe" width="100%">
    </td>
    <td align="center">
      <img src="./docs/screenshots/alethe-windows.png" alt="在 Windows 上运行的 Alethe" width="100%">
    </td>
    <td align="center">
      <img src="./docs/screenshots/alethe-linux.png" alt="在 Linux 上运行的 Alethe" width="100%">
    </td>
  </tr>
  <tr>
    <td align="center">支持 macOS</td>
    <td align="center">支持 Windows</td>
    <td align="center">支持 Linux</td>
  </tr>
</table>

## 智能体

| 智能体 | CLI | |
|---|---|---|
| **Claude Code** | `claude` | 会话恢复、用量卡片、本地历史 |
| **Codex** | `codex` | 会话恢复、用量卡片 |
| **GitHub Copilot CLI** | `copilot` | |
| **Cursor** | `cursor-agent` | 会话恢复 |
| **Antigravity** | `agy` | 用量卡片 |
| **OpenCode** | `opencode` | 会话恢复 |
| **Kiro CLI** | `kiro-cli` | |
| **Mimo** | `mimo` | |
| **Freebuff** | `freebuff` | |
| **Shell** | pwsh / bash / zsh | 普通终端，同一套窗格模型 |
| **WSL** | `wsl.exe` | 默认发行版，作为普通 Shell（Windows） |

缺失的 CLI 可以在 Alethe 内安装、更新与卸载——它会探测本机的 Node、npm、WinGet、Scoop、Chocolatey，只提供真正可用的方式，并优先使用各厂商官方安装器。已安装的 CLI 会从 PATH、注册表、npm/pnpm/Volta/fnm/nvm/Bun/Cargo/Scoop/Chocolatey 等位置发现，也可手动指定自定义路径。插件还可以向此列表添加自有智能体。

智能体可选择经 [9router](https://github.com/decolua/9router) 路由——这是一个本地代理，可在多个提供商之间分发流量并自动回退。Alethe 会安装并运行一份私有、版本锁定的副本，不会改动你的全局 npm 包。路由默认关闭，且仅对开启后新打开的终端生效。

## 它能做什么

**并行运行智能体**

- 用项目、分组与子分组组织仓库；每个打开的项目成为一个容器，拥有自己的窗格。
- 每个窗格一个智能体，或在同一窗格里用子标签页放多个智能体——各自独立的 PTY、工作目录与会话。
- 自动、聚焦、侧边栏与自定义网格布局，可直接在网格上编辑。
- 关闭容器只会隐藏界面；进程继续运行。

**保留上下文**

- Claude Code、Codex、Cursor 与 OpenCode 的会话可在崩溃或重启后恢复。
- **最近对话** 列出某窗格工作目录下的会话，并可重新打开其中任意一条。
- Claude Code 的对话可通过本地脱敏的上下文包 **交接给 Codex**（也可反向），无需手工复制整段线程。脱敏是尽力而为，启动目标智能体前请先检查上下文包。
- 每个 PTY 都会持久化回滚缓冲，重新附着时能看到之前发生了什么。

**管理智能体共享的内容**

- **MCP 标签页**：本机配置的全部 MCP 服务器，按服务器分组，并显示哪些智能体在用——读取 Claude Code、Codex、Cursor、OpenCode 与 Antigravity 的配置。可添加、移除、在智能体之间复制服务器，搜索官方注册表，并让各智能体验证是否真正连得上。每次写入都会备份、重新解析并以原子方式提交。
- **Skills 标签页**：各智能体已安装的 skills，解析链接与共享存储，使共享 skill 只显示一次。
- **Graphify**：项目的代码图谱，作为 MCP 服务器提供给智能体。

**用插件扩展**

- 功能以 **插件** 形式加载，而不是写死在代码里。官方插件——待办列表、Git 控制、主题包——随安装包分发，可在「偏好设置 ▸ 插件」中关闭；对应界面会随之出现或消失，无需重启。
- 插件可贡献工作区窗格、侧边栏标签、命令面板条目、完整主题，或新的智能体提供商。它在清单中声明所需能力，应用会拒绝未声明的请求。
- **插件目录**：其他人发布的插件会在 Alethe 内列出并写明权限；带安装包的条目可一键安装与更新。目录会为每个包固定 SHA-256 校验和，确保运行内容与审阅时一致。已安装插件默认关闭，启用前会经过信任对话框。

**发布插件**

插件是一个文件夹，名称与其 `plugin.json` 中的 `id` 一致，旁边是绑定 `window.alethe` 的 `main.js` 打包文件（React 已内置——不要自行打包 React）。清单声明标签页、命令与能力；代码负责实现。

1. **本地试用。** 把文件夹放到 `<profile>/plugins/<id>/`，或使用「偏好设置 ▸ 插件 ▸ *导入插件*」。导入后默认关闭——启用以信任对话框为准。
2. **打包 zip。** 压缩插件文件夹，计算 SHA-256，并挂到发布页：  
   `zip -r my-plugin.zip my-plugin && sha256sum my-plugin.zip`。
3. **申请上架。** 向本仓库提交 PR，在 [`plugins.json`](plugins.json) 增加一条，包含 `id`、`name`、`downloadUrl`，以及为了可从 Alethe 内安装所需的 `package.url` 与 `package.sha256`。zip 变更后请重新计算哈希。
4. 合并后，列表会在六小时内同步到所有人，或在点击 *刷新* 后立即更新。

上架是人工阅读你的 PR，不是安全审计：插件仍会以禁用状态到达，仍需信任对话框。`docs/examples/notes-plugin/` 是一个无需构建步骤的纯 JavaScript 示例；完整约定见 [插件指南](docs/PLUGINS.md)。

**保持掌控**

- 标题栏显示内存占用；可禁用终端或挂起整个分组以释放内存。
- 每个项目的 Git 面板——状态、暂存、提交、分支、在窗格中查看 diff——以及用于并行任务的 worktree。
- **Pull Request 审阅**：合并面板通过本地 `gh` CLI 查找智能体 worktree 对应的 GitHub PR，打开其元数据，并可在同一隔离 worktree 中启动 AI 审阅——只读，不会提交、推送、合并或发表 GitHub 评论。Squash 合并仍需明确的人为操作；若 head SHA 已变、PR 为草稿，或 GitHub 报告冲突，则会阻止。不存储 GitHub token；身份验证交给 `gh`。
- 终端旁的内容窗格：文件浏览器、Markdown、diff、图片、视频、内嵌浏览器。
- 每项目待办与番茄钟、隔离配置档、本地备份导出/导入、界面与终端主题，支持 EN、pt-BR 与 zh-CN。
- **编排看板**：一个主智能体把工作单元委派给 Claude 与 Codex 工作器，由 Alethe 并行运行——可选各自独立的 git worktree，卡片上汇报状态、费用、token 与 diff，离开沙箱前也可先征求你的同意。默认关闭。
- **本地语音听写**（设备端模型）与通过 GitHub 登录的 **偏好云同步**——均为可选。
- **远程控制**：经认证的局域网 Web 视图，通过二维码配对，可在手机上跟进并回复智能体。默认关闭，在局域网上使用未加密的 HTTP/WebSocket，因此请仅在可信网络启用。干净配置档默认为只读；回复智能体需要单独开启输入权限，Shell 输入还有额外开关。
- Spotify 正在播放：在 **偏好设置 ▸ Spotify** 中填入你自己的 Spotify 应用凭据，回调 URI 为 `http://127.0.0.1:8888/callback`。当前版本会把这些凭据存在本地配置档中；导出或分享配置档前请阅读隐私说明。

## 核心概念

| | |
|---|---|
| **分组（Group）** | 一组可一起打开、折叠与挂起的项目。 |
| **项目（Project）** | 已保存的工作上下文：终端、布局、颜色、本地状态。 |
| **容器（Container）** | 已打开项目的可见框架。关闭它不会结束任何进程。 |
| **窗格（Pane）** | 容器内的一个终端视图。 |
| **子标签（Sub-tab）** | 同一窗格内的另一个智能体或 Shell 会话。 |
| **PTY** | 真实后端进程，独立于 UI 存活。 |

## 产品理念

聚焦核心、能力可选，更接近 Obsidian，而不是功能堆满的 IDE。非必要功能放在功能开关或可选设置之后，干净安装也应是一等体验。一致性优于堆量。

## 安装

请从 [Releases](https://github.com/Kc1t/alethe-agents/releases) 使用已发布的安装包。

> [!WARNING]
> Windows 构建**尚未代码签名**，因此 Defender 可能把 `alethe.exe` 标为
> `Trojan:Win32/Bearfoos.A!ml` 并隔离。`!ml` 后缀表示机器学习启发式，而非发布者签名；像派生子进程、创建 PTY 这类终端复用行为也可能触发误报。请确认下载来自官方 Releases 页面；不要对其他来源的文件绕过警告。

恢复方式：**Windows 安全中心 → 病毒和威胁防护 → 保护历史记录 → 操作 → 还原**，然后为 `%LOCALAPPDATA%\Alethe` 添加排除项（若从源码构建，也可排除 `src-tauri/target`）。误报可向
[Microsoft Security Intelligence](https://www.microsoft.com/wdsi/filesubmission) 提交。macOS 构建也尚未公证——请右键应用并选择 **打开** 以绕过 Gatekeeper。签名与公证已在[路线图](#roadmap)中。

## 从源码运行

```sh
git clone https://github.com/Kc1t/alethe-agents.git
cd alethe-agents
npm install
npm run app
```

要求：Node.js 18+、稳定版 Rust、Windows 上的 Visual Studio Build Tools，以及 Linux 上的 Tauri 系统依赖：

```sh
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

```sh
npm run app          # 带热重载的桌面应用
npm run dev          # 仅前端
npm run build        # 类型检查 + 构建前端
npm run tauri build  # 安装包 → src-tauri/target/release/bundle/
```

## 终端命令

在 **设置 ▸ 集成 ▸ 终端命令** 中安装 `alethe` 命令：

```bash
alethe                # 将当前文件夹作为项目打开
alethe ~/some/project # 打开指定文件夹
```

若该文件夹已是项目，会把它带入工作区而不是重复创建。若 Alethe 已在运行，会聚焦现有窗口。命令安装到 `~/.local/bin/alethe`（macOS/Linux）或 `%LOCALAPPDATA%\Alethe\bin\alethe.cmd`（Windows）——移动应用后请重新安装。

## 路线图

- [x] 多智能体工作区：项目、分组、容器与子标签。
- [x] 真实 PTY：启动、附着、调整大小、回滚缓冲与会话恢复。
- [x] 智能体安装/更新/卸载，以及 MCP 与 skills 管理。
- [x] Windows、Linux、macOS 发布包。
- [ ] Windows 发布签名与 macOS 公证。
- [ ] 在真实机器上更广泛地验证 Linux/macOS。
- [ ] 官方托管云同步/备份（手动 GitHub Gist Sync 已可用）。

## 参与贡献 {#contributing}

欢迎贡献。请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md) 了解环境搭建、项目结构与约定。最容易上手的方式：

- 认领带 [`good first issue`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) 或 [`help wanted`](https://github.com/Kc1t/alethe-agents/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) 标签的议题——先留言声明。
- 用清晰复现步骤报告 bug，或说明能改进的工作流来提功能建议。
- 改进文档、截图与平台验证——Linux 与 macOS 测试最少。

较大改动请先开 issue 讨论方向。

## 用 Alethe 构建的作品

以下是以 Alethe 为工作区构建的项目与产品——智能体并行运行、Shell 并肩协作、会话跨天恢复。

<!-- showcase:start -->

_暂无条目。_ 用 Alethe 做出了什么？把它加到 [`SHOWCASE.md`](SHOWCASE.md)——只需一行和一个 PR，你也会进入贡献者列表。

<!-- showcase:end -->

完整列表与提交方式见 [`SHOWCASE.md`](SHOWCASE.md)。

## 观看 Alethe 实战

看看 Alethe 在真实开发流程中的用法，学习如何并行编排编程智能体。

<table>
  <tr>
    <th width="38%">视频</th>
    <th>你将看到</th>
  </tr>
  <tr>
    <td>
      <a href="https://www.youtube.com/watch?v=8jvrucR7QCU&amp;t=54s">
        <img src="https://i.ytimg.com/vi/8jvrucR7QCU/hqdefault.jpg" alt="Stop Using One AI Agent at a Time: Orchestrate AI Agents" width="100%">
      </a>
    </td>
    <td>
      <strong><a href="https://www.youtube.com/watch?v=8jvrucR7QCU&amp;t=54s">Stop Using One AI Agent at a Time: Orchestrate AI Agents</a></strong>
      <br><br>
      实用介绍：如何协调多个 AI 编程智能体，而不是一次只用一个。
      <br><br>
      <sub>Kauã Miguel - Dev · 葡萄牙语</sub>
    </td>
  </tr>
  <tr>
    <td>
      <a href="https://www.youtube.com/watch?v=reUN7CkMbgM&amp;t=100s">
        <img src="https://i.ytimg.com/vi/reUN7CkMbgM/hqdefault.jpg" alt="A Day in the Life of a Software Developer — Devlog 1" width="100%">
      </a>
    </td>
    <td>
      <strong><a href="https://www.youtube.com/watch?v=reUN7CkMbgM&amp;t=100s">A Day in the Life of a Software Developer — Devlog 1</a></strong>
      <br><br>
      真实开发者工作流，展示 Alethe 如何融入日常编码。
      <br><br>
      <sub>Guilherme Dev · 葡萄牙语</sub>
    </td>
  </tr>
</table>

## 也支持手机

https://github.com/user-attachments/assets/ae3aed75-2ead-43c4-a9ca-fd29d83b7e1d

## 贡献者

感谢每一位帮助塑造 Alethe 的人。

<p align="center">

  <!-- contributors:start -->
  <a href="https://github.com/Kc1t"><img src="https://github.com/Kc1t.png?size=100" width="80" height="80" alt="Kc1t" title="Kc1t" /></a>
  <a href="https://github.com/MiguelSilvaPorto"><img src="https://github.com/MiguelSilvaPorto.png?size=100" width="80" height="80" alt="MiguelSilvaPorto" title="MiguelSilvaPorto" /></a>
  <a href="https://github.com/HayatoG"><img src="https://github.com/HayatoG.png?size=100" width="80" height="80" alt="HayatoG" title="HayatoG" /></a>
  <a href="https://github.com/slegarraga"><img src="https://github.com/slegarraga.png?size=100" width="80" height="80" alt="slegarraga" title="slegarraga" /></a>
  <a href="https://github.com/lucapohl-angel"><img src="https://github.com/lucapohl-angel.png?size=100" width="80" height="80" alt="lucapohl-angel" title="lucapohl-angel" /></a>
  <a href="https://github.com/1arley"><img src="https://github.com/1arley.png?size=100" width="80" height="80" alt="1arley" title="1arley" /></a>
  <a href="https://github.com/potatoiscompiled"><img src="https://github.com/potatoiscompiled.png?size=100" width="80" height="80" alt="potatoiscompiled" title="potatoiscompiled" /></a>
  <a href="https://github.com/GustavoAlmeidaDoNascimento"><img src="https://github.com/GustavoAlmeidaDoNascimento.png?size=100" width="80" height="80" alt="GustavoAlmeidaDoNascimento" title="GustavoAlmeidaDoNascimento" /></a>
  <a href="https://github.com/Jbnado"><img src="https://github.com/Jbnado.png?size=100" width="80" height="80" alt="Jbnado" title="Jbnado" /></a>
  <a href="https://github.com/chintanparmar011"><img src="https://github.com/chintanparmar011.png?size=100" width="80" height="80" alt="chintanparmar011" title="chintanparmar011" /></a>
  <a href="https://github.com/AshSgDe29071999"><img src="https://github.com/AshSgDe29071999.png?size=100" width="80" height="80" alt="AshSgDe29071999" title="AshSgDe29071999" /></a>
  <a href="https://github.com/sthevan027"><img src="https://github.com/sthevan027.png?size=100" width="80" height="80" alt="sthevan027" title="sthevan027" /></a>
  <a href="https://github.com/rlevidev"><img src="https://github.com/rlevidev.png?size=100" width="80" height="80" alt="rlevidev" title="rlevidev" /></a>
  <a href="https://github.com/mapsiva"><img src="https://github.com/mapsiva.png?size=100" width="80" height="80" alt="mapsiva" title="mapsiva" /></a>
  <a href="https://github.com/moisesz10"><img src="https://github.com/moisesz10.png?size=100" width="80" height="80" alt="moisesz10" title="moisesz10" /></a>
  <a href="https://github.com/HumbertoCG18"><img src="https://github.com/HumbertoCG18.png?size=100" width="80" height="80" alt="HumbertoCG18" title="HumbertoCG18" /></a>
  <a href="https://github.com/Bakurin0"><img src="https://github.com/Bakurin0.png?size=100" width="80" height="80" alt="Bakurin0" title="Bakurin0" /></a>
  <a href="https://github.com/SrAmaral"><img src="https://github.com/SrAmaral.png?size=100" width="80" height="80" alt="SrAmaral" title="SrAmaral" /></a>
  <a href="https://github.com/diegoliveiraa"><img src="https://github.com/diegoliveiraa.png?size=100" width="80" height="80" alt="diegoliveiraa" title="diegoliveiraa" /></a>
  <a href="https://github.com/VicktorMS"><img src="https://github.com/VicktorMS.png?size=100" width="80" height="80" alt="VicktorMS" title="VicktorMS" /></a>
  <a href="https://github.com/rad4manthys"><img src="https://github.com/rad4manthys.png?size=100" width="80" height="80" alt="rad4manthys" title="rad4manthys" /></a>
  <a href="https://github.com/lucianoschirmer"><img src="https://github.com/lucianoschirmer.png?size=100" width="80" height="80" alt="lucianoschirmer" title="lucianoschirmer" /></a>
  <a href="https://github.com/lb1192176991-lab"><img src="https://github.com/lb1192176991-lab.png?size=100" width="80" height="80" alt="lb1192176991-lab" title="lb1192176991-lab" /></a>
  <a href="https://github.com/hgshreyas"><img src="https://github.com/hgshreyas.png?size=100" width="80" height="80" alt="hgshreyas" title="hgshreyas" /></a>
  <a href="https://github.com/fernando-c-lima"><img src="https://github.com/fernando-c-lima.png?size=100" width="80" height="80" alt="fernando-c-lima" title="fernando-c-lima" /></a>
  <a href="https://github.com/feejunior"><img src="https://github.com/feejunior.png?size=100" width="80" height="80" alt="feejunior" title="feejunior" /></a>
  <a href="https://github.com/eudehh"><img src="https://github.com/eudehh.png?size=100" width="80" height="80" alt="eudehh" title="eudehh" /></a>
  <a href="https://github.com/dudukings1"><img src="https://github.com/dudukings1.png?size=100" width="80" height="80" alt="dudukings1" title="dudukings1" /></a>
  <a href="https://github.com/davidwallaci"><img src="https://github.com/davidwallaci.png?size=100" width="80" height="80" alt="davidwallaci" title="davidwallaci" /></a>
  <a href="https://github.com/tomatotomata"><img src="https://github.com/tomatotomata.png?size=100" width="80" height="80" alt="tomatotomata" title="tomatotomata" /></a>
  <a href="https://github.com/ThiagoSales17"><img src="https://github.com/ThiagoSales17.png?size=100" width="80" height="80" alt="ThiagoSales17" title="ThiagoSales17" /></a>
  <a href="https://github.com/opedrooz"><img src="https://github.com/opedrooz.png?size=100" width="80" height="80" alt="opedrooz" title="opedrooz" /></a>
  <a href="https://github.com/devmatheusmota"><img src="https://github.com/devmatheusmota.png?size=100" width="80" height="80" alt="devmatheusmota" title="devmatheusmota" /></a>
  <a href="https://github.com/JohnPss"><img src="https://github.com/JohnPss.png?size=100" width="80" height="80" alt="JohnPss" title="JohnPss" /></a>
  <a href="https://github.com/GabrielKLopes"><img src="https://github.com/GabrielKLopes.png?size=100" width="80" height="80" alt="GabrielKLopes" title="GabrielKLopes" /></a>
  <a href="https://github.com/pinhaum"><img src="https://github.com/pinhaum.png?size=100" width="80" height="80" alt="pinhaum" title="pinhaum" /></a>
  <a href="https://github.com/floze-the-genius"><img src="https://github.com/floze-the-genius.png?size=100" width="80" height="80" alt="floze-the-genius" title="floze-the-genius" /></a>
  <a href="https://github.com/claude"><img src="https://github.com/claude.png?size=100" width="80" height="80" alt="claude" title="claude" /></a>
  <a href="https://github.com/aryansk"><img src="https://github.com/aryansk.png?size=100" width="80" height="80" alt="aryansk" title="aryansk" /></a>
  <a href="https://github.com/sousaakira"><img src="https://github.com/sousaakira.png?size=100" width="80" height="80" alt="sousaakira" title="sousaakira" /></a>
  <!-- contributors:end -->
</p>

## 许可证

源代码以 **AGPL-3.0-or-later** 分发。经修改的覆盖衍生作品若被分发，或通过网络向用户提供，必须在相同许可证下提供对应源代码。详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。

官方托管服务（如同步、备份、计费或云功能）可能是专有的，并单独提供。代码许可证不授予 **Alethe** 名称、徽标、应用图标或官方品牌的权利。修改后的构建必须使用独立品牌；商业使用 Alethe 品牌需事先获得 Kauã Miguel 的书面许可。详见
[`TRADEMARK.md`](TRADEMARK.md)。

## 社区

- 安全报告：[`SECURITY.md`](SECURITY.md)
- 隐私与数据流：[`docs/PRIVACY.md`](docs/PRIVACY.md)
- 维护者：[Kc1t](https://github.com/Kc1t)
- 项目：<https://github.com/Kc1t/alethe-agents>
- Bug 与功能请求：<https://github.com/Kc1t/alethe-agents/issues>

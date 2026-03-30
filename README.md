<p align="center">
  <img src="resources/icon.png" width="120" alt="EasyClaw Logo">
</p>

<h1 align="center">EasyClaw</h1>

<p align="center">
  <strong>OpenClaw AI 代理的一键桌面安装器</strong>
</p>

<p align="center">
  <a href="https://easyclaw.kr">官网</a> ·
  <a href="https://github.com/ybgwon96/easyclaw/releases/latest">下载</a> ·
  <a href="https://github.com/openclaw/openclaw">OpenClaw</a>
</p>

<p align="center">
  <a href="https://github.com/ybgwon96/easyclaw/releases/latest"><img src="https://img.shields.io/github/v/release/ybgwon96/easyclaw?color=f97316&style=flat-square" alt="Release"></a>
  <a href="https://github.com/ybgwon96/easyclaw/releases"><img src="https://img.shields.io/github/downloads/ybgwon96/easyclaw/total?color=34d399&style=flat-square" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="License"></a>
</p>

---

<p align="center">
  <img src="docs/screenshots/welcome.png" width="270" alt="欢迎页">
  &nbsp;&nbsp;
  <img src="docs/screenshots/env-check.png" width="270" alt="环境检查">
  &nbsp;&nbsp;
  <img src="docs/screenshots/done.png" width="270" alt="安装完成">
</p>

## 项目简介

EasyClaw 是一个基于 Electron 的桌面安装器，用来把 [OpenClaw](https://github.com/openclaw/openclaw) AI 代理安装到本地环境中，尽量减少终端操作和环境配置成本。

核心流程很简单：

**下载 -> 运行 -> 完成环境检查 -> 配置 API Key -> 开始使用**

## 主要功能

- 一键安装 OpenClaw 所需运行环境
- 自动检测并处理 Node.js、OpenClaw、Windows WSL 等依赖
- 支持 macOS 和 Windows
- 支持多种模型提供方：Anthropic、Google、OpenAI、MiniMax、GLM、DeepSeek、Ollama
- 支持 Telegram 机器人接入
- 支持本地 Gateway 启停、状态检查、自动更新、故障排查、备份与恢复

## 下载

| 平台    | 文件                  | 下载链接                                                                                  |
| ------- | --------------------- | ----------------------------------------------------------------------------------------- |
| macOS   | `easy-claw.dmg`       | [下载](https://github.com/ybgwon96/easyclaw/releases/latest/download/easy-claw.dmg)       |
| Windows | `easy-claw-setup.exe` | [下载](https://github.com/ybgwon96/easyclaw/releases/latest/download/easy-claw-setup.exe) |

也可以直接访问 [easyclaw.kr](https://easyclaw.kr)，站点会根据系统自动给出对应下载入口。

## 安装流程

应用内向导大致分为以下步骤：

1. 欢迎页
2. 环境检查
3. Windows 下按需执行 WSL 安装
4. 自动安装 Node.js / OpenClaw
5. API Key 配置引导
6. Telegram 配置引导
7. 最终配置与完成

Windows 环境下，EasyClaw 通过 WSL 中的 Ubuntu 运行 OpenClaw；macOS 则直接在本机环境中完成安装与运行。

## Windows 安全提示

当前 Windows 代码签名证书仍在完善中，首次安装时可能看到系统安全提醒。

> - [VirusTotal 扫描结果](https://www.virustotal.com/gui/url/800de679ba1d63c29023776989a531d27c4510666a320ae3b440c7785b2ab149)
> - 项目源码公开，可自行审查
> - 构建和发布流程基于 GitHub Actions

如果出现“Windows 已保护你的电脑”提示：

1. 点击“更多信息”
2. 点击“仍要运行”

## 技术栈

| 领域     | 技术                      |
| -------- | ------------------------- |
| 桌面框架 | Electron + electron-vite  |
| 前端     | React 19 + Tailwind CSS 4 |
| 语言     | TypeScript                |
| 构建     | electron-builder          |
| CI/CD    | GitHub Actions            |
| 文档站点 | Vercel                    |

## 项目结构

```text
src/
├── main/        # Electron Main process，负责系统能力、安装、更新、网关、排障
├── preload/     # 通过 contextBridge 暴露 IPC API
├── renderer/    # React 向导界面
└── shared/      # 共享逻辑与多语言资源
api/             # Vercel Serverless Functions
docs/            # 营销站点与静态资源
scripts/         # 发布与辅助脚本
```

其中 `src/main/services/` 包含环境检测、安装、Onboarding、Gateway、自动更新、排障、卸载、备份恢复、OAuth 等核心服务。

## 本地开发

安装依赖：

```bash
npm install
```

常用命令：

```bash
npm run dev
npm run build
npm run lint
npm run format
npm run typecheck
npm run package:local
npm run package:all
```

平台构建：

```bash
npm run build:mac-local
npm run build:win-local
```

打包说明：

- `npm run package:local`：在当前系统上一键完成编译并生成安装包
- `npm run package:all`：通过 GitHub Actions 同时构建 `dmg` 和 `exe`，并自动下载产物到 `dist/ci-artifacts/<run-id>/`
- 使用 `npm run package:all` 前，需要先完成 `gh auth login`

如果需要生成正式发布包，还可以使用：

```bash
npm run build:mac
npm run build:win
```

## 代码约定

- 使用 TypeScript
- Prettier 采用单引号、无分号、100 列宽
- 注释统一使用英文
- 提交信息使用 Conventional Commits，例如 `feat:`、`fix:`、`refactor:`

## 发布说明

执行下面的命令会自动执行版本升级、提交、推送并创建 GitHub Release：

```bash
npm run release
```

也可以附带版本类型：

```bash
npm run release -- minor
npm run release -- major
```

GitHub Actions 会基于同一个 Release 自动构建 macOS / Windows 安装包并上传产物。

## 贡献

欢迎提交 Issue 和 PR。开始之前建议先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

本项目基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建，感谢 openclaw 团队。

## 许可证

[MIT](LICENSE)

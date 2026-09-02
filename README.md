# AwaCode

AwaCode 是一个本地运行的桌面 Coding Agent：Qt 6 Widgets 桌面控制台通过 stdin/stdout 上的 NDJSON JSON-RPC 启动 TypeScript Core；Core 自行维护会话、上下文、工具调用、本地执行、审批和恢复。它不是现有 Agent 产品的界面封装，也没有使用 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 或服务端托管的代码/文件工具。

公开仓库：<https://github.com/tokisuki/AwaCode>

## 能做什么

- 用 OpenAI-compatible Chat Completions 的流式文本和原生 function calling 驱动单 Agent 的 Plan + Execute 工具循环；Plan 可用只读工具先检查项目，Execute 首次返回无工具调用的普通文本时直接完成，不再额外请求 Reflect。
- 为工作区提供 `list_files`、`read_file`、`search_text`、`edit_file`、`write_file`、`run_command` 和 `memory_write` 七个本地工具。
- 持久化项目、会话、消息、工具事件和上下文快照；Core 重启时将未完成工具调用收敛为 `interrupted`，不自动重放副作用。
- 提供薄终端客户端和 Qt 桌面端。两者只负责进程管理、显示和命令审批；模型调用、文件写入、工具执行和 Agent 决策均在 Core。
- Qt 文本区不包含 Markdown 渲染器，因此系统约束要求模型的计划、过程说明、收尾和最终回答全部使用纯文本，不输出 Markdown 语法。

## 前提条件

- Windows 10/11（本次交付与部署说明按 Windows 验证）。
- Node.js **24**。`core/package.json` 明确要求 `>=24`；旧版 Node 不能运行内置 SQLite 依赖。
- 桌面端还需要 CMake 3.21+、Ninja、**Qt 6.8.3 或更高版本的 MinGW 13.1 64-bit kit**。不要混用 Qt 5、MSVC kit 或其他 MinGW ABI。

## 构建和运行 Core / CLI

在仓库根目录执行。请先确认当前 shell 的 `node` 和 `npm` 都来自 Node.js 24 安装。

```powershell
Push-Location core
node --version
npm ci
npm run build
npm run typecheck
Pop-Location
```

配置由用户自己提供，绝不从仓库、命令历史、SQLite 或视频中取得密钥。最方便的方式是桌面端 **Settings** 页面；也可在启动前只在当前进程环境中设置。下面的 DeepSeek 例子仅含公开地址、模型名和占位密钥：

```powershell
$env:AWACODE_BASE_URL = "https://api.deepseek.com"
$env:AWACODE_MODEL = "deepseek-v4-flash"
$env:AWACODE_API_KEY = "YOUR_API_KEY"
```

环境变量优先于本地文件。可选的 `AWACODE_CONTEXT_LIMIT` 和 `AWACODE_MAX_OUTPUT_TOKENS` 必须为正整数，且后者小于前者。Core 会把两者之差全部作为输入容量，再扣除系统提示、记忆、摘要、阶段指令和工具 Schema 的实际估算量；不会另设固定比例或固定小型近期历史窗口。未提供完整有效配置时，Core 返回 `not_configured`；不会偷偷连到测试模型或任何线上提供方。

运行薄 CLI：

```powershell
Push-Location core
$env:AWACODE_NODE_PATH = "C:\path\to\node24.exe" # 当当前 node 不是 24 时才需要
npm run cli -- --workspace "D:\path\to\project" --prompt "修复失败测试"
Pop-Location
```

继续已有会话，或只查看持久化历史：

```powershell
Push-Location core
npm run cli -- --session "SESSION_ID" --prompt "继续完成"
npm run cli -- --resume "SESSION_ID"
Pop-Location
```

三种 CLI 形式互斥：新任务使用 `--workspace ... --prompt ...`，继续使用 `--session ... --prompt ...`，`--resume` 只加载历史后退出，**绝不**调用模型、运行 Agent 或执行工具。Core 本身也可供自动化使用：`node core/dist/index.js`，其 stdout 仅输出 NDJSON JSON-RPC，诊断写入 stderr。

## Qt 桌面端：构建、运行与部署

先按上节构建 Core。将下面两个变量换成自己的 Qt 6.8.3+ MinGW 13.1 kit 根目录和编译器；路径中的示例值不是项目配置。

```powershell
$env:QT_ROOT = "C:\Qt\6.8.3\mingw_64"
$env:QT_MINGW_BIN = "C:\Qt\Tools\mingw1310_64\bin"
$env:PATH = "$env:QT_ROOT\bin;$env:QT_MINGW_BIN;$env:PATH"
cmake -S desktop -B desktop\build-qt6 -G Ninja `
  "-DCMAKE_PREFIX_PATH=$env:QT_ROOT" `
  "-DCMAKE_CXX_COMPILER=$env:QT_MINGW_BIN\g++.exe"
cmake --build desktop\build-qt6
ctest --test-dir desktop\build-qt6 --output-on-failure
```

上一步的 `PATH` 同时用于 `ctest` 和桌面端；运行时再明确指定 Node 24：

```powershell
$env:PATH = "$env:QT_ROOT\bin;$env:QT_MINGW_BIN;$env:PATH"
$env:AWACODE_NODE_PATH = "C:\path\to\node24.exe"
.\desktop\build-qt6\awacode-desktop.exe
```

首次打开时可浏览历史，但没有完整模型配置就不能运行任务。桌面端显示计划、流式文本、工具时间线和 Core stderr，支持取消与手动重启 Core；它不直接调用模型或执行工具。发布给另一台 Windows 机器时使用同一 kit 的 `windeployqt` 收集 Qt DLL，同时随发布目录提供已构建的 `core/dist/`、`core/node_modules/` 与可配置的 Node 24 运行时；完整清单见 [部署说明](docs/DEPLOYMENT.md)。

## 数据、凭据与安全边界

默认数据根目录是 `%LOCALAPPDATA%\AwaCode\`，不会写进选定的代码工作区：

| 路径 | 内容 |
| --- | --- |
| `awacode.db` | SQLite WAL 会话、消息、工具事件和上下文快照 |
| `config.json` | Base URL、模型、上下文/输出限制；不含 API Key |
| `auth.json` | 用户选择本地保存的 API Key |
| `memory\global.md` | 明确请求的跨项目长期偏好 |
| `memory\projects\<project-id>.md` | 明确请求的项目长期事实 |

`AWACODE_DATA_DIR` 仅用于指定一个明确的替代数据根（例如一次性测试目录）；不要指向真实工作区或提交它的内容。不要读取、复制、上传或提交 `%LOCALAPPDATA%\AwaCode\`。配置状态和错误信息会脱敏 API Key。

读取、列举、搜索、`edit_file` 和 `write_file` 无需确认；文件写入仍经过路径守卫、持久化状态机、内容/身份复核和原子发布。只有 `run_command` 会显示批准预览，终端只接受精确的 `allow_once` 或 `deny`；允许一次不形成永久授权。命令以当前用户权限在工作区目录启动，可能访问工作区外资源——这不是容器或操作系统级沙箱。路径守卫拒绝越界路径和符号链接逃逸；创建文件不会覆盖已有目标。

长期记忆不是自动提炼：只有用户明确要求“记住、更新或忘掉”时才会调用 `memory_write`。未指定作用域默认项目记忆；只有明确的跨项目偏好才使用全局记忆，项目记忆在上下文中优先于全局记忆。

## 上下文与恢复

Core 持久化完整审计历史，但向模型发送受预算控制的上下文：近期消息、动态系统信息、显式记忆和滚动摘要按原子交互块构建；中文估算较保守。超出预算时会生成替换式结构化摘要；若摘要失败或压缩后仍溢出，任务明确停止而不是静默丢失历史。

启动时会把上次崩溃留下的 `pending`、等待审批和运行中的工具调用记录为 `interrupted`，补齐可审计结果；其中运行中调用的结果可能未知。历史可在 CLI `--resume` 或 Qt 会话列表中查看，用户可发起新的继续任务，但 AwaCode 不会自动重放写文件或命令。

## 演示、验证与排障

受控演示夹具和两分钟录制脚本见 [演示与提交指南](docs/DEMO_AND_SUBMISSION.md)。它的复位程序必须带明确目标，且只允许 `demo/` 内目标：

```powershell
& "C:\path\to\node24.exe" demo\reset.mjs --target demo\.workspace\recording
```

常见问题：

- **`not_configured` / Run 按钮禁用**：在 Settings 保存完整配置，或确认三个 `AWACODE_*` 必需变量均为非空；不要把 Key 放进 `.env`、Git 或录屏。
- **Node 版本错误**：用 `node --version` 确认 24；若 CLI/Qt 继承的 `node` 不是 24，设置 `AWACODE_NODE_PATH`。
- **Qt 启动缺 DLL / platform plugin**：使用同一个 Qt MinGW kit 的 `windeployqt`，并确保 `QT_ROOT\bin` 和 MinGW `bin` 在 `PATH` 中。
- **`ctest` 显示 `0xc0000135`**：这表示 Windows 找不到 Qt/MinGW DLL。确认在启动 `ctest` 的同一 shell 先执行上节的 `PATH` 行；仍需定位时，在同一环境执行 `Get-ChildItem desktop\build-qt6\awacode-*-test.exe | ForEach-Object { & $_.FullName }`，逐个运行相同的 Qt 测试二进制。
- **命令被拒绝或中断**：审批时只输入 `allow_once` 或 `deny`；取消、超时、断开都不会执行该次副作用。重新检查时间线后再新建或继续任务。
- **上下文溢出**：提高用户配置的上下文窗口，减少单次任务范围，或开始新会话；不要假定 Core 会丢弃历史来“修好”请求。

## 已知限制

- 当前交付按 Windows、Node 24、Qt 6.8.3+ MinGW 13.1 验证；未提供 macOS/Linux 安装包或 Qt 5/MSVC ABI 支持。
- 仅支持 OpenAI-compatible Chat Completions；没有第二套 Anthropic 协议、MCP、插件、子 Agent、远程执行、LSP 或 IDE 编辑器。
- 单 Core 进程一次只运行一个 Agent；恢复保留证据但不重放未完成工具。
- 审批是产品层授权，不是安全沙箱；执行的 shell 命令仍具有当前 Windows 用户权限。

## 开发验证

```powershell
Push-Location core
npm run verify
Pop-Location
& "C:\path\to\node24.exe" --test demo\reset.test.mjs
```

Qt 侧执行上节的 `cmake --build` 和 `ctest`。完整验收会额外运行脚本化的 Headless、Qt 进程到 Core 集成及仓库检查；这些测试只使用临时 `AWACODE_DATA_DIR` 和本地 fixture provider，不会调用用户模型配置或真实 API。

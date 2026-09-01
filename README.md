# AwaCode

AwaCode 是一个本地运行的 Coding Agent 演示项目。Core 使用 Node.js 24、SQLite 和 OpenAI-compatible Chat Completions；终端客户端只负责输入、事件展示与逐次审批，Agent 决策和持久化均在 Core 中完成。

## 首次运行

在 `core/` 中使用 Node.js 24 安装、构建并启动：

```powershell
npm install
npm run build
```

用户必须主动提供自己的模型配置。可以通过尚未启动 Core 时设置环境变量：

```powershell
$env:AWACODE_BASE_URL = "https://example.invalid/v1"
$env:AWACODE_MODEL = "your-model-id"
$env:AWACODE_API_KEY = "your-api-key"
```

也可以由客户端调用 `config/save` 保存配置。API Key 与普通配置分开保存在本机数据目录，不应提交到 Git。

创建会话并执行任务：

```powershell
npm run cli -- --workspace D:\path\to\project --prompt "修复失败测试"
```

继续会话或只查看恢复后的历史：

```powershell
npm run cli -- --session <session-id> --prompt "继续完成"
npm run cli -- --resume <session-id>
```

`--resume` 只加载并显示历史，不会自动调用模型或执行工具。编辑文件与运行命令时，终端只接受 `allow_once` 或 `deny`。若当前 shell 不是 Node.js 24，可将 `AWACODE_NODE_PATH` 指向 Node 24 可执行文件后运行已构建 CLI。

## Qt 6 桌面控制台

桌面端是 Qt 6 Widgets Agent 控制台，而不是 IDE：它选择工作区、浏览与新建会话、
展示计划/流式文本/工具时间线、逐次请求本地副作用审批，并可查看 Core stderr、取消任务或在异常退出后手动重启。
桌面端不调用模型，也不执行 Agent 工具；它仅以 JSON-RPC 2.0 over NDJSON/stdin/stdout 管理 Core 子进程。

先使用 Node 24 构建 Core，再从仓库根目录配置并构建桌面端。以下路径是本项目固定验证过的 Qt 6.8.3 / MinGW-w64 13.1 工具链；不要替换为 Anaconda Qt 5 或 `D:\mingw64` 的编译器。

```powershell
$node24 = "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
Push-Location core
& $node24 .\node_modules\typescript\bin\tsc -p tsconfig.json
Pop-Location

& D:\mingw64\bin\cmake.exe -S desktop -B desktop\build-qt6 -G Ninja `
  "-DCMAKE_PREFIX_PATH=D:/codes/AwaCode/.local/Qt/6.8.3/mingw_64" `
  "-DCMAKE_CXX_COMPILER=D:/codes/AwaCode/.local/Qt/Tools/mingw1310_64/bin/g++.exe"
& D:\mingw64\bin\cmake.exe --build desktop\build-qt6
```

为运行时提供 Qt 与 MinGW DLL 路径；可选的 `AWACODE_NODE_PATH` 应指向 Node 24。首次启动没有有效模型配置时，桌面端仍可浏览历史但会禁用运行按钮；在“Settings”中由用户主动提供配置。不要把 API Key 写入命令行、Git、SQLite 或文档。

```powershell
$env:PATH = "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64\bin;D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin;$env:PATH"
$env:AWACODE_NODE_PATH = "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
.\desktop\build-qt6\awacode-desktop.exe
```

用 Qt 目录中的 `windeployqt.exe` 为演示副本部署 Qt DLL；Core 的 `core/dist/` 和运行时 Node 仍须按上面的启动约定可用。不要把本机的 `%LOCALAPPDATA%\AwaCode`、凭据文件或生成的 `desktop/build-qt6/` 提交进仓库。

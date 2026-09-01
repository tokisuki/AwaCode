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

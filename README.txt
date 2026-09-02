AwaCode：本地桌面编程智能体
仓库：https://github.com/tokisuki/AwaCode

运行：Windows 安装 Node.js 24；进入 core 执行 npm ci、npm run build。桌面端还需 Qt 6.8.3+ MinGW 13.1、CMake 和 Ninja，按 README.md 完成一次构建后可双击 start-awacode.cmd 启动。首次使用由用户在 Settings 中配置自己的 OpenAI-compatible Base URL、模型、上下文窗口、最大输出和 API Key；也可使用命令行客户端。凭据仅保存在环境变量或未入库的本地文件中。

特色功能：项目不是现成 Agent 产品的界面封装，也未使用任何 Agent 框架或 SDK。Qt 客户端只负责会话、展示和审批，通过 NDJSON JSON-RPC 管理自行实现的 TypeScript Core。Core 使用模型原生 function calling 完成可先读取项目的 Plan + Execute 循环，提供列举、读取、搜索、精确编辑、新建文件、执行命令和显式记忆七个本地工具。文件操作经过工作区路径守卫、内容复核和原子写入后自动执行；命令显示实际命令、工作目录和风险提示，每次只允许 allow_once 或 deny。

会话、消息、工具状态和上下文快照持久化到 SQLite，桌面端支持新建、切换和删除会话。崩溃后未完成调用会收敛为 interrupted，历史可以恢复，但不会自动重放写文件或命令。上下文按用户配置的窗口预算构建，超限时生成替换式滚动摘要。长期记忆分为项目级和全局级，仅在用户明确要求记住、更新或忘记时写入，项目记忆优先，避免自动提炼造成污染。Qt 界面还展示流式纯文本回复、工具时间线、取消和 Core 重启状态。

限制：目前仅支持 Windows、Node 24 和 Qt 6.8.3+ MinGW 13.1；只支持 OpenAI-compatible Chat Completions

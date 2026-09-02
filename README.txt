AwaCode：本地桌面编程智能体
仓库：https://github.com/tokisuki/AwaCode

运行：Windows 安装 Node.js 24；进入 core 执行 npm ci、npm run build。桌面端还需 Qt 6.8.3+ MinGW 13.1、CMake 和 Ninja，按 README.md 构建后，可双击 start-awacode.cmd 启动两端。首次使用须在 Settings 主动配置 OpenAI-compatible Base URL、模型、上下文窗口、最大输出和 API Key；凭据仅来自环境变量或未入库的本地配置。

特色与优势：项目不是现成 Agent 产品的界面封装，也未使用 Agent 框架或 SDK。Qt 客户端通过 NDJSON JSON-RPC 驱动自行实现的 TypeScript Core；模型调用、历史构建、工具解析、循环终止和错误恢复均自行实现。Agent 先在 Plan 阶段用只读工具了解代码，再在 Execute 阶段以原生 function calling 完成列举、读取、搜索、精确编辑、新建文件和执行命令，减少“只给方案、不真正修改”的假完成；轮次、工具次数和重复调用检测可阻止失控循环。

本地工具兼顾自主性与安全性：文件路径被限制在工作区，编辑前复核内容版本并原子替换，模型可直接写文件；命令执行则逐次向用户展示解析后的实际命令、工作目录和风险，只允许单次批准或拒绝。最终回答依据真实工具结果生成，界面同时保留流式纯文本、工具时间线和执行状态，便于核验过程。

会话、消息、工具状态和上下文快照持久化到 SQLite，支持新建、切换和删除。崩溃时未完成调用会收敛为 interrupted；恢复历史但不自动重放写文件或命令，避免重复副作用。长对话按照用户配置的真实窗口预算构建，超限时以替换式滚动摘要释放空间。长期记忆分为项目级和全局级，仅在用户明确要求记住、更新或忘记时改变，既能跨会话复用，又避免自动提炼污染。核心行为由 node:test 与 Qt Test 持续验证。

限制：目前面向 Windows、Node.js 24、Qt 6.8.3+ MinGW 13.1，仅支持 OpenAI-compatible Chat Completions。

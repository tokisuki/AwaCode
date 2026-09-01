AwaCode：本地桌面编程智能体
仓库：https://github.com/tokisuki/AwaCode

运行：安装 Node.js 24；进入 core 执行 npm ci、npm run build；由用户在桌面端 Settings 配置自己的 OpenAI-compatible Base URL、模型和 API Key，然后执行 npm run cli -- --workspace "项目路径" --prompt "任务"。桌面端还需 Qt 6.8.3+ MinGW 13.1、CMake 和 Ninja，构建方法见 README.md。

功能：Qt 控制台和命令行都通过 JSON-RPC 管理 TypeScript Core。Core 自行实现会话 SQLite 持久化、流式模型调用、Plan + Execute 工具循环、上下文滚动摘要、全局/项目显式记忆、崩溃恢复，以及列举、读取、搜索、精确编辑、新建文件和命令等本地工具。模型的用户可见回复固定为纯文本；读操作自动允许，写文件和命令每次都需 allow_once 或 deny。

限制：仅验证 Windows + Node 24 + Qt 6.8.3+ MinGW 13.1；只支持 OpenAI-compatible Chat Completions；没有 MCP、插件、子 Agent、远程执行或系统级沙箱。命令仍以当前用户权限运行。密钥只来自环境变量或未入库本地配置，不能提交或录入视频。

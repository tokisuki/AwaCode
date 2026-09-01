# Task 15：文档与最终验收报告

日期：2026-09-01。验收在 `master` 工作树完成；没有读取、写入或调用真实的 `%LOCALAPPDATA%\AwaCode\`、用户 API Key 或线上模型。

## 本次交付

- 完整根目录 `README.md`：Node 24、Core/CLI、Qt 6.8.3+ MinGW 13.1 构建/运行/部署、用户自行提供的 OpenAI-compatible 配置、凭据/数据位置、工具和审批、恢复、压缩、显式记忆、排障和平台限制。
- `README.txt`：面向提交的简短说明，包含公开地址、运行、特色和限制。
- `docs/DEPLOYMENT.md` 与 `docs/DEMO_AND_SUBMISSION.md`：Windows 部署、确定性演示复位、两分钟录制脚本和最终提交清单。
- `demo/fixture/` 与 `demo/reset.mjs`：一个有意失败的折扣边界测试夹具；复位器要求精确 `--target`，只允许 `demo/` 内部目标。`demo/reset.test.mjs` 先验证缺少目标和项目外目标均失败，再验证复位可重复恢复夹具。
- `设计参考.md` 增加实施状态对账，保留原始设计决策和历史实施顺序。

## README.txt 字符计数

以 Node 24 执行 `Array.from(text).length`：**629 Unicode code points**；UTF-16 code units 同为 629，UTF-8 为 1123 bytes。按“所有字符均计入”的保守口径，629 < 1000。

## 验证记录

| 命令/检查 | 结果 |
| --- | --- |
| `node24 --test demo/reset.test.mjs` | 1/1 通过；拒绝无目标与 demo 外目标，重复复位成功。 |
| `node24 npm run verify`（通过 Node 24 PATH 启动 npm） | typecheck、构建及完整 Node 测试通过：369 passed、5 skipped、0 failed。npm 在受限环境中仅报告不能清扫全局 npm 日志目录的 `EPERM` 警告，不影响命令退出或测试。 |
| `node24 --test core/test/e2e/headless-workflow.test.ts` | 2/2 通过：脚本化 provider 下读取、失败测试、逐次批准编辑、通过测试；崩溃后收敛且 `--resume` 仅显示历史。 |
| `cmake --build desktop/build-qt6` | 成功构建桌面端、5 个 Qt 单元测试和 real-core probe。 |
| Qt 直接测试（5 个 `awacode-*-test.exe`，Qt/MinGW DLL PATH 与 `QT_QPA_PLATFORM=offscreen`） | 全部以 0 退出。 |
| `node24 desktop/test/real_core_integration.mjs`，注入 `AWACODE_REAL_CORE_PROBE` 与临时数据根 | 0 退出；真实 Qt `QProcess` probe 驱动真实 Core 与本地脚本化 OpenAI SSE fixture，修复 `return 1` 为 `return 2` 并验证结果。 |
| `git diff --check` | 通过。 |
| 跟踪文件私钥/常见 token 签名扫描 | 无 `sk-`、`AIza` 或 PEM 私钥候选。 |

Qt 的裸 `ctest` 初次运行没有继承 Qt/MinGW runtime DLL 查找环境而以 `0xc0000135` 启动失败；这是 Windows 部署环境缺失，不是编译或测试断言失败。按 README 所述设置 Qt/MinGW `PATH` 后，5 个 Qt 测试二进制均直接通过；发布说明也要求使用同一 kit 的 `windeployqt`。

## 题目逐项矩阵

| 题目要求 | 证据/状态 |
| --- | --- |
| 独立 Coding Agent，可读写文件、执行命令 | Core 注册 `list_files`、`read_file`、`search_text`、`edit_file`、`write_file`、`run_command` 与 `memory_write`；Headless 和 Qt integration 均完成真实本地修复流程。 |
| 不封装现有 Agent，不用 Agent 框架/SDK | `core/package.json` 的运行依赖仅为允许使用的官方 `openai` 客户端；`package-lock.json` 未包含 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等。工具、循环、持久化、上下文和恢复均在 `core/src/`。 |
| 不依赖服务端代码/文件工具 | 模型边界是 Chat Completions；文件和命令工具在本机 Core 执行。验收 provider 是本地 SSE fixture。 |
| 公开、新建仓库与完整历史 | 父任务提供的 GitHub API 证据：`tokisuki/AwaCode`、`private=false`、`visibility=public`、默认分支 `master`、URL 为 <https://github.com/tokisuki/AwaCode>。本地 `git log` 保留历史；本任务未 amend、rebase 或 push。 |
| README.txt 地址、运行、特色、1000 字以内 | 根目录 `README.txt` 含公开 URL、运行步骤、功能和限制；保守计数 629。 |
| 凭据不得入库/README.txt/视频 | 文档只给 `YOUR_API_KEY` 占位示例；数据边界为用户目录/临时注入目录；扫描未发现私钥常见签名。录制指南明确禁止展示凭据。 |
| 视频 MP4 ≤2 分钟、≤200 MB | **待录制者完成**；本次只提供录制脚本，未创建 MP4。 |
| 仅 README.txt 与视频组成“本人姓名.zip” | **待录制者完成**；提交指南已明确要求。 |
| 截止时间后不推送 | **人工流程项**；本任务没有 push。 |

## 自检与遗留事项

文档中的配置例子仅使用公开 Base URL、模型名和 `YOUR_API_KEY` 占位符；没有真实 Key。重置脚本不接受隐式目标，且测试在一次性 `demo/.workspace/reset-test` 完成后清理。夹具本身有意保留失败测试，便于录制时让 Agent 修复；它不是验收失败。

剩余用户动作：使用自己的配置录制一次真实演示，导出 MP4（≤2 分钟/200 MB，屏幕无凭据），并把 **仅** `README.txt` 和该视频压入以本人姓名命名的 zip，随后在截止时间前上传题目表单；截止后不再推送仓库。

## 提交

| 提交 | 内容 |
| --- | --- |
| `09536be docs: finalize submission materials` | README、README.txt、部署/演示指南、确定性 demo fixture/reset 测试、设计状态对账和本报告初版；未修改 Core 或 Qt 生产逻辑。 |

本报告的提交证据补充作为独立的后续文档提交，未 amend、rebase 或 push 历史。

## 修复轮次 1：demo 祖先链接与 Qt 测试环境

### RED

先向 `demo/reset.test.mjs` 加入受控祖先检查、真实 junction/symlink 祖先外部 sentinel，以及删除后复制前祖先替换三项回归。Node 24 命令：

```text
node24 --test demo/reset.test.mjs
```

结果：失败，模块报 `reset.mjs does not provide an export named 'assertSafeDemoTarget'`。该失败发生在任何 `rm` 前；因此没有对外部 sentinel 进行破坏性试验。

### GREEN

`reset.mjs` 现在逐段 `lstat` 从 `demo/` 根到目标的每个现有祖先，拒绝 symbolic link/junction；删除前再次验证，并在可测试的“删除后、复制前”边界再次验证。运行同一命令的结果：4/4 通过，包括真实链接祖先拒绝、外部 sentinel 保留、交换边界及普通重复复位。

README 与部署说明均将 Qt 6.8.3/匹配 MinGW 13.1 的 `bin` 加入 `PATH` 后才执行 `ctest`，并说明 `0xc0000135` 的直接测试诊断回退。

附加命令验证使用 Node 24：无参数退出 2，`--target D:\awacode-outside-target` 被拒绝，明确的 `--target demo\.workspace\round1-command-validation` 成功复位并在验证后清理。`README.txt` 重新按所有 Unicode code point 计数仍为 629；本轮变更的私钥/token 签名扫描和 `git diff --check` 均无异常。

本轮 green 代码与文档会作为新的、未 amend 的提交记录；其准确 SHA 在后续提交证据补充中登记。

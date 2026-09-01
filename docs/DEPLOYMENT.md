# Windows 部署说明

本项目的可复现验证组合是 Node 24、Qt 6.8.3+ Widgets、MinGW 13.1 64-bit、CMake 3.21+ 和 Ninja。Qt 5、MSVC 构建及其他 MinGW ABI 不在本次交付支持范围内。

## 构建

先在 `core/` 以 Node 24 执行 `npm ci` 和 `npm run build`，再以同一个 Qt MinGW kit 配置 `desktop/`：

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

路径均为安装位置示例。`PATH` 必须在运行 `ctest` 前设置，否则 Windows 可能以 `0xc0000135` 找不到 Qt/MinGW DLL。遇到该错误时，在同一 shell 执行 `Get-ChildItem desktop\build-qt6\awacode-*-test.exe | ForEach-Object { & $_.FullName }` 可逐个运行相同二进制作为诊断回退。必须由同一 Qt kit 的 `windeployqt.exe` 处理桌面 EXE；不要从其他 Qt 版本或编译器目录复制 DLL。

## 分发目录

为演示副本创建一个新目录（不要覆盖仓库或用户数据），至少包含：

- `awacode-desktop.exe` 与 `windeployqt` 生成的 Qt platform/plugin/DLL 文件；
- 已构建的 `core/dist/`；
- `core/node_modules/`，因为运行时需要 `openai` 包；
- Node 24 运行时，或由启动脚本设置的 `AWACODE_NODE_PATH`；
- 可由用户修改的启动脚本，而不是硬编码 API Key。

启动前可设置 `AWACODE_NODE_PATH` 到该副本的 Node 24 EXE，并把 Qt/MinGW `bin` 加入 `PATH`。用户首次运行后再通过 Settings 或临时环境变量配置模型。数据默认仍写入用户的 `%LOCALAPPDATA%\AwaCode\`，不应随程序副本复制、打包或版本控制。

不要发布或提交 `auth.json`、`config.json`、`awacode.db`、`memory/`、`desktop/build-*`、用户数据目录或任何 `.env` 文件。模型访问始终由用户自行授权和提供凭据。

# Windows Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a relocatable, self-contained AwaCode Windows application payload and produce a conventional per-user `Setup.exe` plus a matching portable ZIP.

**Architecture:** A testable Qt runtime-path resolver makes the desktop executable independent of its launch directory. A PowerShell pipeline builds a single verified staging tree containing the Qt application, matching Qt/MinGW libraries, official Node.js 24 runtime, compiled Core, and production dependencies; the same tree feeds both ZIP creation and Inno Setup.

**Tech Stack:** C++17, Qt 6.8.3 Widgets/Test, MinGW-w64 13.1, TypeScript/Node.js 24, PowerShell 5.1+, CMake/Ninja, `windeployqt`, Inno Setup 6.

**Spec:** `docs/superpowers/specs/2026-09-02-windows-packaging-design.md`

## Global Constraints

- Deliver exactly `AwaCode-Setup-0.1.0-x64.exe` and `AwaCode-Portable-0.1.0-x64.zip` from one verified staging tree.
- Target Windows x64; do not add ARM64, 32-bit, MSI, online update, or single-file extraction modes.
- The target computer must not require Node.js, Qt, CMake, Ninja, npm, or administrator rights.
- Build Qt with the repository's supported Qt 6.8.3 MinGW 13.1 kit; never use the Anaconda Qt found on PATH.
- Bundle a pinned official Node.js 24 Windows x64 runtime and verify its published SHA-256 checksum.
- Install per user under `%LOCALAPPDATA%\Programs\AwaCode` with Inno Setup `PrivilegesRequired=lowest`.
- Keep AppId `{2D914859-8E35-4699-9E10-AE9F74D78E4A}` stable across future versions.
- Never package or remove `%LOCALAPPDATA%\AwaCode`, credentials, model configuration, SQLite history, memory, `.env*`, repository metadata, source trees, or test/build artifacts.
- Generated `release/` content remains ignored and uncommitted.
- Follow red-green-refactor for runtime and verifier behavior; commit only green slices.

---

### Task 1: Relocatable Desktop Runtime Resolution

**Files:**
- Create: `desktop/src/RuntimePaths.h`
- Create: `desktop/src/RuntimePaths.cpp`
- Create: `desktop/test/tst_runtime_paths.cpp`
- Modify: `desktop/src/main.cpp`
- Modify: `desktop/src/MainWindow.h`
- Modify: `desktop/src/MainWindow.cpp`
- Modify: `desktop/CMakeLists.txt`
- Modify: `设计参考.md`

**Interfaces:**
- Consumes: `QCoreApplication::applicationDirPath()`, current working directory, and `QProcessEnvironment`.
- Produces: `struct RuntimePaths { QString nodeProgram; QString coreEntry; QString diagnostic; bool isValid() const; };`
- Produces: `RuntimePaths resolveRuntimePaths(const QString &applicationDir, const QString &workingDir, const QProcessEnvironment &environment);`
- Produces: `void MainWindow::showStartupDiagnostic(const QString &message);`

- [ ] **Step 1: Write the failing Qt test**

Create `desktop/test/tst_runtime_paths.cpp` with temporary layouts covering bundled paths, explicit overrides, development fallback, paths containing spaces/Chinese characters, and missing Core:

```cpp
#include <QtTest>
#include <QFile>
#include <QProcessEnvironment>
#include <QTemporaryDir>

#include "RuntimePaths.h"

class RuntimePathsTest final : public QObject {
  Q_OBJECT
private slots:
  void prefersBundledRuntime();
  void explicitOverridesWin();
  void fallsBackToRepositoryCore();
  void reportsMissingCore();
};

void RuntimePathsTest::prefersBundledRuntime() {
  QTemporaryDir root(QStringLiteral("awacode 路径-XXXXXX"));
  QVERIFY(root.isValid());
  QDir dir(root.path());
  QVERIFY(dir.mkpath(QStringLiteral("runtime")));
  QVERIFY(dir.mkpath(QStringLiteral("core/dist")));
  QFile(dir.filePath(QStringLiteral("runtime/node.exe"))).open(QIODevice::WriteOnly);
  QFile(dir.filePath(QStringLiteral("core/dist/index.js"))).open(QIODevice::WriteOnly);

  const RuntimePaths paths = resolveRuntimePaths(root.path(), QStringLiteral("C:/unrelated"), {});
  QVERIFY(paths.isValid());
  QCOMPARE(paths.nodeProgram, dir.filePath(QStringLiteral("runtime/node.exe")));
  QCOMPARE(paths.coreEntry, dir.filePath(QStringLiteral("core/dist/index.js")));
}

void RuntimePathsTest::reportsMissingCore() {
  QTemporaryDir root;
  const RuntimePaths paths = resolveRuntimePaths(root.path(), root.path(), {});
  QVERIFY(!paths.isValid());
  QVERIFY(paths.diagnostic.contains(QStringLiteral("core/dist/index.js")));
}

QTEST_MAIN(RuntimePathsTest)
#include "tst_runtime_paths.moc"
```

- [ ] **Step 2: Register and run the focused test to verify RED**

Add an `awacode-runtime-paths-test` target to `desktop/CMakeLists.txt` using `RuntimePaths.cpp`, `Qt6::Test`, and `Qt6::Core`.

Run:

```powershell
$env:PATH = "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64\bin;D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin;$env:PATH"
cmake -S desktop -B desktop\build-qt6 -G Ninja -DCMAKE_PREFIX_PATH=D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64 -DCMAKE_CXX_COMPILER=D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin\g++.exe
cmake --build desktop\build-qt6 --target awacode-runtime-paths-test
ctest --test-dir desktop\build-qt6 -R awacode-runtime-paths-test --output-on-failure
```

Expected: build or test failure because `RuntimePaths` is not implemented.

- [ ] **Step 3: Implement the minimal resolver**

Implement these exact rules in `RuntimePaths.cpp`:

```cpp
RuntimePaths resolveRuntimePaths(const QString &applicationDir,
                                 const QString &workingDir,
                                 const QProcessEnvironment &environment) {
  const QDir app(applicationDir);
  const QDir cwd(workingDir);
  const QString overrideNode = environment.value(QStringLiteral("AWACODE_NODE_PATH"));
  const QString overrideCore = environment.value(QStringLiteral("AWACODE_CORE_PATH"));
  const QString bundledNode = app.filePath(QStringLiteral("runtime/node.exe"));
  const QString bundledCore = app.filePath(QStringLiteral("core/dist/index.js"));
  const QString developmentCore = cwd.filePath(QStringLiteral("core/dist/index.js"));

  const QString node = !overrideNode.trimmed().isEmpty()
    ? QDir::cleanPath(overrideNode)
    : QFileInfo::exists(bundledNode) ? bundledNode : QStringLiteral("node");
  const QString core = !overrideCore.trimmed().isEmpty()
    ? QDir::cleanPath(overrideCore)
    : QFileInfo::exists(bundledCore) ? bundledCore : developmentCore;

  if (!QFileInfo::isFile(core))
    return {node, core, QStringLiteral("Core entry was not found: %1").arg(core)};
  if (node != QStringLiteral("node") && !QFileInfo::isFile(node))
    return {node, core, QStringLiteral("Node runtime was not found: %1").arg(node)};
  return {QDir::cleanPath(node), QDir::cleanPath(core), {}};
}
```

`isValid()` returns `diagnostic.isEmpty()`.

- [ ] **Step 4: Integrate the resolver without starting a partial Core**

In `main.cpp`, resolve from `QCoreApplication::applicationDirPath()` and `QDir::currentPath()`. Construct `AgentProcessManager` only when valid. On failure, create `MainWindow` without a manager, call `showStartupDiagnostic()`, show the window, and leave Run disabled. When valid, pass the absolute Core entry to the manager.

`showStartupDiagnostic()` appends `Startup: <message>` to the existing Diagnostics control; it must not display a modal dialog or include environment values.

- [ ] **Step 5: Run focused and full Qt verification**

Run the focused command from Step 2, then:

```powershell
cmake --build desktop\build-qt6
ctest --test-dir desktop\build-qt6 --output-on-failure
```

Expected: all Qt tests pass.

- [ ] **Step 6: Record the decision and commit**

Add design decision D33 to `设计参考.md`: packaged startup uses executable-relative Node/Core paths, explicit development overrides, and a disabled UI with a redacted diagnostic when incomplete.

```powershell
git add desktop/src/RuntimePaths.h desktop/src/RuntimePaths.cpp desktop/test/tst_runtime_paths.cpp desktop/src/main.cpp desktop/src/MainWindow.h desktop/src/MainWindow.cpp desktop/CMakeLists.txt 设计参考.md
git commit -m "feat(desktop): support relocatable bundled runtime"
```

---

### Task 2: Package Layout and Secret-Exclusion Verifier

**Files:**
- Create: `packaging/lib/package-layout.mjs`
- Create: `packaging/verify-layout.mjs`
- Create: `packaging/test/package-layout.test.mjs`

**Interfaces:**
- Produces: `class PackageLayoutError extends Error { readonly issues: string[]; }`
- Produces: `async function verifyPackageLayout(root, { expectedNodeMajor = 24, runNode = true } = {})` returning `{ files: string[], nodeVersion: string | null }`.
- CLI: `node packaging/verify-layout.mjs <staging-root>` exits `0` on success and `1` with redacted issue lines on failure.

- [ ] **Step 1: Write failing Node tests**

Tests create temporary package trees and cover missing required files, forbidden user data, nested `.env`, API-key-shaped text, source/test artifacts, and a valid minimal layout. Required paths are:

```js
const required = [
  "AwaCode.exe",
  "runtime/node.exe",
  "runtime/LICENSE",
  "core/package.json",
  "core/dist/index.js",
  "core/node_modules/openai/package.json",
  "Qt6Core.dll",
  "Qt6Gui.dll",
  "Qt6Widgets.dll",
  "platforms/qwindows.dll",
];
```

Representative assertion:

```js
await assert.rejects(
  verifyPackageLayout(root, { runNode: false }),
  (error) => error instanceof PackageLayoutError
    && error.issues.some((issue) => issue.includes("auth.json")),
);
```

- [ ] **Step 2: Run the focused test to verify RED**

```powershell
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test packaging/test/package-layout.test.mjs
```

Expected: FAIL because the verifier module does not exist.

- [ ] **Step 3: Implement deterministic verification**

Walk without following symlinks, normalize relative paths to `/`, and sort output. Reject sensitive basenames anywhere, but reject application source/test paths only at the package root or directly under `core/`; production dependencies may legitimately ship their own `src` or `test` directories.

```js
const forbiddenBasenames = new Set([
  "auth.json", "config.json", "awacode.db", "awacode.db-wal", "awacode.db-shm", ".git",
]);
const forbiddenApplicationPrefixes = [
  "src/", "test/", "tests/", "desktop/", "core/src/", "core/test/", "core/tests/",
];
```

Reject `.env` and `.env.*`, application-owned `*.ts`, all `*.map`, and Qt test executables. Scan application-owned UTF-8 text files up to 2 MiB for `sk-` followed by at least 20 literal key characters or an `Authorization: Bearer` value containing at least 20 literal token characters. Do not secret-scan dependency implementation source under `core/node_modules`; dependency filenames and required package manifests are still verified. Never print matched secret text.

When `runNode` is true, spawn staged `runtime/node.exe --version`, require exit code `0`, and require major version `24`.

- [ ] **Step 4: Add and test the CLI wrapper**

The wrapper resolves the supplied root, invokes the library, prints only file count and Node version on success, and prints one redacted issue per line on failure.

Run the Step 2 test again and manually invoke the CLI against a test fixture. Expected: all tests pass; invalid layout exits `1` without secret contents.

- [ ] **Step 5: Commit**

```powershell
git add packaging/lib/package-layout.mjs packaging/verify-layout.mjs packaging/test/package-layout.test.mjs
git commit -m "test(packaging): verify distributable layout"
```

---

### Task 3: Safe Windows Staging Pipeline

**Files:**
- Create: `packaging/BuildContract.psm1`
- Create: `packaging/build-windows.ps1`
- Create: `packaging/test/build-contract.test.ps1`
- Modify: `.gitignore`
- Modify: `设计参考.md`

**Interfaces:**
- Produces PowerShell functions `Assert-SafeReleaseRoot`, `Resolve-RequiredTool`, `Get-NodeMajor`, and `Invoke-Checked` in `BuildContract.psm1`.
- CLI: `build-windows.ps1 -QtRoot <absolute-path> [-InnoCompiler <iscc.exe>] [-NodeArchive <zip>] [-Version 0.1.0] [-OutputRoot <repo/release>] [-SkipTests]`.
- Produces `release/stage/AwaCode/` and `release/release-manifest.json`; later tasks add final artifacts.

- [ ] **Step 1: Write the failing PowerShell contract test**

Create a plain PowerShell test without Pester. Import the module and assert:

```powershell
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$release = Join-Path $repo 'release'
Assert-SafeReleaseRoot -RepositoryRoot $repo -OutputRoot $release

$blocked = @($repo, (Split-Path $repo -Parent), (Join-Path $env:LOCALAPPDATA 'AwaCode'))
foreach ($candidate in $blocked) {
  $threw = $false
  try { Assert-SafeReleaseRoot -RepositoryRoot $repo -OutputRoot $candidate } catch { $threw = $true }
  if (-not $threw) { throw "Unsafe output root was accepted: $candidate" }
}
```

Also create fake `node23.cmd` and `node24.cmd` shims returning v23 and v24 to prove `Get-NodeMajor` and validation behavior.

- [ ] **Step 2: Run the contract test to verify RED**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\test\build-contract.test.ps1
```

Expected: FAIL because `BuildContract.psm1` is missing.

- [ ] **Step 3: Implement the safety module and make the test GREEN**

`Assert-SafeReleaseRoot` must resolve absolute paths, require the output to be exactly `<repository>\release` or a descendant, and reject equality with the repository root. `Resolve-RequiredTool` accepts only an existing file. `Invoke-Checked` invokes an executable with an argument array and throws with the executable name and exit code, without echoing environment secrets.

Run Step 2 again. Expected: PASS.

- [ ] **Step 4: Implement the build and staging script**

The script performs these exact operations in order:

1. Resolve repository/output paths and call `Assert-SafeReleaseRoot` before any removal.
2. Require Node major 24, Qt `bin\windeployqt.exe`, MinGW `bin\g++.exe`, CMake, Ninja, and Inno compiler unless only staging is requested.
3. Run Core `npm run verify` and `npm run build` unless `-SkipTests` is explicitly passed.
4. Configure `release/build-qt` with the explicit Qt/MinGW paths, build Release, and run `ctest` unless skipped.
5. Remove only validated `release/stage`, recreate `release/stage/AwaCode`, and copy the desktop EXE as `AwaCode.exe`.
6. Invoke the explicit Qt kit's `windeployqt.exe --release --compiler-runtime --dir <stage> <stage/AwaCode.exe>`.
7. Download `node-v24.19.0-win-x64.zip` and `SHASUMS256.txt` from `https://nodejs.org/dist/v24.19.0/` when `-NodeArchive` is absent; compare the archive hash with the exact published filename entry before extraction.
8. Copy only `node.exe` and `LICENSE` to `runtime/`.
9. Copy `core/package.json`, `core/package-lock.json`, and `core/dist/`; run the verified extracted Node distribution's `npm.cmd ci --omit=dev --ignore-scripts` in staged `core/`.
10. Copy applicable Node/Qt/dependency license notices and write `release-manifest.json` containing version, UTC build time, Node version, Qt version, architecture, and source commit hash, but no environment values.
11. Invoke `packaging/verify-layout.mjs` and stop on failure.

All external process calls use argument arrays. Network failures, missing checksum entries, tool-version mismatches, and invalid output roots terminate before artifacts are published.

- [ ] **Step 5: Ignore generated release contents and document the decision**

Add `/release/` to `.gitignore`. Add D34 to `设计参考.md`: installer and portable builds share a secret-checked staging tree; Node is pinned and checksum-verified; the Qt deploy tool is selected from explicit Qt root.

- [ ] **Step 6: Run focused checks and commit**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\test\build-contract.test.ps1
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test packaging/test/package-layout.test.mjs
git diff --check
```

```powershell
git add packaging/BuildContract.psm1 packaging/build-windows.ps1 packaging/test/build-contract.test.ps1 .gitignore 设计参考.md
git commit -m "build: stage self-contained windows application"
```

---

### Task 4: Inno Installer and Portable Artifact Definitions

**Files:**
- Create: `packaging/AwaCode.iss`
- Create: `packaging/test/installer-definition.test.mjs`
- Modify: `packaging/build-windows.ps1`
- Modify: `设计参考.md`

**Interfaces:**
- Inno compile-time defines: `/DAppVersion=<semver>`, `/DStageDir=<absolute-stage-path>`, `/DOutputDir=<absolute-output-path>`.
- Produces: `release/AwaCode-Setup-<version>-x64.exe` and `release/AwaCode-Portable-<version>-x64.zip`.

- [ ] **Step 1: Write the failing installer-definition test**

Read `packaging/AwaCode.iss` as text and assert the stable AppId, per-user privilege, install directory, x64 architecture, recursive staged files, Start Menu shortcut, optional desktop shortcut, uninstaller icon, close-app behavior, and absence of `[UninstallDelete]` entries targeting AwaCode user data.

```js
assert.match(source, /AppId=\{\{2D914859-8E35-4699-9E10-AE9F74D78E4A\}/i);
assert.match(source, /PrivilegesRequired=lowest/i);
assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\AwaCode/i);
assert.match(source, /Source: "\{#StageDir\}\\\*"; DestDir: "\{app\}"; Flags: ignoreversion recursesubdirs createallsubdirs/i);
assert.doesNotMatch(source, /\{localappdata\}\\AwaCode/i);
```

- [ ] **Step 2: Run the focused test to verify RED**

```powershell
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test packaging/test/installer-definition.test.mjs
```

Expected: FAIL because `AwaCode.iss` does not exist.

- [ ] **Step 3: Implement the Inno definition**

Use these required settings:

```ini
[Setup]
AppId={{2D914859-8E35-4699-9E10-AE9F74D78E4A}
AppName=AwaCode
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\AwaCode
DefaultGroupName=AwaCode
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=AwaCode-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
Uninstallable=yes
UninstallDisplayIcon={app}\AwaCode.exe

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Icons]
Name: "{autoprograms}\AwaCode"; Filename: "{app}\AwaCode.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\AwaCode"; Filename: "{app}\AwaCode.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\AwaCode.exe"; Description: "Launch AwaCode"; Flags: nowait postinstall skipifsilent
```

Define and validate all three preprocessor values before `[Setup]`. Do not add registry entries, services, file associations, environment-variable writes, user-data deletion, or model defaults.

- [ ] **Step 4: Extend the pipeline to publish both artifacts atomically**

After layout verification, create the ZIP in a temporary artifact directory, invoke `ISCC.exe` with the three defines, verify exact output filenames and nonzero sizes, compute SHA-256 for both, then move both to `release/`. If either build fails, publish neither final artifact.

- [ ] **Step 5: Run tests and commit**

```powershell
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test packaging/test/package-layout.test.mjs packaging/test/installer-definition.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\test\build-contract.test.ps1
git diff --check
```

```powershell
git add packaging/AwaCode.iss packaging/test/installer-definition.test.mjs packaging/build-windows.ps1 设计参考.md
git commit -m "build: create windows installer and portable zip"
```

---

### Task 5: Documentation and Real Artifact Verification

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `README.md`
- Modify: `README.txt`
- Modify: `设计参考.md`
- Generated, not committed: `release/AwaCode-Setup-0.1.0-x64.exe`
- Generated, not committed: `release/AwaCode-Portable-0.1.0-x64.zip`

**Interfaces:**
- Consumes the packaging CLI and artifacts from Tasks 3–4.
- Produces user-facing installation, portable launch, upgrade, uninstall, SmartScreen, data-preservation, and rebuild instructions.

- [ ] **Step 1: Install or resolve the official packaging compiler**

If `ISCC.exe` is absent, install Inno Setup 6 from its official distribution using the user's approved system package mechanism. Resolve the installed compiler explicitly; do not download or execute an unverified installer from a mirror.

- [ ] **Step 2: Run the complete packaging pipeline**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\build-windows.ps1 `
  -QtRoot "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64" `
  -InnoCompiler "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" `
  -Version "0.1.0"
```

Expected: Core and Qt verification pass; layout verifier passes; both versioned artifacts and SHA-256 values are produced.

- [ ] **Step 3: Perform portable smoke verification**

Extract the ZIP under a temporary path containing spaces and Chinese characters. From a different working directory:

```powershell
& "$portable\runtime\node.exe" --version
```

Expected: `v24.19.0`.

Start `$portable\AwaCode.exe`, confirm the process remains alive, Core hello completes, Settings opens without bundled credentials, and the application can select a temporary workspace. Close it normally and confirm no Node child remains.

- [ ] **Step 4: Perform installer and uninstaller smoke verification**

Run the installer normally. Confirm destination is `%LOCALAPPDATA%\Programs\AwaCode`, no UAC is requested, Start Menu entry exists, optional desktop shortcut works, Installed Apps lists AwaCode 0.1.0, and the installed application starts from a working directory outside its install folder.

Uninstall through Windows Installed Apps. Confirm program files and shortcuts are removed. Confirm the uninstaller did not delete `%LOCALAPPDATA%\AwaCode`; do not expose or copy its contents during this check.

- [ ] **Step 5: Update documentation to match the verified package**

Replace the manual deployment emphasis in `docs/DEPLOYMENT.md` with the one-command build, exact prerequisites, outputs, install location, portable use, unsigned SmartScreen warning, and clean-VM verification limitation. Add a short “Windows packaged release” section to `README.md`.

In `README.txt`, replace—not append to—the existing build-heavy run paragraph with a concise Setup/portable instruction so the file remains below 1000 Unicode code points. Count it after editing:

```powershell
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" -e "const fs=require('fs');const s=fs.readFileSync('README.txt','utf8');console.log([...s].length);if([...s].length>1000)process.exit(1)"
```

Record artifact hashes, actual sizes, exact verified tool versions, and the absence of code signing in `设计参考.md` without committing generated binaries.

- [ ] **Step 6: Run final repository verification**

```powershell
Push-Location core
npm run verify
Pop-Location
$env:PATH = "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64\bin;D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin;$env:PATH"
cmake --build desktop\build-qt6
ctest --test-dir desktop\build-qt6 --output-on-failure
& "C:\Users\47643\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" --test packaging/test/package-layout.test.mjs packaging/test/installer-definition.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging\test\build-contract.test.ps1
git diff --check
git status --short
```

Expected: all automated checks pass; only intended documentation changes are uncommitted before the final commit; `release/` is absent from Git status.

- [ ] **Step 7: Commit the verified delivery documentation**

```powershell
git add docs/DEPLOYMENT.md README.md README.txt 设计参考.md
git commit -m "docs: document windows installer delivery"
```

- [ ] **Step 8: Final handoff**

Report clickable local paths to both generated artifacts, SHA-256 hashes, sizes, automated test totals, portable/install/uninstall observations, and the explicit limitation that the installer is unsigned and has not been proven on hardware or Windows editions unavailable to the current environment.

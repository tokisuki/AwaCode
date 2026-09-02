# AwaCode Windows Packaging Design

Date: 2026-09-02
Status: approved direction, pending written-spec review

## Goal

Produce two x64 Windows deliverables from the same verified application payload:

- `AwaCode-Setup-0.1.0-x64.exe`: a conventional per-user offline installer.
- `AwaCode-Portable-0.1.0-x64.zip`: a self-contained directory archive that runs after extraction.

The target computer must not need Node.js, Qt, CMake, Ninja, npm, or administrator rights. The user supplies an OpenAI-compatible model configuration on first launch. No user data, API key, local model configuration, build cache, test binary, or source tree is included.

## Selected Approach

Use an explicit staging directory as the single source for both deliverables. Build the TypeScript Core and Qt desktop client, deploy the Qt runtime with the matching Qt 6.8 MinGW kit, add a pinned official Node.js 24 x64 runtime and production-only Core dependencies, verify the staged tree, then create the ZIP and compile an Inno Setup installer from that same tree.

Inno Setup is selected over MSI/WiX because AwaCode is a small consumer-style desktop application without enterprise policy, services, drivers, file associations, or multiple optional components. Qt Installer Framework is not selected because its component/update machinery is unnecessary for this delivery.

## Deliverable Layout

The staged and installed application tree is:

```text
AwaCode/
  AwaCode.exe
  Qt6Core.dll
  Qt6Gui.dll
  Qt6Widgets.dll
  platforms/qwindows.dll
  styles/...
  imageformats/...
  iconengines/...
  networkinformation/...
  tls/...
  runtime/node.exe
  runtime/LICENSE
  core/package.json
  core/dist/...
  core/node_modules/...
  LICENSES/...
```

Only files required at runtime are staged. TypeScript sources, tests, CMake files, Qt test executables, npm development dependencies, `.env` files, and repository metadata are excluded.

## Relocatable Application Startup

The installed executable must work regardless of the caller's current working directory. Desktop startup will resolve runtime paths in this order:

1. An explicit development/test override, when present.
2. Bundled paths relative to `QCoreApplication::applicationDirPath()`:
   - `runtime/node.exe`
   - `core/dist/index.js`
3. Existing development fallbacks for running from the repository.

The resolved Core entry is passed to `AgentProcessManager` as an absolute path. The bundled Node executable is preferred automatically, while the existing user override remains available for development and diagnostics. Missing runtime files must produce a clear desktop diagnostic and leave Run disabled rather than starting a partial installation.

Path selection logic will be isolated from `main()` so it can be unit tested with temporary directory layouts before production code is changed.

## Build Pipeline

A repository script, `packaging/build-windows.ps1`, will perform a clean, bounded build into an ignored `release/` directory.

1. Validate Windows x64, Node 24, the explicit Qt 6.8 MinGW root, CMake/Ninja, and Inno Setup compiler.
2. Run the existing Core type check and test suite, then build `core/dist`.
3. Configure and build only the Qt Release application with the supported MinGW 13.1 kit and run the Qt tests in the same runtime environment.
4. Create a new staging directory; never reuse the repository, Qt build tree, `%LOCALAPPDATA%\AwaCode`, or an unresolved path as a cleanup target.
5. Copy and rename the Release desktop executable to `AwaCode.exe`.
6. Invoke the matching kit's `windeployqt.exe --release --compiler-runtime` against the staged executable. PATH discovery must not select the Anaconda Qt installation.
7. Obtain the pinned official Node.js 24 Windows x64 archive, verify its SHA-256 value against the official checksum file, and stage the runtime executable and license. A caller-supplied verified archive may be used for offline rebuilds.
8. Install production-only Core dependencies into the staging tree from the lockfile and copy the built Core output.
9. Run a manifest and secret-exclusion verifier.
10. Create the portable ZIP from the verified staging tree.
11. Compile the Inno Setup script into the versioned Setup executable.

Build inputs such as Qt root, Inno compiler path, output directory, version, and optional Node archive are explicit parameters. The script fails before publishing either artifact if any required stage fails.

## Installer Behaviour

The Inno Setup definition uses a stable application GUID and x64-only install mode. It installs per user with `PrivilegesRequired=lowest` under:

```text
%LOCALAPPDATA%\Programs\AwaCode
```

The installer will:

- show product name, version, publisher, destination, progress, and completion pages;
- create a Start Menu shortcut;
- offer an optional desktop shortcut;
- register AwaCode in Windows Installed Apps;
- include a standard uninstaller;
- detect/close a running `AwaCode.exe` during upgrade;
- optionally launch AwaCode after installation;
- preserve the same application GUID across versions so upgrades replace program files in place.

There is no automatic updater in this scope. Installing an older version over a newer one is not a supported workflow.

## User Data and Security Boundaries

Application files and user data remain separate. Runtime data continues to live in `%LOCALAPPDATA%\AwaCode\`, including SQLite history, model configuration, credentials, and memory. The installer never reads, copies, exports, or writes those files.

Uninstall removes installed program files and shortcuts but preserves user data by default. This prevents an application uninstall from unexpectedly deleting conversations, credentials, or memory. Full data removal remains a separate, explicit manual action documented for the user.

The package verifier rejects at least:

- `auth.json`, `config.json`, `awacode.db`, SQLite WAL/SHM files, memory directories, `.env*`, `.git`, and build/test artifacts;
- source maps if they contain local source paths and are not required at runtime;
- API-key-shaped values in staged text files;
- absolute development paths embedded in launcher configuration.

The installer is initially unsigned. Documentation must state that Windows SmartScreen may warn until a trusted code-signing certificate is used. Signing is a release enhancement, not simulated with a self-signed production artifact.

## Versioning and Licensing

Version `0.1.0` is sourced consistently by the packaging script and installer metadata. Future builds update the version without changing the application GUID.

The package includes AwaCode's applicable license/notice plus redistributed Node.js, Qt, MinGW runtime, OpenAI client, and transitive production dependency notices. The build script records the exact Node and Qt versions used in a release manifest.

## Verification

Verification is proportional to the packaging risk:

1. Unit-test bundled/development runtime path resolution, missing-file diagnostics, and environment overrides.
2. Run `npm run verify` for Core and `ctest` for Qt before staging.
3. Verify the staging manifest contains the executable, bundled Node, Core entry, production dependencies, `platforms/qwindows.dll`, and required Qt/MinGW runtime DLLs.
4. Assert forbidden user/config/source/build files are absent.
5. Run bundled `node.exe --version` and require Node major version 24.
6. Start the bundled Core with a temporary `AWACODE_DATA_DIR`, perform a `core/hello` JSON-RPC probe, and close it cleanly without reading the user's real configuration.
7. Launch the portable GUI from a working directory outside the package and confirm it remains running with its bundled runtime.
8. Compile the installer, perform a test per-user install, launch the installed application, verify Installed Apps/uninstaller registration, then uninstall and confirm `%LOCALAPPDATA%\AwaCode` is preserved.
9. Inspect final artifact names, versions, hashes, and sizes; test the ZIP after extraction to a path containing spaces and Chinese characters.

The final handoff reports any verification that still requires a clean Windows VM. Passing only on the development machine is not described as universal compatibility.

## Repository Changes

Expected implementation files are limited to:

- a small, testable desktop runtime-path resolver and its Qt test;
- `packaging/build-windows.ps1`;
- `packaging/AwaCode.iss`;
- packaging assets and layout/secret verification;
- `.gitignore`, `docs/DEPLOYMENT.md`, `README.md`, `README.txt`, and `设计参考.md` updates required to describe the real packaged workflow.

Generated `release/` contents are ignored and are not committed. The final installer and portable archive are local delivery artifacts unless the user explicitly chooses a release hosting location.

## Out of Scope

- a single-file executable that embeds and extracts Qt, Node, and Core;
- ARM64 or 32-bit builds;
- MSI/GPO deployment;
- online update services or delta patching;
- automatic model configuration or bundled API credentials;
- deletion of user data during ordinary uninstall;
- code-signing certificate purchase or impersonation of a trusted signature.

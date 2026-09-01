# Task 13 — Qt 6 desktop console report

## Toolchain

- Qt: `D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64`
- Compiler: `D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin\g++.exe` (GCC/MinGW-w64 13.1.0)
- CMake/Ninja: `D:\mingw64\bin\cmake.exe` 3.26.4 and `D:\mingw64\bin\ninja.exe`
- Core verification runtime: bundled Node `v24.19.0`

All desktop CMake configurations explicitly used `CMAKE_PREFIX_PATH=D:/codes/AwaCode/.local/Qt/6.8.3/mingw_64` and `CMAKE_CXX_COMPILER=D:/codes/AwaCode/.local/Qt/Tools/mingw1310_64/bin/g++.exe`. No Anaconda Qt 5 or `D:\mingw64` compiler was used.

## RED / GREEN evidence

1. Transport/process RED:

   ```powershell
   & D:\mingw64\bin\cmake.exe --build desktop\build-qt6 --target awacode-desktop-test
   ```

   Expected RED observed: `fatal error: RpcCodec.h: No such file or directory`.

2. Expanded transport/process RED:

   ```powershell
   & D:\mingw64\bin\cmake.exe --build desktop\build-qt6
   ```

   Expected RED observed: missing `RpcCodec.h` and `AgentProcessManager.h` for the new Qt Tests.

3. Console/model RED:

   ```powershell
   & D:\mingw64\bin\cmake.exe --build desktop\build-qt6 --target awacode-main-window-test
   ```

   Expected RED observed: `fatal error: MainWindow.h: No such file or directory`.

4. Settings DTO RED:

   ```powershell
   .\desktop\build-qt6\awacode-dialogs-test.exe -o dialogs-test.log,txt
   ```

   Expected RED observed: `baseUrl != nullptr returned FALSE`; the original settings controls lacked the exact Core DTO surface.

5. Final Qt GREEN, from a clean, non-deployed build directory:

   ```powershell
   & D:\mingw64\bin\cmake.exe -S desktop -B desktop\build-qt6-test -G Ninja `
     "-DCMAKE_PREFIX_PATH=D:/codes/AwaCode/.local/Qt/6.8.3/mingw_64" `
     "-DCMAKE_CXX_COMPILER=D:/codes/AwaCode/.local/Qt/Tools/mingw1310_64/bin/g++.exe"
   & D:\mingw64\bin\cmake.exe --build desktop\build-qt6-test
   $env:PATH = "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64\bin;D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin;$env:PATH"
   $env:QT_QPA_PLATFORM = "offscreen"
   $env:QT_QPA_FONTDIR = "C:\Windows\Fonts"
   .\desktop\build-qt6-test\awacode-rpc-codec-test.exe
   .\desktop\build-qt6-test\awacode-process-manager-test.exe
   .\desktop\build-qt6-test\awacode-main-window-test.exe
   .\desktop\build-qt6-test\awacode-models-test.exe
   .\desktop\build-qt6-test\awacode-dialogs-test.exe
   ```

   Outcome: all five executables returned `0`: 3 RpcCodec assertions, 5 process-manager assertions, 5 main-window assertions, 4 model assertions, and 4 dialog assertions.

6. Core GREEN:

   ```powershell
   & $node24 .\node_modules\typescript\bin\tsc --noEmit -p tsconfig.typecheck.json
   & $node24 .\node_modules\typescript\bin\tsc -p tsconfig.json
   & $node24 --test
   ```

   Outcome: typecheck/build returned `0`; Node Test reported `337` passed, `0` failed, `5` platform-skipped. The built headless demo rehearsal passed its complete read → failing test → approvals → edit → passing test flow.

## Delivered behavior

- `RpcCodec` owns UTF-8 NDJSON framing, compact writes, fragmented input, CRLF, parse/line/EOF terminal failure state.
- `AgentProcessManager` starts the Node Core, preserves arbitrary JSON-RPC results (including Core's array-valued `session/list`), correlates `ui-*` requests, handles Core reverse approval requests, forwards stderr, clean EOF, and crashes.
- Qt Widgets desktop app has workspace/session controls, history loading, provisional stream batching at 16 ms, timeline entries, cancel, stderr panel, settings, native approval dialog, core crash preservation, and manual restart after a crash.
- Settings serialize the Core-authoritative `config/save` DTO and hide the API-key field; no key was supplied, stored, printed, or sought.
- README documents build, runtime PATH, run, and `windeployqt` deployment procedure. `设计参考.md` records the fixed kit, ownership boundaries, batching, crash behavior, and Core settings DTO.

## Commits

- `5b881ed feat(desktop): add qt transport and core process manager`
- `72d12ba feat(desktop): add qt agent console and timeline`
- `03b3dfa feat(desktop): integrate settings and deployment`

Fresh final verification after the third commit: all five Qt Test executables again returned `0` from `desktop/build-qt6-test`; Core typecheck, build, and dot-reporter test suite each returned `0` under Node 24.

## Manual integration evidence

- `windeployqt --no-translations --dir desktop\build-qt6 desktop\build-qt6\awacode-desktop.exe` completed successfully and deployed the Qt Widgets runtime dependencies for the application artifact.
- The real built Core was verified under Node 24 by the complete existing headless integration suite, including the fixed demo workflow. The desktop process manager was exercised against the deterministic fake Core for startup, notification, reverse approval, EOF, crash, and array-result protocol behavior.
- No real model was run because that would require a user-provided credential, which Task 13 forbids seeking or storing. With a blank data directory the real Core's authoritative `core/hello` reports unconfigured, and the desktop intentionally disables Run while retaining browsing/settings behavior.

## Self-review and concerns

- Confirmed `session/list` is a JSON array in Core handlers and fixed the initial object-coercion defect before final verification.
- Confirmed Settings previously emitted a non-authoritative nested `limits` DTO and fixed it to the exact Core parser contract, with a test that ensures no top-level key is emitted.
- Concern: on this Windows host, CTest's child-process DLL environment propagation was inconsistent (raw `ctest` exited `0xc0000135`; attempts to set CTest runtime PATH caused the `QProcess` fixture to hang). Direct Qt Test executables with the documented Qt/MinGW runtime PATH are green from a fresh build. This is a runner/deployment-environment concern, not a compile or test failure; the documented run/deploy procedure is the supported path.

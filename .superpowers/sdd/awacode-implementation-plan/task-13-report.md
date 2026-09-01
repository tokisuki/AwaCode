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

## Review fix round 1

### RED / GREEN

The focused MainWindow RED command was:

```powershell
& D:\mingw64\bin\cmake.exe --build desktop\build-qt6-round1 --target awacode-main-window-test
```

It failed to compile exactly because the intended APIs did not exist: `streamFlushed`, `receiveResponse`, `toolTimelineText`, `receiveError`, and `coreStopped`. The first run after adding the test and implementation also exposed the intended batching failure: `flushed.count()` was `2`, expected `1`; `stream/commit` had incorrectly performed a second timer-flush. The focused process RED, after building the deterministic fixture, reported `stopped(...)=true`, expected `false` for an unprompted normal EOF.

GREEN commands and outcomes:

```powershell
& D:\mingw64\bin\cmake.exe --build desktop\build-qt6-round1
$env:PATH = "D:\codes\AwaCode\.local\Qt\6.8.3\mingw_64\bin;D:\codes\AwaCode\.local\Qt\Tools\mingw1310_64\bin;$env:PATH"
$env:QT_QPA_PLATFORM = "offscreen"
$env:QT_QPA_FONTDIR = "C:\Windows\Fonts"
.\desktop\build-qt6-round1\awacode-rpc-codec-test.exe
.\desktop\build-qt6-round1\awacode-process-manager-test.exe
.\desktop\build-qt6-round1\awacode-main-window-test.exe
.\desktop\build-qt6-round1\awacode-models-test.exe
.\desktop\build-qt6-round1\awacode-dialogs-test.exe
```

All five returned `0`: the MainWindow suite has 9 passing checks and the process suite has 6, including exact reverse `allow_once` validation and unexpected EOF behavior.

Real Core / Qt-process rehearsal:

```powershell
$env:AWACODE_REAL_CORE_PROBE = (Resolve-Path .\desktop\build-qt6-round1\awacode-real-core-probe.exe)
& $env:AWACODE_NODE_PATH --experimental-strip-types .\desktop\test\real_core_integration.mjs
```

Outcome: exit `0`. The scripted provider served the deterministic eight-turn workflow. The actual Qt `AgentProcessManager` spawned real `core/dist/index.js`, selected workspace, created a session, auto-approved Core reverse permission requests, completed the five-tool edit workflow, closed/restarted Core, and display-only loaded the durable session without extra provider requests. The fixture workspace changed from `return 1` to `return 2`.

### Review self-review

- `session/load` now reads `MessageRecord.payload.text`, not an invented `content` field, and repopulates `ToolTimelineModel` from returned `toolCalls`.
- Stream state is retained per `messageId`; periodic timer work emits one `streamFlushed` signal for coalesced deltas, while commit changes the retained message from provisional to committed without duplicate rendering.
- All task-mutating controls are stored and disabled during busy state; cancel is the only enabled run-control.
- JSON-RPC error responses now clear pending-method state, render a bounded diagnostic, restore running state, and update a live Settings dialog when applicable.
- Settings fetch `config/status`, preserve stored credentials with `keep`, and display save/test result or Core-sanitized error.
- A normal Core exit is clean only after requested stdin closure; otherwise MainWindow preserves content and enables manual restart.

### Round 1 commits and final evidence

- `34b12a7 fix(desktop): recover session and stream state`
- `ef6e1ce test(desktop): exercise real core integration`

After `ef6e1ce`, the fresh Qt command rebuilt `desktop/build-qt6-round1` and returned `0` for RpcCodec, process manager, MainWindow, models, and dialogs; the same command ran `real_core_integration.mjs` and returned `0`. The fresh bundled-Node Core verification then returned `0` for typecheck, build, and full dot-reporter test suite.

cmake_minimum_required(VERSION 3.21)

project(AwaCodeDesktop VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Widgets Test)

enable_testing()

add_executable(awacode-rpc-codec-test
  test/tst_rpc_codec.cpp
  src/RpcCodec.cpp
)
target_include_directories(awacode-rpc-codec-test PRIVATE src)
target_link_libraries(awacode-rpc-codec-test PRIVATE Qt6::Test Qt6::Core)

add_executable(awacode-process-manager-test
  test/tst_agent_process_manager.cpp
  src/RpcCodec.cpp
  src/AgentProcessManager.cpp
)
target_include_directories(awacode-process-manager-test PRIVATE src)
target_link_libraries(awacode-process-manager-test PRIVATE Qt6::Test Qt6::Core Qt6::Widgets)
target_compile_definitions(awacode-process-manager-test PRIVATE
  AWACODE_FAKE_CORE_PATH="$<TARGET_FILE:awacode-fake-core>"
)

add_executable(awacode-fake-core test/fake_core.cpp)
target_link_libraries(awacode-fake-core PRIVATE Qt6::Core)

add_test(NAME awacode-rpc-codec-test COMMAND awacode-rpc-codec-test)
add_test(NAME awacode-process-manager-test COMMAND awacode-process-manager-test)
set_tests_properties(awacode-process-manager-test PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")

add_executable(awacode-main-window-test
  test/tst_main_window.cpp
  src/RpcCodec.cpp
  src/AgentProcessManager.cpp
  src/SessionListModel.cpp
  src/ToolTimelineModel.cpp
  src/ApprovalDialog.cpp
  src/SettingsDialog.cpp
  src/MainWindow.cpp
)
target_include_directories(awacode-main-window-test PRIVATE src)
target_link_libraries(awacode-main-window-test PRIVATE Qt6::Test Qt6::Core Qt6::Widgets)
add_test(NAME awacode-main-window-test COMMAND awacode-main-window-test)
set_tests_properties(awacode-main-window-test PROPERTIES ENVIRONMENT "QT_QPA_PLATFORM=offscreen")

add_executable(awacode-models-test
  test/tst_models.cpp
  src/SessionListModel.cpp
  src/ToolTimelineModel.cpp
)
target_include_directories(awacode-models-test PRIVATE src)
target_link_libraries(awacode-models-test PRIVATE Qt6::Test Qt6::Core)
add_test(NAME awacode-models-test COMMAND awacode-models-test)

add_executable(awacode-desktop
  src/main.cpp
  src/RpcCodec.cpp
  src/AgentProcessManager.cpp
  src/SessionListModel.cpp
  src/ToolTimelineModel.cpp
  src/ApprovalDialog.cpp
  src/SettingsDialog.cpp
  src/MainWindow.cpp
)
target_link_libraries(awacode-desktop PRIVATE Qt6::Widgets)

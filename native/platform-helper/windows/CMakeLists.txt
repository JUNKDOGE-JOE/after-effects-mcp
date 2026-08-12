cmake_minimum_required(VERSION 3.25)

project(ae_mcp_platform_helper_windows VERSION 0.9.5 LANGUAGES CXX)

if(NOT WIN32 OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "the Windows platform helper requires a native x64 Windows host")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# One Windows CRT policy across every shipped native binary (AEX, helper,
# launcher, transport addon): static CRT, so nothing binds a host-local or
# missing MSVCP140/VCRUNTIME140 (AE 2024 ships an older private copy that
# crashes current /MD binaries in std::mutex internals, and end-user machines
# may lack the redistributable entirely). Mirrors /MT in build-windows.mjs.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(ae-mcp-platform-helper WIN32 src/main.cpp)
target_compile_definitions(ae-mcp-platform-helper PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(ae-mcp-platform-helper PRIVATE
  Advapi32
  Crypt32
  Version
  Wintrust
  windowsapp
)

add_executable(ae-mcp-launcher WIN32 src/launcher.cpp)
target_compile_definitions(ae-mcp-launcher PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(ae-mcp-launcher PRIVATE Shell32)
set_target_properties(ae-mcp-launcher PROPERTIES OUTPUT_NAME "ae-mcp")

add_subdirectory(../client-addon client-addon)

install(TARGETS ae-mcp-platform-helper ae-mcp-launcher
  RUNTIME DESTINATION bin
)

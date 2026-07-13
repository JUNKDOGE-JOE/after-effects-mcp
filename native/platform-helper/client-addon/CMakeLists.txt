cmake_minimum_required(VERSION 3.25)

project(ae_mcp_platform_helper_transport VERSION 0.1.0 LANGUAGES CXX)

set(AE_MCP_NODE_VERSION "24.17.0" CACHE STRING "Locked Node.js header version")
if(NOT AE_MCP_NODE_VERSION STREQUAL "24.17.0")
  message(FATAL_ERROR "AE_MCP_NODE_VERSION must be the locked version 24.17.0")
endif()

set(NODE_INCLUDE_DIR "" CACHE PATH "Extracted include/node directory from the locked Node header asset")
if(NOT EXISTS "${NODE_INCLUDE_DIR}/node_api.h")
  message(FATAL_ERROR "NODE_INCLUDE_DIR must contain node_api.h from Node.js 24.17.0")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_library(ae-mcp-platform-helper-transport MODULE
  src/common.cpp
)
target_include_directories(ae-mcp-platform-helper-transport PRIVATE
  "${NODE_INCLUDE_DIR}"
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
)

if(APPLE)
  enable_language(OBJCXX)
  set(CMAKE_OSX_ARCHITECTURES "arm64")
  set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0")
  target_sources(ae-mcp-platform-helper-transport PRIVATE src/addon_macos.mm)
  target_compile_options(ae-mcp-platform-helper-transport PRIVATE
    $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
  )
  find_library(FOUNDATION_FRAMEWORK Foundation REQUIRED)
  target_link_libraries(ae-mcp-platform-helper-transport PRIVATE "${FOUNDATION_FRAMEWORK}")
elseif(WIN32)
  if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "the Windows platform helper transport requires x64")
  endif()
  set(NODE_IMPORT_LIBRARY "" CACHE FILEPATH "Locked Node.js 24.17.0 x64 import library")
  if(NOT EXISTS "${NODE_IMPORT_LIBRARY}")
    message(FATAL_ERROR "NODE_IMPORT_LIBRARY must name the locked Node.js 24.17.0 x64 node.lib")
  endif()
  target_sources(ae-mcp-platform-helper-transport PRIVATE
    src/addon_windows.cpp
    src/win_delay_load_hook.cpp
  )
  target_link_libraries(ae-mcp-platform-helper-transport PRIVATE
    "${NODE_IMPORT_LIBRARY}"
    bcrypt
    delayimp
  )
  target_link_options(ae-mcp-platform-helper-transport PRIVATE
    "/DELAYLOAD:node.exe"
    "/ignore:4199"
  )
else()
  message(FATAL_ERROR "the platform helper transport supports only macOS arm64 and Windows x64")
endif()

set_target_properties(ae-mcp-platform-helper-transport PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  OUTPUT_NAME "ae-mcp-platform-helper-transport"
)

install(TARGETS ae-mcp-platform-helper-transport
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION lib
)

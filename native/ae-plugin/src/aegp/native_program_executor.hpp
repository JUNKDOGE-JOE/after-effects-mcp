#pragma once

#include "aemcp_native/host_dispatcher.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>

namespace aemcp::native {

enum class HandleKind {
  kComposition,
  kLayer,
  kProperty,
};

// Composition and layer handles are borrowed from AE for the duration of one
// main-thread request. Property operations deliberately reacquire their
// disposable stream reference through the existing typed host helpers.
struct ScopedCompositionHandle {
  ObjectLocator locator;
  std::uintptr_t host_composition{0};
};

struct ScopedLayerHandle {
  HostResolvedLayer resolved;
};

struct ScopedPropertyHandle {
  ObjectLocator locator;
  ObjectLocator layer_locator;
  std::uintptr_t host_property{0};
};

using NativeHandle = std::variant<
    ScopedCompositionHandle,
    ScopedLayerHandle,
    ScopedPropertyHandle>;

class NativeHandleFrame final {
 public:
  NativeHandleFrame(
      std::string_view host_instance_id,
      std::string_view session_id);
  void save(std::string name, NativeHandle value);
  [[nodiscard]] const NativeHandle& require(
      std::string_view name, HandleKind expected) const;
  void clear() noexcept;
  [[nodiscard]] bool empty() const noexcept;
  [[nodiscard]] std::string_view host_instance_id() const noexcept;
  [[nodiscard]] std::string_view session_id() const noexcept;

 private:
  std::string host_instance_id_;
  std::string session_id_;
  std::unordered_map<std::string, NativeHandle> handles_;
};

struct NativeHandleResolveResult {
  bool ok{false};
  NativeHandle value;
  std::string error_code;
  std::string message;
  std::string error_field;

  [[nodiscard]] static NativeHandleResolveResult success(NativeHandle value);
  [[nodiscard]] static NativeHandleResolveResult failure(
      std::string code, std::string detail, std::string field = {});
};

class NativeProgramPrimitiveHost : public HostApi {
 public:
  [[nodiscard]] virtual NativeHandleResolveResult resolve_native_handle(
      HandleKind kind,
      const ObjectLocator& locator,
      const std::optional<ObjectLocator>& owner_locator,
      TimePoint work_deadline) = 0;
};

[[nodiscard]] NativeProgramHostResult execute_native_program(
    NativeProgramPrimitiveHost& host,
    const NativeProgram& program,
    std::string_view host_instance_id,
    std::string_view session_id,
    TimePoint work_deadline);

}  // namespace aemcp::native

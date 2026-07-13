#include "common.hpp"

#include <stdexcept>
#include <utility>
#include <vector>

namespace aemcp::platform_helper {
namespace {

struct TransportHolder {
  std::shared_ptr<PlatformTransport> transport;
};

enum class WorkOperation { kRequest, kClose };

struct AsyncWork {
  napi_async_work handle{};
  napi_deferred deferred{};
  std::shared_ptr<PlatformTransport> transport;
  WorkOperation operation{WorkOperation::kRequest};
  std::string input;
  std::string output;
  std::string error;
};

void Require(napi_status status, const char* message) {
  if (status != napi_ok) throw std::runtime_error(message);
}

std::string StringProperty(napi_env env, napi_value object, const char* name) {
  napi_value value;
  Require(napi_get_named_property(env, object, name, &value), "could not read transport option");
  napi_valuetype type;
  Require(napi_typeof(env, value, &type), "could not inspect transport option");
  if (type != napi_string) throw std::runtime_error("transport identity option is invalid");
  std::size_t bytes = 0;
  Require(
      napi_get_value_string_utf8(env, value, nullptr, 0, &bytes),
      "could not measure transport option");
  if (bytes == 0 || bytes > 32768) {
    throw std::runtime_error("transport identity option is invalid");
  }
  std::vector<char> buffer(bytes + 1, '\0');
  std::size_t copied = 0;
  Require(
      napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &copied),
      "could not read transport option");
  return std::string(buffer.data(), copied);
}

PlatformTransportOptions ReadTransportOptions(
    napi_env env,
    napi_callback_info info) {
  std::size_t argument_count = 1;
  napi_value arguments[1];
  Require(
      napi_get_cb_info(env, info, &argument_count, arguments, nullptr, nullptr),
      "could not read transport options");
  if (argument_count == 0) return {};
  napi_valuetype type;
  Require(napi_typeof(env, arguments[0], &type), "could not inspect transport options");
  if (type != napi_object) throw std::runtime_error("transport identity options are invalid");
  return {
      StringProperty(env, arguments[0], "expectedServerPath"),
      StringProperty(env, arguments[0], "expectedServerSha256"),
  };
}

napi_value ErrorValue(napi_env env, const std::string& message) {
  napi_value text;
  napi_value error;
  Require(
      napi_create_string_utf8(env, message.c_str(), message.size(), &text),
      "could not create native error text");
  Require(napi_create_error(env, nullptr, text, &error), "could not create native error");
  return error;
}

void Execute(napi_env, void* data) {
  auto* work = static_cast<AsyncWork*>(data);
  try {
    if (work->operation == WorkOperation::kRequest) {
      work->output = work->transport->Request(work->input);
      if (work->output.size() > kMaxMessageBytes) {
        throw std::runtime_error("platform helper response exceeds 65536 bytes");
      }
    } else {
      work->transport->Close();
    }
  } catch (const std::exception& exception) {
    work->error = exception.what();
  } catch (...) {
    work->error = "platform helper transport failed";
  }
}

void Complete(napi_env env, napi_status status, void* data) {
  auto* work = static_cast<AsyncWork*>(data);
  if (status != napi_ok && work->error.empty()) {
    work->error = "platform helper work was cancelled";
  }

  if (!work->error.empty()) {
    napi_reject_deferred(env, work->deferred, ErrorValue(env, work->error));
  } else if (work->operation == WorkOperation::kRequest) {
    napi_value result;
    if (napi_create_string_utf8(
            env, work->output.c_str(), work->output.size(), &result) == napi_ok) {
      napi_resolve_deferred(env, work->deferred, result);
    } else {
      napi_reject_deferred(
          env, work->deferred, ErrorValue(env, "could not create helper response"));
    }
  } else {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_resolve_deferred(env, work->deferred, undefined);
  }

  napi_delete_async_work(env, work->handle);
  delete work;
}

TransportHolder* Unwrap(
    napi_env env,
    napi_callback_info info,
    std::size_t* argument_count,
    napi_value* arguments) {
  napi_value receiver;
  Require(
      napi_get_cb_info(env, info, argument_count, arguments, &receiver, nullptr),
      "could not read transport call");
  TransportHolder* holder = nullptr;
  Require(napi_unwrap(env, receiver, reinterpret_cast<void**>(&holder)),
          "invalid platform helper transport receiver");
  if (holder == nullptr || !holder->transport) {
    throw std::runtime_error("platform helper transport is unavailable");
  }
  return holder;
}

napi_value Queue(
    napi_env env,
    const std::shared_ptr<PlatformTransport>& transport,
    WorkOperation operation,
    std::string input) {
  auto* work = new AsyncWork();
  work->transport = transport;
  work->operation = operation;
  work->input = std::move(input);

  napi_value promise;
  napi_value resource_name;
  try {
    Require(napi_create_promise(env, &work->deferred, &promise), "could not create promise");
    Require(
        napi_create_string_utf8(
            env, "platform-helper-request", NAPI_AUTO_LENGTH, &resource_name),
        "could not create work name");
    Require(
        napi_create_async_work(
            env, nullptr, resource_name, Execute, Complete, work, &work->handle),
        "could not create native work");
    Require(napi_queue_async_work(env, work->handle), "could not queue native work");
    return promise;
  } catch (...) {
    if (work->handle != nullptr) napi_delete_async_work(env, work->handle);
    delete work;
    throw;
  }
}

napi_value Request(napi_env env, napi_callback_info info) {
  try {
    std::size_t argument_count = 1;
    napi_value arguments[1];
    TransportHolder* holder = Unwrap(env, info, &argument_count, arguments);
    if (argument_count != 1) throw std::runtime_error("request expects one JSON string");
    napi_valuetype type;
    Require(napi_typeof(env, arguments[0], &type), "could not inspect request");
    if (type != napi_string) throw std::runtime_error("request expects one JSON string");
    std::size_t bytes = 0;
    Require(
        napi_get_value_string_utf8(env, arguments[0], nullptr, 0, &bytes),
        "could not measure request");
    if (bytes > kMaxMessageBytes) {
      throw std::runtime_error("platform helper request exceeds 65536 bytes");
    }
    std::vector<char> input_buffer(bytes + 1, '\0');
    std::size_t copied = 0;
    Require(
        napi_get_value_string_utf8(
            env, arguments[0], input_buffer.data(), input_buffer.size(), &copied),
        "could not read request");
    std::string input(input_buffer.data(), copied);
    return Queue(env, holder->transport, WorkOperation::kRequest, std::move(input));
  } catch (const std::exception& exception) {
    napi_throw_error(env, nullptr, exception.what());
    return nullptr;
  }
}

napi_value Close(napi_env env, napi_callback_info info) {
  try {
    std::size_t argument_count = 0;
    TransportHolder* holder = Unwrap(env, info, &argument_count, nullptr);
    const auto transport = holder->transport;
    transport->Cancel();
    return Queue(env, transport, WorkOperation::kClose, {});
  } catch (const std::exception& exception) {
    napi_throw_error(env, nullptr, exception.what());
    return nullptr;
  }
}

void Finalize(napi_env, void* data, void*) {
  delete static_cast<TransportHolder*>(data);
}

}  // namespace

napi_value CreateTransport(napi_env env, napi_callback_info info) {
  try {
    napi_value object;
    Require(napi_create_object(env, &object), "could not create transport object");
    napi_property_descriptor properties[] = {
        {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Require(
        napi_define_properties(env, object, 2, properties),
        "could not define transport functions");
    const PlatformTransportOptions options = ReadTransportOptions(env, info);
    auto holder = std::make_unique<TransportHolder>(
        TransportHolder{CreatePlatformTransport(options)});
    Require(napi_wrap(env, object, holder.get(), Finalize, nullptr, nullptr),
            "could not retain native transport");
    holder.release();
    return object;
  } catch (const std::exception& exception) {
    napi_throw_error(env, nullptr, exception.what());
    return nullptr;
  }
}

napi_value InitializeAddon(napi_env env, napi_value exports) {
  napi_value factory;
  Require(
      napi_create_function(env, "createTransport", NAPI_AUTO_LENGTH, CreateTransport, nullptr, &factory),
      "could not create transport factory");
  Require(
      napi_set_named_property(env, exports, "createTransport", factory),
      "could not export transport factory");
  return exports;
}

}  // namespace aemcp::platform_helper

#include "aemcp_native/rpc_codec.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace {

using aemcp::native::rpc::CapabilitiesParams;
using aemcp::native::rpc::CapabilitiesSuccess;
using aemcp::native::rpc::CompositionLayersSuccess;
using aemcp::native::rpc::CompositionSelectedLayersSuccess;
using aemcp::native::rpc::CompositionTimeSuccess;
using aemcp::native::rpc::CompositionTimeSetSuccess;
using aemcp::native::rpc::ProjectContextSuccess;
using aemcp::native::rpc::ProjectItemMetadataSuccess;
using aemcp::native::rpc::CompositionSettingsSuccess;
using aemcp::native::rpc::CompositionWorkAreaSetSuccess;
using aemcp::native::rpc::ProjectItemNameSetSuccess;
using aemcp::native::rpc::ProjectItemCommentSetSuccess;
using aemcp::native::rpc::ProjectItemLabelSetSuccess;
using aemcp::native::rpc::CompositionDuplicateSuccess;
using aemcp::native::rpc::LayerDetailsSuccess;
using aemcp::native::rpc::LayerNameSetSuccess;
using aemcp::native::rpc::LayerRangeSetSuccess;
using aemcp::native::rpc::LayerStartTimeSetSuccess;
using aemcp::native::rpc::LayerStretchSetSuccess;
using aemcp::native::rpc::LayerOrderSetSuccess;
using aemcp::native::rpc::LayerParentSetSuccess;
using aemcp::native::rpc::LayerDuplicateSuccess;
using aemcp::native::rpc::CompositionCreateSuccess;
using aemcp::native::rpc::CompositionLayerCreateSuccess;
using aemcp::native::rpc::LayerEffectApplySuccess;
using aemcp::native::rpc::LayerPropertiesSuccess;
using aemcp::native::rpc::LayerPropertyKeyframesSuccess;
using aemcp::native::rpc::LayerPropertySetSuccess;
using aemcp::native::rpc::CapabilityDetail;
using aemcp::native::rpc::CancelState;
using aemcp::native::rpc::CancelSuccess;
using aemcp::native::rpc::CodecError;
using aemcp::native::rpc::ErrorDetails;
using aemcp::native::rpc::ErrorResponse;
using aemcp::native::rpc::FrameDecoder;
using aemcp::native::rpc::HelloParams;
using aemcp::native::rpc::HelloSuccess;
using aemcp::native::rpc::InvalidateGraphParams;
using aemcp::native::rpc::InvokeParams;
using aemcp::native::rpc::ParsedRequest;
using aemcp::native::rpc::ProgressEvent;
using aemcp::native::rpc::ProgressPhase;
using aemcp::native::rpc::ProjectBitDepthReadSuccess;
using aemcp::native::rpc::ProjectBitDepthSetSuccess;
using aemcp::native::rpc::ProjectGraphInvalidateSuccess;
using aemcp::native::rpc::ProjectItemsSuccess;
using aemcp::native::rpc::ProjectSummarySuccess;
using aemcp::native::rpc::RpcErrorCode;
using aemcp::native::rpc::RpcMethod;
using aemcp::native::rpc::RpcSessionFrontDoor;
using aemcp::native::rpc::SessionClock;
using aemcp::native::rpc::SessionFrontDoorConfig;
using aemcp::native::rpc::SessionIngressCode;
using aemcp::native::rpc::decode_request_frame;
using aemcp::native::rpc::digest_capabilities_query;
using aemcp::native::rpc::digest_project_bit_depth_read_postcondition;
using aemcp::native::rpc::digest_project_bit_depth_set_arguments;
using aemcp::native::rpc::digest_project_bit_depth_set_postcondition;
using aemcp::native::rpc::digest_project_summary_postcondition;
using aemcp::native::rpc::digest_composition_layers_postcondition;
using aemcp::native::rpc::digest_composition_selected_layers_postcondition;
using aemcp::native::rpc::digest_composition_time_postcondition;
using aemcp::native::rpc::digest_composition_time_set_postcondition;
using aemcp::native::rpc::digest_composition_create_postcondition;
using aemcp::native::rpc::digest_layer_details_postcondition;
using aemcp::native::rpc::digest_layer_name_set_postcondition;
using aemcp::native::rpc::digest_layer_range_set_postcondition;
using aemcp::native::rpc::digest_layer_start_time_set_postcondition;
using aemcp::native::rpc::digest_layer_stretch_set_postcondition;
using aemcp::native::rpc::digest_layer_order_set_postcondition;
using aemcp::native::rpc::digest_layer_parent_set_postcondition;
using aemcp::native::rpc::digest_layer_duplicate_postcondition;
using aemcp::native::rpc::composition_create_persistent_diagnostic_fields;
using aemcp::native::rpc::project_context_persistent_diagnostic_fields;
using aemcp::native::rpc::project_item_metadata_persistent_diagnostic_fields;
using aemcp::native::rpc::composition_settings_persistent_diagnostic_fields;
using aemcp::native::rpc::composition_work_area_persistent_diagnostic_fields;
using aemcp::native::rpc::project_item_name_persistent_diagnostic_fields;
using aemcp::native::rpc::project_item_comment_persistent_diagnostic_fields;
using aemcp::native::rpc::project_item_label_persistent_diagnostic_fields;
using aemcp::native::rpc::composition_duplicate_persistent_diagnostic_fields;
using aemcp::native::rpc::digest_composition_layer_create_postcondition;
using aemcp::native::rpc::digest_layer_effect_apply_postcondition;
using aemcp::native::rpc::digest_layer_properties_postcondition;
using aemcp::native::rpc::digest_layer_property_keyframes_postcondition;
using aemcp::native::rpc::digest_layer_property_set_postcondition;
using aemcp::native::rpc::digest_project_items_postcondition;
using aemcp::native::rpc::encode_capabilities_success;
using aemcp::native::rpc::encode_cancel_success;
using aemcp::native::rpc::encode_error_response;
using aemcp::native::rpc::encode_hello_success;
using aemcp::native::rpc::encode_progress_event;
using aemcp::native::rpc::encode_project_bit_depth_read_success;
using aemcp::native::rpc::encode_project_bit_depth_set_success;
using aemcp::native::rpc::encode_project_graph_invalidate_success;
using aemcp::native::rpc::encode_project_summary_success;
using aemcp::native::rpc::encode_composition_layers_success;
using aemcp::native::rpc::encode_composition_selected_layers_success;
using aemcp::native::rpc::encode_composition_time_success;
using aemcp::native::rpc::encode_composition_time_set_success;
using aemcp::native::rpc::encode_project_context_success;
using aemcp::native::rpc::encode_project_item_metadata_success;
using aemcp::native::rpc::encode_composition_settings_success;
using aemcp::native::rpc::encode_composition_work_area_set_success;
using aemcp::native::rpc::encode_project_item_name_set_success;
using aemcp::native::rpc::encode_project_item_comment_set_success;
using aemcp::native::rpc::encode_project_item_label_set_success;
using aemcp::native::rpc::encode_composition_duplicate_success;
using aemcp::native::rpc::encode_layer_details_success;
using aemcp::native::rpc::encode_layer_name_set_success;
using aemcp::native::rpc::encode_layer_range_set_success;
using aemcp::native::rpc::encode_layer_start_time_set_success;
using aemcp::native::rpc::encode_layer_stretch_set_success;
using aemcp::native::rpc::encode_layer_order_set_success;
using aemcp::native::rpc::encode_layer_parent_set_success;
using aemcp::native::rpc::encode_layer_duplicate_success;
using aemcp::native::rpc::encode_composition_create_success;
using aemcp::native::rpc::encode_composition_layer_create_success;
using aemcp::native::rpc::encode_layer_effect_apply_success;
using aemcp::native::rpc::encode_layer_properties_success;
using aemcp::native::rpc::encode_layer_property_keyframes_success;
using aemcp::native::rpc::encode_layer_property_set_success;
using aemcp::native::rpc::encode_project_items_success;
using aemcp::native::rpc::kMaxFrameBytes;

constexpr std::string_view kSession = "11111111-1111-4111-8111-111111111111";
constexpr std::string_view kHost = "22222222-2222-4222-8222-222222222222";
constexpr std::string_view kClient = "33333333-3333-4333-8333-333333333333";
constexpr std::string_view kDigest = "778a01733fcf37510f56894a46ec5bd87c7429de2e06d2d5eafb4cdbbae88557";
constexpr std::string_view kContractDigest = "baecd602479045f71288b2a7e0df645d4a5313453a34b89ced07178867ccaf9a";
constexpr std::string_view kProjectBitDepthReadContractDigest =
    "936b86f89c99418bb570b9671569951ee10177efa70e8f4b72303a01dba0db6e";
constexpr std::string_view kProjectBitDepthSetContractDigest =
    "d5d11180b22293db667353e0861485e1633c2881ed96891744fd94d69910d80a";
constexpr std::string_view kProjectItemsContractDigest =
    "64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e";
constexpr std::string_view kCompositionLayersContractDigest =
    "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75";
constexpr std::string_view kCompositionTimeContractDigest =
    "fda1027148fb5bd49cba6bc6f2b4b3264d38d9b8958a6cb34a19ec14048b8acd";
constexpr std::string_view kCompositionTimeSetContractDigest =
    "724a779959a13e56fc679d3a9ad961708fadd535e3fbbf88abd33393530d3308";
constexpr std::string_view kCompositionCreateContractDigest =
    "0e65175a0d85640eda3eb58b08d4cabc0aa9f085068225e1b44f9cf01467310d";
constexpr std::string_view kCompositionLayerCreateContractDigest =
    "d48b5c0fcf9871ee579bf518679bc36277e2fd5194e70d9cc6fa1b2c573edeee";
constexpr std::string_view kLayerEffectApplyContractDigest =
    "5de12c7cd4ede09122a837c85ff2e589f695dd5377490b97b9de9d975ce00d77";
constexpr std::string_view kLayerPropertiesContractDigest =
    "a687dc451eec34cc7425c382750bccb9882aa257785dd538a26d61a5689cf0ba";
constexpr std::string_view kLayerPropertyKeyframesContractDigest =
    "f089d4cd1d35f492df660cbd83667968b2add70b5353172253691e33758e42bb";
constexpr std::string_view kLayerPropertySetContractDigest =
    "5cb9b24ac33125823b08d1dcc43839bf1b568fd02da22b8fb3c30bb3c722689c";
constexpr std::string_view kProjectContextReadContractDigest =
    "ee6df463fe36f13a02a09b833b0f13a01ba1c2a5dc335d689c04ea834ad10dca";
constexpr std::string_view kProjectItemMetadataReadContractDigest =
    "b13139c0b2e8073f6606bfbead1e59eb7fea63ec10a164b500e19ff8babd0f69";
constexpr std::string_view kCompositionSettingsReadContractDigest =
    "a7ae9383b4a627bf6f3f42cb929eafa724cf7bc30a172b67ddbcaf9e754f5e9b";
constexpr std::string_view kCompositionWorkAreaSetContractDigest =
    "a4ffd90349164e1d7228e5d2374ef55c9f0dc1065db0dac9945a7f8eeb16b997";
constexpr std::string_view kProjectItemNameSetContractDigest =
    "b26f017991e74f009b15cb24fcfd4bb7f154d4ac506f65f150b29efcccb9f538";
constexpr std::string_view kProjectItemCommentSetContractDigest =
    "957985628474caa9c9cef3de76a2839e59691232b062b776ff800a79dd3cc35c";
constexpr std::string_view kProjectItemLabelSetContractDigest =
    "4463637f6a5298b27afb39cea68c593a93383e4ccc7926bc228d00e0cc3ba94f";
constexpr std::string_view kCompositionDuplicateContractDigest =
    "96e7a14f7e2b983fac41a918657b101f54638d5ae6acee6003757bc6458b3be3";
constexpr std::string_view kLayerDetailsContractDigest =
    "b1b7a5f313bbf72eb6b33ac4a0507f9f925ef6873d53fd07d93d861164ac15d9";
constexpr std::string_view kLayerNameContractDigest =
    "a68fb7f75f050faf4e77c81c3fa9f53ad501016af0eeb065493716ff94fd5929";
constexpr std::string_view kLayerRangeContractDigest =
    "0b90618916f0df612726017ef80795b72829f367cbf46cad23b33beb129230e2";
constexpr std::string_view kLayerStartTimeContractDigest =
    "c0c09292b98f5fecfb69a487f2014aed6ce2b67d47f07231beea36d916e07e27";
constexpr std::string_view kLayerStretchContractDigest =
    "0545a85e87d8907f94597ba36e3021fd3fa6dfe1262ff0e81eb30551f5e3bbb8";
constexpr std::string_view kLayerOrderContractDigest =
    "e977b89201314e2e4ee1b6e7a09efadd06f012b2b97e3087b0d9c4bd8102d162";
constexpr std::string_view kLayerParentContractDigest =
    "36414bc469a83ddeadbf9f722e934266b38f26a70352c24f5e4a57800f2bb06c";
constexpr std::string_view kLayerDuplicateContractDigest =
    "334a4371a4ac610f02d5dc1d525526ab54cfb1aea758a31434e1c0b196d76c75";
constexpr std::string_view kCapabilitiesRegistryDigest =
    "53e3b7974e797b088aa1dd25d600a2506f59fed0d11c34ca8249e87dcf3ee4a1";

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "FAIL: " << message << '\n';
  std::exit(1);
}

void require(bool condition, const std::string& message) {
  if (!condition) fail(message);
}

std::vector<std::uint8_t> frame(std::string_view json) {
  require(json.size() <= kMaxFrameBytes, "test frame exceeds protocol limit");
  std::vector<std::uint8_t> result(json.size() + 4);
  const auto size = static_cast<std::uint32_t>(json.size());
  result[0] = static_cast<std::uint8_t>(size >> 24U);
  result[1] = static_cast<std::uint8_t>(size >> 16U);
  result[2] = static_cast<std::uint8_t>(size >> 8U);
  result[3] = static_cast<std::uint8_t>(size);
  std::memcpy(result.data() + 4, json.data(), json.size());
  return result;
}

std::string body(const std::vector<std::uint8_t>& framed) {
  require(framed.size() >= 4, "encoded output has no prefix");
  const std::uint32_t size = (static_cast<std::uint32_t>(framed[0]) << 24U)
      | (static_cast<std::uint32_t>(framed[1]) << 16U)
      | (static_cast<std::uint32_t>(framed[2]) << 8U)
      | static_cast<std::uint32_t>(framed[3]);
  require(size == framed.size() - 4, "encoded output prefix does not match body");
  return std::string(reinterpret_cast<const char*>(framed.data() + 4), size);
}

template <typename Callable>
void expect_codec_error(Callable&& callable, std::string_view code, const std::string& label) {
  try {
    callable();
  } catch (const CodecError& error) {
    require(error.error_code() == code, label + " returned " + std::string(error.error_code()));
    return;
  }
  fail(label + " was accepted");
}

template <typename Callable>
void expect_argument_error(Callable&& callable, const std::string& label) {
  try {
    callable();
  } catch (const std::invalid_argument&) {
    return;
  } catch (const CodecError& error) {
    require(error.error_code() == "INVALID_ARGUMENT", label + " returned wrong codec error");
    return;
  }
  fail(label + " was accepted");
}

std::string hello_json(std::uint16_t minimum = 1, std::uint16_t maximum = 1) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"requestId\":\"hello-1\","
      "\"method\":\"hello\",\"params\":{\"supportedWireVersions\":{\"minimum\":"
      + std::to_string(minimum) + ",\"maximum\":" + std::to_string(maximum)
      + "},\"client\":{\"component\":\"core-broker\",\"version\":\"0.9.2\","
        "\"instanceId\":\"" + std::string(kClient)
      + "\"},\"nonce\":\"abcdefghijklmnopqrstuvwxyzABCDEF\"}}";
}

std::string invoke_json(
    std::string_view request_id = "invoke-summary-1",
    std::uint64_t deadline = 1'900'000'005'000ULL,
    std::string_view arguments = "{}") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":" + std::to_string(deadline)
      + ",\"params\":{\"capabilityId\":\"ae.project.summary\","
        "\"capabilityVersion\":1,\"arguments\":" + std::string(arguments) + "}}";
}

std::string package150_invoke_json(
    std::string_view request_id,
    std::string_view capability_id,
    std::string_view arguments) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"" + std::string(capability_id)
      + "\",\"capabilityVersion\":1,\"arguments\":" + std::string(arguments) + "}}";
}

std::string invalidate_graph_json(
    std::string_view request_id = "invalidate-graph-1",
    std::string_view params = "{\"reason\":\"cep-jsx\"}") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invalidateGraph\",\"params\":" + std::string(params) + "}";
}

std::string bit_depth_read_invoke_json(
    std::string_view request_id = "invoke-bit-depth-read-1",
    std::string_view arguments = "{}") {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.bit-depth.read\","
        "\"capabilityVersion\":1,\"arguments\":" + std::string(arguments) + "}}";
}

std::string bit_depth_set_invoke_json(
    std::string_view request_id = "invoke-bit-depth-set-1",
    std::string_view target_depth = "16",
    std::string_view idempotency_key = "bit-depth-intent-001",
    std::string_view extra = {}) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.bit-depth.set\","
        "\"capabilityVersion\":1,\"arguments\":{\"targetDepth\":"
      + std::string(target_depth) + ",\"idempotencyKey\":\""
      + std::string(idempotency_key) + "\"" + std::string(extra) + "}}}";
}

std::string locator_json(
    std::string_view kind,
    std::string_view object_id,
    std::string_view session_id = kSession) {
  return "{\"kind\":\"" + std::string(kind) + "\",\"hostInstanceId\":\""
      + std::string(kHost) + "\",\"sessionId\":\"" + std::string(session_id)
      + "\",\"projectId\":\"44444444-4444-4444-8444-444444444444\","
        "\"generation\":8,\"objectId\":\"" + std::string(object_id) + "\"}";
}

aemcp::native::ObjectLocator locator(std::string kind, std::string object_id) {
  return {
      std::move(kind),
      std::string(kHost),
      std::string(kSession),
      "44444444-4444-4444-8444-444444444444",
      8,
      std::move(object_id)};
}

std::string project_items_invoke_json(
    std::string_view request_id = "invoke-project-items-1",
    std::uint64_t offset = 0,
    std::uint16_t limit = 25,
    std::string_view project_locator = {}) {
  std::string arguments = "{\"offset\":" + std::to_string(offset)
      + ",\"limit\":" + std::to_string(limit);
  if (!project_locator.empty()) {
    arguments += ",\"projectLocator\":" + std::string(project_locator);
  }
  arguments.push_back('}');
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.project.items.list\","
        "\"capabilityVersion\":1,\"arguments\":" + arguments + "}}";
}

std::string composition_layers_invoke_json(
    std::string_view request_id = "invoke-composition-layers-1",
    std::string_view composition_locator = {}) {
  const std::string locator_value = composition_locator.empty()
      ? locator_json("composition", "66666666-6666-4666-8666-666666666666")
      : std::string(composition_locator);
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.layers.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + locator_value + ",\"offset\":0,\"limit\":25}}}";
}

std::string composition_selected_layers_invoke_json(
    std::string_view request_id = "invoke-composition-selected-layers-1",
    std::string_view composition_locator = {}) {
  const std::string locator_value = composition_locator.empty()
      ? locator_json("composition", "66666666-6666-4666-8666-666666666666")
      : std::string(composition_locator);
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.selected-layers.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + locator_value + ",\"offset\":0,\"limit\":25}}}";
}

std::string composition_time_invoke_json(
    std::string_view request_id = "invoke-composition-time-1",
    std::string_view composition_locator = {},
    std::string_view extra = {}) {
  const std::string locator_value = composition_locator.empty()
      ? locator_json("composition", "66666666-6666-4666-8666-666666666666")
      : std::string(composition_locator);
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.time.read\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + locator_value + std::string(extra) + "}}}";
}

std::string composition_layer_create_invoke_json(
    std::string_view request_id = "invoke-composition-layer-create-1",
    std::string_view arguments_suffix = {}) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.layer.create\","
        "\"capabilityVersion\":1,\"arguments\":{\"compositionLocator\":"
      + locator_json("composition", "66666666-6666-4666-8666-666666666666")
      + ",\"kind\":\"solid\",\"name\":\"SYNTHETIC_SOLID\","
        "\"color\":{\"red\":12,\"green\":34,\"blue\":56,\"alpha\":255},"
        "\"width\":640,\"height\":360,\"duration\":{\"value\":5,\"scale\":1},"
        "\"idempotencyKey\":\"synthetic-layer-create-0001\""
      + std::string(arguments_suffix) + "}}}";
}

std::string layer_effect_apply_invoke_json(
    std::string_view request_id = "invoke-layer-effect-apply-1",
    std::string_view arguments_suffix = {}) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.effect.apply\","
        "\"capabilityVersion\":1,\"arguments\":{\"layerLocator\":"
      + locator_json("layer", "88888888-8888-4888-8888-888888888888")
      + ",\"effectMatchName\":\"ADBE Slider Control\","
        "\"idempotencyKey\":\"synthetic-effect-apply-0001\""
      + std::string(arguments_suffix) + "}}}";
}

std::string composition_create_invoke_json(
    std::string_view request_id = "invoke-composition-create-1",
    std::string_view arguments_suffix = {}) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.composition.create\","
        "\"capabilityVersion\":1,\"arguments\":{\"name\":\"SYNTHETIC_COMP\","
        "\"width\":1920,\"height\":1080,\"duration\":{\"value\":5,\"scale\":1},"
        "\"frameRate\":{\"numerator\":24,\"denominator\":1},"
        "\"pixelAspectRatio\":{\"numerator\":1,\"denominator\":1},"
        "\"idempotencyKey\":\"synthetic-comp-create-0001\""
      + std::string(arguments_suffix) + "}}}";
}

std::string layer_properties_invoke_json(
    std::string_view request_id = "invoke-layer-properties-1",
    std::string_view parent_property_locator = {}) {
  std::string arguments = "{\"layerLocator\":"
      + locator_json("layer", "88888888-8888-4888-8888-888888888888");
  if (!parent_property_locator.empty()) {
    arguments += ",\"parentPropertyLocator\":" + std::string(parent_property_locator);
  }
  arguments += ",\"offset\":0,\"limit\":25}";
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.properties.list\","
        "\"capabilityVersion\":1,\"arguments\":" + arguments + "}}";
}

std::string layer_property_keyframes_invoke_json(
    std::string_view request_id = "invoke-layer-property-keyframes-1",
    std::string_view arguments_suffix = {}) {
  return "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"" + std::string(request_id)
      + "\",\"method\":\"invoke\",\"deadlineUnixMs\":1900000005000,"
        "\"params\":{\"capabilityId\":\"ae.layer.property.keyframes.list\","
        "\"capabilityVersion\":1,\"arguments\":{\"propertyLocator\":"
      + locator_json("stream", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
      + ",\"offset\":0,\"limit\":2" + std::string(arguments_suffix) + "}}}";
}

void golden_requests_are_typed_and_closed() {
  const ParsedRequest hello = decode_request_frame(frame(hello_json()));
  require(hello.method == RpcMethod::kHello && !hello.session_id.has_value(), "hello classification failed");
  const auto& hello_params = std::get<HelloParams>(hello.params);
  require(hello_params.minimum_wire_version == 1 && hello_params.maximum_wire_version == 1,
      "hello wire range changed");
  require(hello_params.client_instance_id == kClient && hello_params.nonce.size() == 32,
      "hello identity changed");
  require(hello.request_fingerprint_sha256
      == "a8b609ec240f4b730c6b4b5b17a68be4aa94ba568562b74036b55aa83ab5f336",
      "hello normalized SHA-256 changed");
  require(decode_request_frame(frame(" \n" + hello_json() + "\t")).request_fingerprint_sha256
      == hello.request_fingerprint_sha256,
      "insignificant JSON whitespace changed the request digest");

  const std::string capabilities_json = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"capabilities-1\",\"method\":\"capabilities\","
        "\"params\":{\"ids\":[\"ae.project.summary\"],\"detail\":\"full\",\"limit\":1}}";
  const ParsedRequest capabilities = decode_request_frame(frame(capabilities_json));
  const auto& capabilities_params = std::get<CapabilitiesParams>(capabilities.params);
  require(capabilities.method == RpcMethod::kCapabilities
      && capabilities_params.detail == CapabilityDetail::kFull
      && capabilities_params.detail_was_provided && capabilities_params.limit == 1
      && capabilities_params.limit_was_provided && capabilities_params.ids->size() == 1,
      "capabilities golden vector changed");
  require(digest_capabilities_query(*capabilities.session_id, capabilities_params)
      == "aa3c66bc21e50b6a35db9c3cb12fcb1627694cd8f9fc411f21f7e3de46b3e56a",
      "capabilities query digest diverged from the protocol fixture");

  const std::string omitted_defaults = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-default\",\"method\":\"capabilities\",\"params\":{}}";
  const std::string explicit_defaults = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-default\",\"method\":\"capabilities\","
        "\"params\":{\"detail\":\"summary\",\"limit\":50}}";
  const ParsedRequest omitted = decode_request_frame(frame(omitted_defaults));
  const ParsedRequest explicit_value = decode_request_frame(frame(explicit_defaults));
  require(omitted.request_fingerprint_sha256 != explicit_value.request_fingerprint_sha256,
      "request digest collapsed explicit defaults into omission");

  const ParsedRequest invoke = decode_request_frame(frame(invoke_json()));
  require(invoke.method == RpcMethod::kInvoke && invoke.session_id == kSession
      && invoke.deadline_unix_ms == 1'900'000'005'000ULL,
      "invoke golden vector changed");
  require(invoke.request_fingerprint_sha256
      == "9df120d0b016b1313035b94329245474a0dc31bad5c0383a9ecde11db5fbdc8f",
      "invoke RFC 8785 request digest changed");
  require(std::get<InvokeParams>(invoke.params).capability_id == "ae.project.summary",
      "invoke capability changed");

  const std::string cancel_json = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cancel-1\",\"method\":\"cancel\","
        "\"params\":{\"targetRequestId\":\"invoke-summary-1\"}}";
  const ParsedRequest cancel = decode_request_frame(frame(cancel_json));
  require(cancel.method == RpcMethod::kCancel, "cancel golden vector changed");

  expect_codec_error([&] {
    (void)decode_request_frame(frame(hello_json().substr(0, hello_json().size() - 1) + ",\"extra\":1}"));
  }, "INVALID_REQUEST", "unknown envelope field");
  expect_codec_error([&] { (void)decode_request_frame(frame(invoke_json("raw", 1'900'000'005'000ULL,
    "{\"jsx\":\"alert(1)\"}"))); }, "INVALID_ARGUMENT", "raw JSX argument");
  const std::string hello_with_session = hello_json().substr(0, hello_json().size() - 1)
      + ",\"sessionId\":\"not-a-uuid\"}";
  expect_codec_error([&] { (void)decode_request_frame(frame(hello_with_session)); },
      "INVALID_REQUEST", "hello with forbidden session");
}

void project_bit_depth_invokes_are_closed_and_explicitly_mapped() {
  const ParsedRequest read_parsed = decode_request_frame(frame(bit_depth_read_invoke_json()));
  const auto& read = std::get<InvokeParams>(read_parsed.params);
  require(read.capability_id == "ae.project.bit-depth.read"
          && read.target_depth == 0 && read.idempotency_key.empty()
          && read.arguments_fingerprint_sha256.empty(),
      "project bit-depth read did not preserve its empty typed arguments");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_read_invoke_json(
        "bit-depth-read-extra", "{\"targetDepth\":16}")));
  }, "INVALID_ARGUMENT", "project bit-depth read write argument");

  const ParsedRequest set_parsed = decode_request_frame(frame(bit_depth_set_invoke_json()));
  const auto& set = std::get<InvokeParams>(set_parsed.params);
  require(set.capability_id == "ae.project.bit-depth.set"
          && set.target_depth == 16
          && set.idempotency_key == "bit-depth-intent-001",
      "project bit-depth set invoke lost typed arguments");
  require(set.arguments_fingerprint_sha256
          == "3384cd078743d264a556458632c6223f4a302f5c9ca1da2f588b999b7cf9352d"
          && set.arguments_fingerprint_sha256
            == digest_project_bit_depth_set_arguments(16, "bit-depth-intent-001"),
      "project bit-depth set argument fingerprint diverged from JCS");

  for (const std::string_view target : {"0", "12", "24"}) {
    expect_codec_error([&] {
      (void)decode_request_frame(frame(bit_depth_set_invoke_json(
          "bit-depth-invalid-target", target, "bit-depth-intent-002")));
    }, "INVALID_ARGUMENT", "unsupported project bit depth");
  }
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-fraction", "16.5", "bit-depth-intent-003")));
  }, "INVALID_ARGUMENT", "fractional project bit depth");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-string", "\"16\"", "bit-depth-intent-004")));
  }, "INVALID_ARGUMENT", "string project bit depth");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-short-key", "16", "too-short")));
  }, "INVALID_ARGUMENT", "short project bit-depth idempotency key");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-long-key", "16", std::string(65, 'a'))));
  }, "INVALID_ARGUMENT", "long project bit-depth idempotency key");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-leading-key", "16", ".bit-depth-intent")));
  }, "INVALID_ARGUMENT", "leading punctuation project bit-depth idempotency key");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(bit_depth_set_invoke_json(
        "bit-depth-extra", "16", "bit-depth-intent-005", ",\"jsx\":\"x\"")));
  }, "INVALID_ARGUMENT", "unknown project bit-depth argument");
}

void invalidate_graph_requests_and_results_are_closed_and_deterministic() {
  const std::string golden = invalidate_graph_json();
  const ParsedRequest parsed = decode_request_frame(frame(golden));
  require(parsed.method == RpcMethod::kInvalidateGraph
          && parsed.session_id == kSession
          && !parsed.deadline_unix_ms.has_value()
          && std::holds_alternative<InvalidateGraphParams>(parsed.params)
          && std::get<InvalidateGraphParams>(parsed.params).reason
              == InvalidateGraphParams::Reason::kCepJsx,
      "invalidateGraph request did not preserve its typed method and closed params");
  require(parsed.request_fingerprint_sha256
          == "0be932440057b1f2509aee30f414f8fb45d6a637d3327c76cc75d9ca84222bd3",
      "invalidateGraph RFC 8785 request digest diverged from its fixture");
  require(decode_request_frame(frame(" \n" + golden + "\t"))
              .request_fingerprint_sha256 == parsed.request_fingerprint_sha256,
      "invalidateGraph request digest changed across insignificant whitespace");

  const std::string missing_params = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"invalidate-missing-params\","
        "\"method\":\"invalidateGraph\"}";
  expect_codec_error([&] {
    (void)decode_request_frame(frame(missing_params));
  }, "INVALID_REQUEST", "invalidateGraph missing params object");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invalidate_graph_json("invalidate-missing-reason", "{}")));
  }, "INVALID_ARGUMENT", "invalidateGraph missing reason");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invalidate_graph_json(
        "invalidate-wrong-type", "{\"reason\":true}")));
  }, "INVALID_ARGUMENT", "invalidateGraph non-string reason");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invalidate_graph_json(
        "invalidate-wrong-reason", "{\"reason\":\"script\"}")));
  }, "INVALID_ARGUMENT", "invalidateGraph unknown reason");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invalidate_graph_json(
        "invalidate-extra", "{\"reason\":\"cep-jsx\",\"extra\":true}")));
  }, "INVALID_ARGUMENT", "invalidateGraph extra param");

  std::string wrong_method = golden;
  wrong_method.replace(
      wrong_method.find("invalidateGraph"), std::string_view("invalidateGraph").size(),
      "invalidategraph");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(wrong_method));
  }, "INVALID_REQUEST", "invalidateGraph method case drift");

  ProjectGraphInvalidateSuccess success{
      "invalidate-graph-1", std::string(kSession), true, 9};
  const std::string success_body = body(
      encode_project_graph_invalidate_success(success));
  require(success_body.find("\"method\":\"invalidateGraph\"") != std::string::npos
          && success_body.find("\"replayed\":false") != std::string::npos
          && success_body.find(
              "\"result\":{\"generation\":9,\"invalidated\":true}")
              != std::string::npos,
      "invalidateGraph success encoder omitted its typed acknowledgement");

  success.generation = 0;
  expect_argument_error([&] {
    (void)encode_project_graph_invalidate_success(success);
  }, "invalidateGraph true result with generation zero");
  success.generation = aemcp::native::rpc::kMaxSafeInteger + 1;
  expect_argument_error([&] {
    (void)encode_project_graph_invalidate_success(success);
  }, "invalidateGraph true result with unsafe generation");

  success.invalidated = false;
  success.generation = 0;
  const std::string no_project_body = body(
      encode_project_graph_invalidate_success(success));
  require(no_project_body.find(
              "\"result\":{\"generation\":0,\"invalidated\":false}")
              != std::string::npos,
      "invalidateGraph no-project acknowledgement changed its zero-generation invariant");
  success.generation = 1;
  expect_argument_error([&] {
    (void)encode_project_graph_invalidate_success(success);
  }, "invalidateGraph false result with nonzero generation");
}

void project_graph_invokes_and_results_are_closed_and_deterministic() {
  const ParsedRequest project_parsed = decode_request_frame(frame(project_items_invoke_json()));
  const auto& project = std::get<InvokeParams>(project_parsed.params);
  require(project.capability_id == "ae.project.items.list" && project.offset == 0
          && project.limit == 25 && !project.project_locator.has_value(),
      "project-items invoke lost typed pagination arguments");
  const std::string project_value = locator_json(
      "project", "77777777-7777-4777-8777-777777777777");
  const auto continued = std::get<InvokeParams>(decode_request_frame(frame(
      project_items_invoke_json("invoke-project-items-2", 25, 25, project_value))).params);
  require(continued.project_locator.has_value()
          && continued.project_locator->kind == "project"
          && continued.project_locator->generation == 8,
      "project-items continuation lost its locator");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(project_items_invoke_json(
        "invoke-project-items-missing", 1, 25)));
  }, "INVALID_ARGUMENT", "project-items continuation without locator");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(project_items_invoke_json(
        "invoke-project-items-limit", 0, 51)));
  }, "INVALID_ARGUMENT", "project-items limit above 50");

  const ParsedRequest layers_parsed = decode_request_frame(frame(
      composition_layers_invoke_json()));
  const auto& layers = std::get<InvokeParams>(layers_parsed.params);
  require(layers.capability_id == "ae.composition.layers.list"
          && layers.composition_locator.has_value()
          && layers.composition_locator->kind == "composition",
      "composition-layers invoke lost its typed locator");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_layers_invoke_json(
        "invoke-composition-wrong-kind",
        locator_json("item", "66666666-6666-4666-8666-666666666666"))));
  }, "INVALID_ARGUMENT", "composition-layers item locator");

  const ParsedRequest selected_layers_parsed = decode_request_frame(frame(
      composition_selected_layers_invoke_json()));
  const auto& selected_layers = std::get<InvokeParams>(selected_layers_parsed.params);
  require(selected_layers.capability_id == "ae.composition.selected-layers.list"
          && selected_layers.composition_locator.has_value()
          && selected_layers.composition_locator->kind == "composition"
          && selected_layers.offset == 0 && selected_layers.limit == 25,
      "composition-selected-layers invoke lost its closed locator or pagination");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_selected_layers_invoke_json(
        "invoke-composition-selected-wrong-kind",
        locator_json("item", "66666666-6666-4666-8666-666666666666"))));
  }, "INVALID_ARGUMENT", "composition-selected-layers item locator");

  const ParsedRequest time_parsed = decode_request_frame(frame(
      composition_time_invoke_json()));
  const auto& time = std::get<InvokeParams>(time_parsed.params);
  require(time.capability_id == "ae.composition.time.read"
          && time.composition_locator.has_value()
          && time.composition_locator->kind == "composition"
          && time.offset == 0 && time.limit == 0
          && time_parsed.request_fingerprint_sha256
              == "e9fbcbcb1414f1b994da20b76256d64b732d4ecc4f9175a52dc10cebdf2fad58",
      "composition-time invoke lost its closed locator or JCS digest");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_time_invoke_json(
        "invoke-composition-time-kind",
        locator_json("item", "66666666-6666-4666-8666-666666666666"))));
  }, "INVALID_ARGUMENT", "composition-time item locator");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_time_invoke_json(
        "invoke-composition-time-extra", {}, ",\"offset\":0")));
  }, "INVALID_ARGUMENT", "composition-time pagination argument");

  const ParsedRequest composition_create_parsed = decode_request_frame(frame(
      composition_create_invoke_json()));
  const auto& composition_create = std::get<InvokeParams>(
      composition_create_parsed.params);
  require(composition_create.capability_id == "ae.composition.create"
          && composition_create.composition_create_name == "SYNTHETIC_COMP"
          && composition_create.composition_create_width == 1920
          && composition_create.composition_create_height == 1080
          && composition_create.composition_create_duration.seconds_rational == "5"
          && composition_create.composition_create_frame_rate.rational == "24"
          && composition_create.composition_create_pixel_aspect_ratio.rational == "1"
          && composition_create.idempotency_key == "synthetic-comp-create-0001",
      "composition create lost its closed typed arguments");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_create_invoke_json(
        "invoke-composition-create-extra", ",\"extra\":true")));
  }, "INVALID_ARGUMENT", "composition create extra argument");
  expect_codec_error([&] {
    std::string nul_name = composition_create_invoke_json(
        "invoke-composition-create-nul");
    const std::string expected = "\"name\":\"SYNTHETIC_COMP\"";
    const auto offset = nul_name.find(expected);
    require(offset != std::string::npos, "composition create fixture name missing");
    nul_name.replace(offset, expected.size(), "\"name\":\"SYNTHETIC\\u0000COMP\"");
    (void)decode_request_frame(frame(nul_name));
  }, "INVALID_ARGUMENT", "composition create NUL name");

  const ParsedRequest create_parsed = decode_request_frame(frame(
      composition_layer_create_invoke_json()));
  const auto& create = std::get<InvokeParams>(create_parsed.params);
  require(create.capability_id == "ae.composition.layer.create"
          && create.composition_locator.has_value()
          && create.layer_create_kind == "solid"
          && create.layer_create_name == "SYNTHETIC_SOLID"
          && create.layer_create_color
              == aemcp::native::CompositionLayerCreateColor{12, 34, 56, 255}
          && create.layer_create_width == 640 && create.layer_create_height == 360
          && create.layer_create_duration.has_value()
          && create.layer_create_duration->seconds_rational == "5"
          && create.idempotency_key == "synthetic-layer-create-0001",
      "composition layer create lost its closed typed arguments");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(composition_layer_create_invoke_json(
        "invoke-composition-layer-create-extra", ",\"extra\":true")));
  }, "INVALID_ARGUMENT", "composition layer create extra argument");

  const ParsedRequest effect_apply_parsed = decode_request_frame(frame(
      layer_effect_apply_invoke_json()));
  const auto& effect_apply = std::get<InvokeParams>(effect_apply_parsed.params);
  require(effect_apply.capability_id == "ae.layer.effect.apply"
          && effect_apply.layer_locator.has_value()
          && effect_apply.layer_locator->kind == "layer"
          && effect_apply.layer_effect_match_name == "ADBE Slider Control"
          && effect_apply.idempotency_key == "synthetic-effect-apply-0001"
          && effect_apply_parsed.request_fingerprint_sha256.size() == 64,
      "layer effect apply lost its closed locator, match name, or idempotency key");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(layer_effect_apply_invoke_json(
        "invoke-layer-effect-apply-extra", ",\"extra\":true")));
  }, "INVALID_ARGUMENT", "layer effect apply extra argument");

  const std::string parent_locator = locator_json(
      "stream", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const ParsedRequest properties_parsed = decode_request_frame(frame(
      layer_properties_invoke_json("invoke-layer-properties-1", parent_locator)));
  const auto& property_args = std::get<InvokeParams>(properties_parsed.params);
  require(property_args.capability_id == "ae.layer.properties.list"
          && property_args.layer_locator.has_value()
          && property_args.parent_property_locator.has_value()
          && property_args.limit == 25,
      "layer-properties invoke lost its typed locators");
  const ParsedRequest omitted_parent = decode_request_frame(frame(
      layer_properties_invoke_json("invoke-layer-properties-root")));
  const ParsedRequest null_parent = decode_request_frame(frame(
      layer_properties_invoke_json("invoke-layer-properties-root", "null")));
  require(!std::get<InvokeParams>(null_parent.params).parent_property_locator.has_value()
          && null_parent.request_fingerprint_sha256
              == omitted_parent.request_fingerprint_sha256,
      "explicit null parent locator was not normalized to omission");

  const ParsedRequest keyframes_parsed = decode_request_frame(frame(
      layer_property_keyframes_invoke_json()));
  const auto& keyframes_args = std::get<InvokeParams>(keyframes_parsed.params);
  require(keyframes_args.capability_id == "ae.layer.property.keyframes.list"
          && keyframes_args.property_locator.has_value()
          && keyframes_args.property_locator->kind == "stream"
          && !keyframes_args.layer_locator.has_value()
          && keyframes_args.offset == 0 && keyframes_args.limit == 2,
      "keyframe invoke lost its property-only locator or bounded page");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(layer_property_keyframes_invoke_json(
        "invoke-layer-property-keyframes-extra", ",\"extra\":true")));
  }, "INVALID_ARGUMENT", "keyframe invoke extra argument");

  aemcp::native::ProjectItemsPage project_page;
  project_page.project_locator = locator(
      "project", "77777777-7777-4777-8777-777777777777");
  project_page.total = 1;
  project_page.offset = 0;
  project_page.limit = 25;
  project_page.items.push_back({
      locator("composition", "66666666-6666-4666-8666-666666666666"),
      "Fixture Comp",
      "composition",
      project_page.project_locator});
  ProjectItemsSuccess project_success{
      "invoke-project-items-1",
      std::string(kSession),
      std::string(kHost),
      project_page,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_project_items_postcondition(project_page),
      false};
  const std::string project_body = body(encode_project_items_success(project_success));
  require(project_body.find("\"capabilityId\":\"ae.project.items.list\"")
          != std::string::npos
          && project_body.find("\"kind\":\"project-items-list\"")
          != std::string::npos
          && project_body.find("\"type\":\"composition\"") != std::string::npos,
      "project-items success omitted its typed native contract");

  aemcp::native::CompositionLayersPage layer_page;
  layer_page.composition_locator = project_page.items[0].locator;
  layer_page.composition_name = "Fixture Comp";
  layer_page.total = 1;
  layer_page.offset = 0;
  layer_page.limit = 25;
  layer_page.layers.push_back({
      locator("layer", "88888888-8888-4888-8888-888888888888"),
      1,
      "Fixture Text",
      "text",
      true,
      false,
      true,
      std::nullopt,
      std::nullopt});
  CompositionLayersSuccess layers_success{
      "invoke-composition-layers-1",
      std::string(kSession),
      std::string(kHost),
      layer_page,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_layers_postcondition(layer_page),
      false};
  const std::string layers_body = body(encode_composition_layers_success(layers_success));
  require(layers_body.find("\"capabilityId\":\"ae.composition.layers.list\"")
          != std::string::npos
          && layers_body.find("\"kind\":\"composition-layers-list\"")
          != std::string::npos
          && layers_body.find("\"locked\":true") != std::string::npos,
      "composition-layers success omitted locked native layer evidence");
  const std::string original_digest = layers_success.postcondition_digest;
  layer_page.layers[0].locked = false;
  require(digest_composition_layers_postcondition(layer_page) != original_digest,
      "composition-layers digest ignored a semantic layer flag");

  aemcp::native::CompositionLayersPage selected_page = layer_page;
  selected_page.total = 2;
  selected_page.layers.push_back({
      locator("layer", "99999999-9999-4999-8999-999999999999"),
      3,
      "Fixture Shape",
      "shape",
      true,
      false,
      false,
      std::nullopt,
      std::nullopt});
  CompositionSelectedLayersSuccess selected_success{
      "invoke-composition-selected-layers-1",
      std::string(kSession),
      std::string(kHost),
      selected_page,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_selected_layers_postcondition(selected_page),
      false};
  const std::string selected_body = body(
      encode_composition_selected_layers_success(selected_success));
  require(selected_body.find(
              "\"capabilityId\":\"ae.composition.selected-layers.list\"")
          != std::string::npos
          && selected_body.find("\"kind\":\"composition-selected-layers-list\"")
            != std::string::npos
          && selected_body.find("\"stackIndex\":1") != std::string::npos
          && selected_body.find("\"stackIndex\":3") != std::string::npos,
      "composition-selected-layers success omitted non-contiguous native selection evidence");
  CompositionSelectedLayersSuccess out_of_order_selected = selected_success;
  out_of_order_selected.value.layers[1].stack_index = 1;
  out_of_order_selected.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_selected_layers_success(out_of_order_selected);
  }, "INVALID_ARGUMENT", "non-increasing selected-layer stack index");
  CompositionSelectedLayersSuccess duplicate_selected = selected_success;
  duplicate_selected.value.layers[1].locator = duplicate_selected.value.layers[0].locator;
  duplicate_selected.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_selected_layers_success(duplicate_selected);
  }, "INVALID_ARGUMENT", "duplicate selected-layer locator");

  aemcp::native::CompositionTimeRead time_value;
  time_value.composition_locator = project_page.items[0].locator;
  time_value.current_time = {3003, 1000, "3003/1000"};
  CompositionTimeSuccess time_success{
      "invoke-composition-time-1",
      std::string(kSession),
      std::string(kHost),
      time_value,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_time_postcondition(time_value),
      false};
  require(time_success.postcondition_digest
          == "809ed0109922812d59208d5f366714f6005abb600f6a1ef5f71d4bc5adc55cef",
      "composition-time postcondition digest diverged from JCS");
  const std::string time_body = body(encode_composition_time_success(time_success));
  require(time_body.find("\"capabilityId\":\"ae.composition.time.read\"")
          != std::string::npos
          && time_body.find("\"kind\":\"composition-time-read\"")
              != std::string::npos
          && time_body.find(
              "\"currentTime\":{\"scale\":1000,"
              "\"secondsRational\":\"3003/1000\",\"value\":3003}")
              != std::string::npos,
      "composition-time success omitted exact native time evidence");

  CompositionTimeSuccess noncanonical_time = time_success;
  noncanonical_time.value.current_time.seconds_rational = "6006/2000";
  noncanonical_time.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_time_success(noncanonical_time);
  }, "INVALID_ARGUMENT", "non-canonical composition time rational");
  CompositionTimeSuccess zero_scale = time_success;
  zero_scale.value.current_time.scale = 0;
  zero_scale.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_time_success(zero_scale);
  }, "INVALID_ARGUMENT", "zero composition time scale");
  CompositionTimeSuccess minimum_time = time_success;
  minimum_time.value.current_time = {
      std::numeric_limits<std::int32_t>::min(), 1, "-2147483648"};
  minimum_time.postcondition_digest =
      digest_composition_time_postcondition(minimum_time.value);
  require(body(encode_composition_time_success(minimum_time)).find(
              "\"secondsRational\":\"-2147483648\",\"value\":-2147483648")
          != std::string::npos,
      "INT32_MIN composition time did not serialize without overflow");

  aemcp::native::CompositionTimeChanged time_changed;
  time_changed.changed = true;
  time_changed.composition_locator = time_value.composition_locator;
  time_changed.before_time = {0, 1, "0"};
  time_changed.after_time = {1, 1, "1"};
  CompositionTimeSetSuccess time_set_success{
      "invoke-composition-time-set-1",
      std::string(kSession),
      std::string(kHost),
      time_changed,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_time_set_postcondition(time_changed),
      false};
  const std::string time_set_body = body(
      encode_composition_time_set_success(time_set_success));
  require(time_set_body.find("\"capabilityId\":\"ae.composition.time.set\"")
          != std::string::npos
          && time_set_body.find("\"kind\":\"composition-time-set\"")
              != std::string::npos
          && time_set_body.find("\"effect\":\"committed\"")
              != std::string::npos
          && time_set_body.find("\"undo\":{\"available\":true,\"verified\":false}")
              != std::string::npos,
      "composition-time mutation success omitted committed Undo evidence");
  CompositionTimeSetSuccess equal_time = time_set_success;
  equal_time.value.after_time = equal_time.value.before_time;
  equal_time.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_time_set_success(equal_time);
  }, "INVALID_ARGUMENT", "composition-time write without a transition");

  aemcp::native::CompositionCreated composition_created;
  composition_created.name = "SYNTHETIC_COMP";
  composition_created.composition_locator = locator(
      "composition", "77777777-7777-4777-8777-777777777777");
  composition_created.composition_locator.project_id =
      "55555555-5555-4555-8555-555555555555";
  composition_created.composition_locator.generation = 9;
  composition_created.project_item_count_before = 1;
  composition_created.project_item_count_after = 2;
  composition_created.layer_count = 0;
  composition_created.width = 1920;
  composition_created.height = 1080;
  composition_created.duration = {5, 1, "5"};
  composition_created.frame_rate = {24, 1, "24"};
  composition_created.pixel_aspect_ratio = {1, 1, "1"};
  CompositionCreateSuccess composition_create_success{
      "invoke-composition-create-1",
      std::string(kSession),
      std::string(kHost),
      composition_created,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_create_postcondition(composition_created),
      false};
  require(composition_create_success.postcondition_digest
          == "7a33afaf29bbb5d6c91746433880a7b6af31c66c9f26a3d070b6e36b9a13fd71",
      "composition-create postcondition digest diverged from JCS");
  const std::string composition_create_body = body(
      encode_composition_create_success(composition_create_success));
  require(composition_create_body.find(
              "\"capabilityId\":\"ae.composition.create\"")
              != std::string::npos
          && composition_create_body.find("\"kind\":\"composition-create\"")
              != std::string::npos
          && composition_create_body.find("\"replayed\":false")
              != std::string::npos
          && composition_create_body.find("\"projectItemCountAfter\":2")
              != std::string::npos,
      "composition create success omitted typed mutation evidence");
  auto private_composition_created = composition_created;
  private_composition_created.name = "PRIVATE_CUSTOMER_COMPOSITION_123";
  const std::string persistent_diagnostic = "{"
      + composition_create_persistent_diagnostic_fields(private_composition_created)
      + ",\"postconditionDigest\":\"fixture-digest\"}";
  require(persistent_diagnostic.find(private_composition_created.name)
              == std::string::npos
          && persistent_diagnostic.find("\"name\":") == std::string::npos
          && persistent_diagnostic.find("\"nameRedacted\":true")
              != std::string::npos
          && persistent_diagnostic.find("\"projectItemCountBefore\":1")
              != std::string::npos
          && persistent_diagnostic.find("\"projectItemCountAfter\":2")
              != std::string::npos
          && persistent_diagnostic.find("\"layerCount\":0")
              != std::string::npos
          && persistent_diagnostic.find("\"width\":1920")
              != std::string::npos
          && persistent_diagnostic.find("\"height\":1080")
              != std::string::npos
          && persistent_diagnostic.find("\"projectGeneration\":9")
              != std::string::npos
          && persistent_diagnostic.find(
                 "\"postconditionDigest\":\"fixture-digest\"")
              != std::string::npos,
      "persistent composition-create diagnostics exposed the name or lost bounded evidence");
  composition_create_success.replayed = true;
  require(body(encode_composition_create_success(composition_create_success)).find(
              "\"replayed\":true") != std::string::npos,
      "verified composition create replay was not serializable");
  CompositionCreateSuccess bad_composition_count = composition_create_success;
  bad_composition_count.value.project_item_count_after = 3;
  bad_composition_count.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_create_success(bad_composition_count);
  }, "INVALID_ARGUMENT", "composition create invalid count transition");

  aemcp::native::CompositionLayerCreated layer_created;
  layer_created.kind = "solid";
  layer_created.name = "SYNTHETIC_SOLID";
  layer_created.stack_index = 1;
  layer_created.composition_locator = time_value.composition_locator;
  layer_created.composition_locator.project_id =
      "55555555-5555-4555-8555-555555555555";
  layer_created.composition_locator.generation = 9;
  layer_created.layer_locator = layer_created.composition_locator;
  layer_created.layer_locator.kind = "layer";
  layer_created.layer_locator.object_id =
      "99999999-9999-4999-8999-999999999999";
  layer_created.source_item_locator = layer_created.composition_locator;
  layer_created.source_item_locator->kind = "item";
  layer_created.source_item_locator->object_id =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  layer_created.layer_count_before = 0;
  layer_created.layer_count_after = 1;
  layer_created.project_item_count_before = 2;
  layer_created.project_item_count_after = 3;
  layer_created.solid = aemcp::native::CompositionLayerSolidSpec{
      {12, 34, 56, 255}, 640, 360, {5, 1, "5"}};
  CompositionLayerCreateSuccess layer_create_success{
      "invoke-composition-layer-create-1",
      std::string(kSession),
      std::string(kHost),
      layer_created,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_composition_layer_create_postcondition(layer_created),
      false};
  require(layer_create_success.postcondition_digest
          == "fb10435ee424e4a36b207427bffdeb55e6e3713d48ba51ae74e47de5a655483f",
      "composition-layer-create postcondition digest diverged from JCS");
  const std::string layer_create_body = body(
      encode_composition_layer_create_success(layer_create_success));
  require(layer_create_body.find(
              "\"capabilityId\":\"ae.composition.layer.create\"")
              != std::string::npos
          && layer_create_body.find("\"kind\":\"composition-layer-create\"")
              != std::string::npos
          && layer_create_body.find("\"replayed\":false") != std::string::npos
          && layer_create_body.find("\"projectItemCountAfter\":3")
              != std::string::npos,
      "composition layer create success omitted typed mutation evidence");
  layer_create_success.replayed = true;
  require(body(encode_composition_layer_create_success(layer_create_success)).find(
              "\"replayed\":true") != std::string::npos,
      "verified composition layer create replay was not serializable");
  CompositionLayerCreateSuccess bad_count = layer_create_success;
  bad_count.value.layer_count_after = 2;
  bad_count.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_layer_create_success(bad_count);
  }, "INVALID_ARGUMENT", "composition layer create invalid count transition");

  aemcp::native::LayerEffectApplied effect_applied;
  effect_applied.changed = true;
  effect_applied.layer_locator = locator(
      "layer", "88888888-8888-4888-8888-888888888888");
  effect_applied.layer_locator.project_id =
      "55555555-5555-4555-8555-555555555555";
  effect_applied.layer_locator.generation = 9;
  effect_applied.name = "Slider Control";
  effect_applied.match_name = "ADBE Slider Control";
  effect_applied.effect_index = 1;
  effect_applied.effect_count_before = 0;
  effect_applied.effect_count_after = 1;
  effect_applied.matching_effect_count_before = 0;
  effect_applied.matching_effect_count_after = 1;
  LayerEffectApplySuccess effect_apply_success{
      "invoke-layer-effect-apply-1",
      std::string(kSession),
      std::string(kHost),
      effect_applied,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_layer_effect_apply_postcondition(effect_applied),
      false};
  require(effect_apply_success.postcondition_digest
          == "52a696e6254c3fc97b2fdc5c64517cd5fc5fe685fff5b7905b1454b574e02cb5",
      "layer effect apply postcondition digest diverged from JCS");
  const std::string effect_apply_body = body(
      encode_layer_effect_apply_success(effect_apply_success));
  require(effect_apply_body.find("\"capabilityId\":\"ae.layer.effect.apply\"")
              != std::string::npos
          && effect_apply_body.find("\"kind\":\"layer-effect-apply\"")
              != std::string::npos
          && effect_apply_body.find("\"matchName\":\"ADBE Slider Control\"")
              != std::string::npos
          && effect_apply_body.find(
              "\"undo\":{\"available\":true,\"verified\":false}")
              != std::string::npos,
      "layer effect apply success omitted typed mutation or Undo evidence");
  effect_apply_success.replayed = true;
  require(body(encode_layer_effect_apply_success(effect_apply_success)).find(
              "\"replayed\":true") != std::string::npos,
      "verified layer effect replay was not serializable");
  LayerEffectApplySuccess bad_effect_count = effect_apply_success;
  bad_effect_count.value.effect_count_after = 2;
  bad_effect_count.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_effect_apply_success(bad_effect_count);
  }, "INVALID_ARGUMENT", "layer effect apply invalid count transition");

  aemcp::native::LayerPropertiesPage property_page;
  property_page.layer_locator = layer_page.layers[0].locator;
  property_page.parent_property_locator = locator(
      "stream", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  property_page.layer_name = "Fixture Text";
  property_page.sample_time = {0, 1};
  property_page.total = 3;
  property_page.offset = 0;
  property_page.limit = 25;
  aemcp::native::LayerPropertyEntry position;
  position.property_locator = locator(
      "stream", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  position.property_index = 1;
  position.name = "Position";
  position.match_name = "ADBE Position";
  position.grouping_type = "leaf";
  position.modified = true;
  position.can_vary_over_time = true;
  position.time_varying = true;
  position.value_type = "two-d-spatial";
  position.value_status = "sampled";
  position.value = aemcp::native::LayerPropertyVectorValue{{"10", "20"}};
  property_page.properties.push_back(position);
  aemcp::native::LayerPropertyEntry marker;
  marker.property_locator = locator(
      "stream", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  marker.property_index = 2;
  marker.name = "Marker";
  marker.match_name = "ADBE Marker";
  marker.grouping_type = "leaf";
  marker.value_type = "marker";
  marker.value_status = "unsupported";
  property_page.properties.push_back(marker);
  aemcp::native::LayerPropertyEntry group;
  group.property_locator = locator(
      "stream", "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  group.property_index = 3;
  group.name = "Transform";
  group.match_name = "ADBE Transform Group";
  group.grouping_type = "named-group";
  group.child_count = 5;
  group.value_type = "none";
  group.value_status = "group";
  property_page.properties.push_back(group);
  LayerPropertiesSuccess properties_success{
      "invoke-layer-properties-1",
      std::string(kSession),
      std::string(kHost),
      property_page,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_layer_properties_postcondition(property_page),
      false};
  const std::string properties_body = body(
      encode_layer_properties_success(properties_success));
  require(properties_body.find("\"capabilityId\":\"ae.layer.properties.list\"")
          != std::string::npos
          && properties_body.find("\"kind\":\"layer-properties-list\"")
            != std::string::npos
          && properties_body.find("\"components\":[\"10\",\"20\"]")
            != std::string::npos,
      "layer-properties success omitted its typed native contract");

  aemcp::native::LayerPropertyKeyframesPage keyframe_page;
  keyframe_page.property_locator = position.property_locator;
  keyframe_page.value_type = "one-d";
  keyframe_page.total = 3;
  keyframe_page.offset = 0;
  keyframe_page.limit = 2;
  keyframe_page.has_more = true;
  keyframe_page.next_offset = 2;
  keyframe_page.keyframes.push_back({
      1,
      {0, 1},
      aemcp::native::LayerPropertyScalarValue{"10"},
      "linear",
      "linear"});
  keyframe_page.keyframes.push_back({
      2,
      {5, 2},
      aemcp::native::LayerPropertyScalarValue{"20.5"},
      "bezier",
      "hold"});
  LayerPropertyKeyframesSuccess keyframes_success{
      "invoke-layer-property-keyframes-1",
      std::string(kSession),
      std::string(kHost),
      keyframe_page,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_layer_property_keyframes_postcondition(keyframe_page),
      false};
  require(keyframes_success.postcondition_digest
          == "1ad0e47354fcfd091f0c252785c3ec1da1364f92a633e7e5f9dd2d2885223aa7",
      "keyframe postcondition digest diverged from the protocol fixture");
  const std::string keyframes_body = body(
      encode_layer_property_keyframes_success(keyframes_success));
  require(keyframes_body.find(
              "\"capabilityId\":\"ae.layer.property.keyframes.list\"")
              != std::string::npos
          && keyframes_body.find("\"kind\":\"layer-property-keyframes-list\"")
              != std::string::npos
          && keyframes_body.find(
              "\"time\":{\"mode\":\"comp-time\",\"scale\":2,\"value\":5}")
              != std::string::npos
          && keyframes_body.find("\"outInterpolation\":\"hold\"")
              != std::string::npos,
      "keyframe success omitted exact time, interpolation, or provenance");
  LayerPropertyKeyframesSuccess repeated_time = keyframes_success;
  repeated_time.value.keyframes[1].time = {0, 24};
  repeated_time.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_property_keyframes_success(repeated_time);
  }, "INVALID_ARGUMENT", "keyframe response with non-increasing exact time");
  LayerPropertyKeyframesSuccess wrong_keyframe_type = keyframes_success;
  wrong_keyframe_type.value.keyframes[0].value =
      aemcp::native::LayerPropertyVectorValue{{"1", "2"}};
  wrong_keyframe_type.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_property_keyframes_success(wrong_keyframe_type);
  }, "INVALID_ARGUMENT", "keyframe response with wrong primitive type");

  aemcp::native::LayerPropertyChanged changed;
  changed.layer_locator = property_page.layer_locator;
  changed.property_locator = position.property_locator;
  changed.value_type = "two-d-spatial";
  changed.before_value = aemcp::native::LayerPropertyVectorValue{{"10", "20"}};
  changed.after_value = aemcp::native::LayerPropertyVectorValue{{"30", "40"}};
  LayerPropertySetSuccess property_set{
      "invoke-layer-property-set-1",
      std::string(kSession),
      std::string(kHost),
      changed,
      1'900'000'000'000ULL,
      1'900'000'000'025ULL,
      std::string(kDigest),
      digest_layer_property_set_postcondition(changed),
      false};
  const std::string property_set_body = body(
      encode_layer_property_set_success(property_set));
  require(property_set_body.find("\"capabilityId\":\"ae.layer.property.set\"")
          != std::string::npos
          && property_set_body.find("\"kind\":\"layer-property-set\"")
              != std::string::npos
          && property_set_body.find("\"effect\":\"committed\"")
              != std::string::npos,
      "layer-property mutation success omitted committed Undo evidence");
  LayerPropertiesSuccess unknown_unsupported = properties_success;
  unknown_unsupported.value.properties[1].value_type = "unknown";
  unknown_unsupported.postcondition_digest =
      digest_layer_properties_postcondition(unknown_unsupported.value);
  const std::string unknown_body = body(
      encode_layer_properties_success(unknown_unsupported));
  require(unknown_body.find(
              "\"valueStatus\":\"unsupported\",\"valueType\":\"unknown\"")
          != std::string::npos,
      "unknown unsupported layer property was rejected");
  LayerPropertiesSuccess unknown_sampled = unknown_unsupported;
  unknown_sampled.value.properties[1].value_status = "sampled";
  unknown_sampled.value.properties[1].can_vary_over_time = false;
  unknown_sampled.value.properties[1].time_varying = false;
  unknown_sampled.value.properties[1].value =
      aemcp::native::LayerPropertyScalarValue{"1"};
  unknown_sampled.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_properties_success(unknown_sampled);
  }, "INVALID_ARGUMENT", "unknown sampled layer property");
  LayerPropertiesSuccess wrong_arity = properties_success;
  std::get<aemcp::native::LayerPropertyVectorValue>(
      wrong_arity.value.properties[0].value).components.push_back("30");
  wrong_arity.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_properties_success(wrong_arity);
  }, "INVALID_ARGUMENT", "2D layer property with three components");
  LayerPropertiesSuccess parent_as_child = properties_success;
  parent_as_child.value.properties[0].property_locator =
      *parent_as_child.value.parent_property_locator;
  parent_as_child.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_layer_properties_success(parent_as_child);
  }, "INVALID_ARGUMENT", "layer property locator equal to its parent");

  ProjectItemsSuccess out_of_range = project_success;
  out_of_range.value.offset = out_of_range.value.total + 1;
  out_of_range.value.items.clear();
  out_of_range.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_project_items_success(out_of_range);
  }, "INVALID_ARGUMENT", "project-items response with offset beyond total");

  CompositionLayersSuccess empty_nonterminal = layers_success;
  empty_nonterminal.value.total = 2;
  empty_nonterminal.value.layers.clear();
  empty_nonterminal.value.has_more = true;
  empty_nonterminal.value.next_offset = 0;
  empty_nonterminal.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_layers_success(empty_nonterminal);
  }, "INVALID_ARGUMENT", "empty nonterminal composition-layers response");

  ProjectItemsSuccess missing_parent = project_success;
  missing_parent.value.items[0].parent_locator.reset();
  missing_parent.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_project_items_success(missing_parent);
  }, "INVALID_ARGUMENT", "project item without required parent locator");

  ProjectItemsSuccess wrong_root_parent = project_success;
  wrong_root_parent.value.items[0].parent_locator->object_id =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  wrong_root_parent.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_project_items_success(wrong_root_parent);
  }, "INVALID_ARGUMENT", "project-kind parent not equal to project locator");

  ProjectItemsSuccess duplicate_item = project_success;
  duplicate_item.value.total = 2;
  duplicate_item.value.items.push_back(duplicate_item.value.items[0]);
  duplicate_item.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_project_items_success(duplicate_item);
  }, "INVALID_ARGUMENT", "duplicate project item locator");

  CompositionLayersSuccess duplicate_layer = layers_success;
  duplicate_layer.value.total = 2;
  duplicate_layer.value.layers.push_back(duplicate_layer.value.layers[0]);
  duplicate_layer.value.layers[1].stack_index = 2;
  duplicate_layer.postcondition_digest = std::string(kDigest);
  expect_codec_error([&] {
    (void)encode_composition_layers_success(duplicate_layer);
  }, "INVALID_ARGUMENT", "duplicate composition layer locator");
}

void project_composition_package_parses_and_serializes_all_eight_contracts() {
  const std::string item = locator_json(
      "item", "77777777-7777-4777-8777-777777777777");
  const std::string composition = locator_json(
      "composition", "66666666-6666-4666-8666-666666666666");
  const std::array<std::tuple<std::string, std::string, std::string>, 8> requests{{
      {"package-context", "ae.project.context.read",
          "{\"selectionOffset\":0,\"selectionLimit\":25}"},
      {"package-metadata", "ae.project.item.metadata.read",
          "{\"itemLocator\":" + item + "}"},
      {"package-settings", "ae.composition.settings.read",
          "{\"compositionLocator\":" + composition + "}"},
      {"package-work-area", "ae.composition.work-area.set",
          "{\"compositionLocator\":" + composition
            + ",\"start\":{\"value\":1,\"scale\":1},"
              "\"duration\":{\"value\":4,\"scale\":1},"
              "\"idempotencyKey\":\"package-work-area-0001\"}"},
      {"package-name", "ae.project.item.name.set",
          "{\"itemLocator\":" + item
            + ",\"name\":\"After\","
              "\"idempotencyKey\":\"package-item-name-0001\"}"},
      {"package-comment", "ae.project.item.comment.set",
          "{\"itemLocator\":" + item
            + ",\"comment\":\"\","
              "\"idempotencyKey\":\"package-item-comment-0001\"}"},
      {"package-label", "ae.project.item.label.set",
          "{\"itemLocator\":" + item
            + ",\"labelId\":4,"
              "\"idempotencyKey\":\"package-item-label-0001\"}"},
      {"package-duplicate", "ae.composition.duplicate",
          "{\"compositionLocator\":" + composition
            + ",\"newName\":\"Fixture Copy\","
              "\"idempotencyKey\":\"package-duplicate-0001\"}"},
  }};
  for (const auto& [request_id, capability_id, arguments] : requests) {
    const ParsedRequest parsed = decode_request_frame(frame(package150_invoke_json(
        request_id, capability_id, arguments)));
    require(parsed.method == RpcMethod::kInvoke
            && std::get<InvokeParams>(parsed.params).capability_id == capability_id,
        "package-150 invoke parser lost its typed capability: " + capability_id);
  }

  const ParsedRequest comment_fixture = decode_request_frame(frame(package150_invoke_json(
      "invoke-item-comment-set-1",
      "ae.project.item.comment.set",
      "{\"itemLocator\":" + item
        + ",\"comment\":\"SYNTHETIC_COMMENT\","
          "\"idempotencyKey\":\"synthetic-item-comment-0001\"}")));
  const auto& comment_params = std::get<InvokeParams>(comment_fixture.params);
  require(comment_fixture.request_fingerprint_sha256
          == "86593f8a6ba8292928dcbb25ba126c07f73ad4a0f55e71ccf99902505b725522",
      "comment request fingerprint drifted from the shared RFC 8785 fixture");
  require(comment_params.arguments_fingerprint_sha256
          == "38951b3ec3463cdfbcb53ae0e0c6d35e73e39101da69cad83ede4410992f13a3",
      "comment arguments fingerprint is not RFC 8785 canonical");

  const auto project = locator(
      "project", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const auto item_locator = locator(
      "item", "77777777-7777-4777-8777-777777777777");
  const auto composition_locator = locator(
      "composition", "66666666-6666-4666-8666-666666666666");
  const auto settings = [](aemcp::native::ObjectLocator locator_value,
                           std::string name) {
    aemcp::native::CompositionSettings value;
    value.composition_locator = std::move(locator_value);
    value.name = std::move(name);
    value.width = 1920;
    value.height = 1080;
    value.duration = {10, 1, "10"};
    value.frame_duration = {1, 24, "1/24"};
    value.frame_rate = {24, 1, "24"};
    value.pixel_aspect_ratio = {1, 1, "1"};
    value.work_area_start = {0, 1, "0"};
    value.work_area_duration = {5, 1, "5"};
    value.display_start_time = {0, 1, "0"};
    return value;
  };
  const auto success = [](auto value, std::string request_id, auto digest) {
    using Success = aemcp::native::rpc::NativeValueSuccess<decltype(value)>;
    return Success{
        std::move(request_id),
        std::string(kSession),
        std::string(kHost),
        std::move(value),
        1'900'000'000'000ULL,
        1'900'000'000'025ULL,
        std::string(kDigest),
        digest,
        false};
  };
  aemcp::native::ProjectContext context;
  context.project_locator = project;
  context.selection_limit = 25;
  ProjectItemMetadataSuccess metadata = success(
      aemcp::native::ProjectItemMetadata{
          item_locator, "", "footage", std::nullopt, "", 0,
          std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt},
      "package-metadata",
      aemcp::native::rpc::digest_project_item_metadata_postcondition(
          aemcp::native::ProjectItemMetadata{
              item_locator, "", "footage", std::nullopt, "", 0,
              std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt}));
  const auto composition_settings = settings(composition_locator, "");
  const aemcp::native::CompositionWorkAreaChanged work_area{
      true, composition_locator, {0, 1, "0"}, {5, 1, "5"},
      {1, 1, "1"}, {4, 1, "4"}};
  const aemcp::native::ProjectItemTextChanged name_change{
      true, item_locator, std::string(1024, 'B'), "After"};
  const aemcp::native::ProjectItemTextChanged comment_change{
      true, item_locator, "Before comment", ""};
  const aemcp::native::ProjectItemLabelChanged label_change{
      true, item_locator, 0, 4};
  auto source_locator = composition_locator;
  source_locator.project_id = "55555555-5555-4555-8555-555555555555";
  source_locator.generation = 9;
  source_locator.object_id = "77777777-7777-4777-8777-777777777777";
  auto duplicate_locator = source_locator;
  duplicate_locator.object_id = "99999999-9999-4999-8999-999999999999";
  const aemcp::native::CompositionDuplicated duplicated{
      true, source_locator, duplicate_locator, 2, 3,
      settings(source_locator, ""), settings(duplicate_locator, "Fixture Copy")};

  auto private_metadata = metadata.value;
  private_metadata.name = "PRIVATE_CUSTOMER_ITEM_NAME_123";
  private_metadata.comment = "PRIVATE_CUSTOMER_COMMENT_456";
  auto private_settings = composition_settings;
  private_settings.name = "PRIVATE_CUSTOMER_COMPOSITION_789";
  auto private_name_change = name_change;
  private_name_change.before_value = "PRIVATE_OLD_NAME";
  private_name_change.after_value = "PRIVATE_NEW_NAME";
  auto private_comment_change = comment_change;
  private_comment_change.before_value = "PRIVATE_OLD_COMMENT";
  private_comment_change.after_value = "PRIVATE_NEW_COMMENT";
  auto private_duplicate = duplicated;
  private_duplicate.source_settings.name = "PRIVATE_SOURCE_COMPOSITION";
  private_duplicate.new_settings.name = "PRIVATE_DUPLICATE_COMPOSITION";
  const std::array<std::string, 8> persistent_package_diagnostics{{
      project_context_persistent_diagnostic_fields(context),
      project_item_metadata_persistent_diagnostic_fields(private_metadata),
      composition_settings_persistent_diagnostic_fields(private_settings),
      composition_work_area_persistent_diagnostic_fields(work_area),
      project_item_name_persistent_diagnostic_fields(private_name_change),
      project_item_comment_persistent_diagnostic_fields(private_comment_change),
      project_item_label_persistent_diagnostic_fields(label_change),
      composition_duplicate_persistent_diagnostic_fields(private_duplicate),
  }};
  for (const std::string& diagnostic : persistent_package_diagnostics) {
    require(diagnostic.find("PRIVATE_") == std::string::npos
            && diagnostic.find("\"projectOpen\"") == std::string::npos,
        "package-150 persistent diagnostics exposed user text or used summary fallback");
  }
  require(persistent_package_diagnostics[0].find("\"selectionReturned\":0")
              != std::string::npos
          && persistent_package_diagnostics[1].find("\"nameRedacted\":true")
              != std::string::npos
          && persistent_package_diagnostics[2].find("\"width\":1920")
              != std::string::npos
          && persistent_package_diagnostics[3].find("\"afterDuration\"")
              != std::string::npos
          && persistent_package_diagnostics[4].find("\"nameRedacted\":true")
              != std::string::npos
          && persistent_package_diagnostics[5].find("\"commentRedacted\":true")
              != std::string::npos
          && persistent_package_diagnostics[6].find("\"afterLabelId\":4")
              != std::string::npos
          && persistent_package_diagnostics[7].find("\"newNameRedacted\":true")
              != std::string::npos,
      "package-150 persistent diagnostics lost their bounded capability branch");

  const std::array<std::string, 8> encoded{{
      body(encode_project_context_success(success(
          context, "package-context",
          aemcp::native::rpc::digest_project_context_postcondition(context)))),
      body(encode_project_item_metadata_success(metadata)),
      body(encode_composition_settings_success(success(
          composition_settings, "package-settings",
          aemcp::native::rpc::digest_composition_settings_postcondition(
              composition_settings)))),
      body(encode_composition_work_area_set_success(success(
          work_area, "package-work-area",
          aemcp::native::rpc::digest_composition_work_area_set_postcondition(
              work_area)))),
      body(encode_project_item_name_set_success(success(
          name_change, "package-name",
          aemcp::native::rpc::digest_project_item_text_set_postcondition(
              "ae.project.item.name.set", name_change)))),
      body(encode_project_item_comment_set_success(success(
          comment_change, "package-comment",
          aemcp::native::rpc::digest_project_item_text_set_postcondition(
              "ae.project.item.comment.set", comment_change)))),
      body(encode_project_item_label_set_success(success(
          label_change, "package-label",
          aemcp::native::rpc::digest_project_item_label_set_postcondition(
              label_change)))),
      body(encode_composition_duplicate_success(success(
          duplicated, "package-duplicate",
          aemcp::native::rpc::digest_composition_duplicate_postcondition(
              duplicated)))),
  }};
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    require(encoded[index].find("\"capabilityId\":\""
            + std::get<1>(requests[index]) + "\"") != std::string::npos,
        "package-150 success encoder emitted the wrong capability branch");
  }

  auto invalid_metadata = metadata;
  invalid_metadata.value.width = 0;
  expect_argument_error([&] {
    (void)encode_project_item_metadata_success(invalid_metadata);
  }, "zero-width optional footage metadata");
  auto invalid_settings = success(
      composition_settings, "package-settings-invalid",
      aemcp::native::rpc::digest_composition_settings_postcondition(
          composition_settings));
  invalid_settings.value.width = 30001;
  expect_argument_error([&] {
    (void)encode_composition_settings_success(invalid_settings);
  }, "oversized composition settings width");
  auto oversized_before_name = name_change;
  oversized_before_name.before_value = std::string(1025, 'B');
  expect_argument_error([&] {
    (void)encode_project_item_name_set_success(success(
        oversized_before_name,
        "package-name-oversized-before",
        std::string(kDigest)));
  }, "project item name result with oversized old name");
}

void layer_timeline_package_parses_and_serializes_all_eight_contracts() {
  const std::string layer_json = locator_json(
      "layer", "88888888-8888-4888-8888-888888888888");
  const std::string parent_json = locator_json(
      "layer", "99999999-9999-4999-8999-999999999999");
  const std::array<std::tuple<std::string, std::string, std::string, std::string>, 8>
      requests{{
          {"invoke-layer-details-read-1", "ae.layer.details.read",
              "{\"layerLocator\":" + layer_json + "}",
              "7f0cec54d090e9689bec73271d13dc754cba93546319f43ef27963d2a4c9e39d"},
          {"invoke-layer-name-set-1", "ae.layer.name.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"name\":\"SYNTHETIC_RENAMED\","
                    "\"idempotencyKey\":\"synthetic-layer-name-0001\"}",
              "f0ff24eea0d779683b686bf2bb3f3abb2d8d8b6acfe02abc19b2533d1f522096"},
          {"invoke-layer-range-set-1", "ae.layer.range.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"inPoint\":{\"value\":1,\"scale\":1},"
                    "\"duration\":{\"value\":4,\"scale\":1},"
                    "\"idempotencyKey\":\"synthetic-layer-range-0001\"}",
              "211b8b14052e62faf235d47ca7da53b0e5511e8ec2447213cfba588b62fe3f76"},
          {"invoke-layer-start-time-set-1", "ae.layer.start-time.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"startTime\":{\"value\":1,\"scale\":1},"
                    "\"idempotencyKey\":\"synthetic-layer-start-0001\"}",
              "e80d97cbfa2c6bfed81278737bec246f9b7f22438fa0dec30048aa0f1f13ac88"},
          {"invoke-layer-stretch-set-1", "ae.layer.stretch.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"stretch\":{\"num\":2,\"den\":1},"
                    "\"idempotencyKey\":\"synthetic-layer-stretch-0001\"}",
              "144f206172feb3ef66bc5012ed0c13ea4aa70dcf6e64623acd4701d96a0315b2"},
          {"invoke-layer-order-set-1", "ae.layer.order.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"targetStackIndex\":2,"
                    "\"idempotencyKey\":\"synthetic-layer-order-0001\"}",
              "35703073b41cc6907e21f51873de59f2471b9ff7d8b349c8d0fe17baa0bfe02e"},
          {"invoke-layer-parent-set-1", "ae.layer.parent.set",
              "{\"layerLocator\":" + layer_json
                  + ",\"parentLayerLocator\":" + parent_json
                  + ",\"idempotencyKey\":\"synthetic-layer-parent-0001\"}",
              "1f3cb8b19c4f269cdc3b102ecf99796ad03097fd9c91531a313beb2f446a5cf5"},
          {"invoke-layer-duplicate-1", "ae.layer.duplicate",
              "{\"layerLocator\":" + layer_json
                  + ",\"newName\":\"SYNTHETIC_COPY\","
                    "\"idempotencyKey\":\"synthetic-layer-duplicate-0001\"}",
              "f1df007516f70e5f837f24a467d5d4849d223ccf0bf1ad466a9908772d78782b"},
      }};
  for (const auto& [request_id, capability_id, arguments, expected_digest] : requests) {
    const ParsedRequest parsed = decode_request_frame(frame(package150_invoke_json(
        request_id, capability_id, arguments)));
    require(parsed.method == RpcMethod::kInvoke
            && std::get<InvokeParams>(parsed.params).capability_id == capability_id,
        "layer timeline parser lost typed capability: " + capability_id);
    require(parsed.request_fingerprint_sha256 == expected_digest,
        "layer timeline request fingerprint drifted: " + capability_id);
  }
  const ParsedRequest stretch_request = decode_request_frame(frame(package150_invoke_json(
      "invoke-layer-stretch-set-1", "ae.layer.stretch.set",
      std::get<2>(requests[4]))));
  const auto& stretch_params = std::get<InvokeParams>(stretch_request.params);
  require(stretch_params.layer_stretch.numerator == 2
          && stretch_params.layer_stretch.denominator == 1
          && stretch_params.layer_stretch.rational == "2",
      "layer stretch parser lost its exact signed ratio");

  expect_codec_error([&] {
    (void)decode_request_frame(frame(package150_invoke_json(
        "layer-details-extra", "ae.layer.details.read",
        "{\"layerLocator\":" + layer_json + ",\"extra\":true}")));
  }, "INVALID_ARGUMENT", "layer details unknown argument");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(package150_invoke_json(
        "layer-stretch-zero", "ae.layer.stretch.set",
        "{\"layerLocator\":" + layer_json
            + ",\"stretch\":{\"num\":0,\"den\":1},"
              "\"idempotencyKey\":\"synthetic-layer-stretch-0001\"}")));
  }, "INVALID_ARGUMENT", "zero layer stretch");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(package150_invoke_json(
        "layer-parent-self", "ae.layer.parent.set",
        "{\"layerLocator\":" + layer_json + ",\"parentLayerLocator\":"
            + layer_json
            + ",\"idempotencyKey\":\"synthetic-layer-parent-0001\"}")));
  }, "INVALID_ARGUMENT", "self layer parent");
  expect_codec_error([&] {
    (void)decode_request_frame(frame(package150_invoke_json(
        "layer-duplicate-missing-name", "ae.layer.duplicate",
        "{\"layerLocator\":" + layer_json
            + ",\"idempotencyKey\":\"synthetic-layer-duplicate-0001\"}")));
  }, "INVALID_ARGUMENT", "layer duplicate without explicit name");

  const auto layer = locator("layer", "88888888-8888-4888-8888-888888888888");
  const auto composition = locator(
      "composition", "66666666-6666-4666-8666-666666666666");
  const auto source = locator("item", "77777777-7777-4777-8777-777777777777");
  const auto parent = locator("layer", "99999999-9999-4999-8999-999999999999");
  const aemcp::native::LayerDetails details{
      layer, composition, 1, "SYNTHETIC_LAYER", "av", true, false, false,
      std::nullopt, source, {0, 1, "0"}, {5, 1, "5"}, {0, 1, "0"},
      {1, 1, "1"}};
  const aemcp::native::LayerNameChanged name{
      true, layer, "SYNTHETIC_LAYER", "SYNTHETIC_RENAMED"};
  const aemcp::native::LayerRangeChanged range{
      true, layer, {0, 1, "0"}, {5, 1, "5"}, {1, 1, "1"}, {4, 1, "4"}};
  const aemcp::native::LayerStartTimeChanged start{
      true, layer, {0, 1, "0"}, {1, 1, "1"}};
  const aemcp::native::LayerStretchChanged stretch{
      true, layer, {1, 1, "1"}, {2, 1, "2"}};
  const aemcp::native::LayerOrderChanged order{true, layer, 1, 2};
  const aemcp::native::LayerParentChanged parent_change{
      true, layer, std::nullopt, parent};

  auto fresh = [](aemcp::native::ObjectLocator value) {
    value.project_id = "55555555-5555-4555-8555-555555555555";
    value.generation = 9;
    return value;
  };
  const auto fresh_source_layer = fresh(layer);
  auto fresh_new_layer = fresh(layer);
  fresh_new_layer.object_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const auto fresh_composition = fresh(composition);
  const auto fresh_source_item = fresh(source);
  const aemcp::native::LayerDetails copied_details{
      fresh_new_layer, fresh_composition, 1, "SYNTHETIC_COPY", "av", true,
      false, false, std::nullopt, fresh_source_item, {0, 1, "0"},
      {5, 1, "5"}, {0, 1, "0"}, {1, 1, "1"}};
  const aemcp::native::LayerDuplicated duplicated{
      true, fresh_source_layer, fresh_new_layer, fresh_composition, 1, 2,
      copied_details, std::nullopt};

  require(digest_layer_details_postcondition(details)
              == "c27e6206d8e817cf572ec68833d7bee7f039377682b9e238b5e041a2c365b972",
      "layer details postcondition drifted from the protocol fixture");
  require(digest_layer_name_set_postcondition(name)
              == "45773dba6579be584663e16eb83e56fa44002d193454f73ce16f8008fa929185",
      "layer name postcondition drifted from the protocol fixture");
  require(digest_layer_range_set_postcondition(range)
              == "37bab85488a04aba9353053a71020344198bdd07f2382e0bbaf262ad86167533",
      "layer range postcondition drifted from the protocol fixture");
  require(digest_layer_start_time_set_postcondition(start)
              == "a3b9f1f8cefc47bd52649652cbf34a93e2dfb6044409afdc5be6d8f27ad7d5c0",
      "layer start postcondition drifted from the protocol fixture");
  require(digest_layer_stretch_set_postcondition(stretch)
              == "bf2ccc8c82c5048b97a89e573d69b18befe38485acb885dc0b396d69213ba5eb",
      "layer stretch postcondition drifted from the protocol fixture");
  require(digest_layer_order_set_postcondition(order)
              == "7df224d5c496122d5b0d937c580fb0f92b67eab47a75b7d3ceeade9badd01fb6",
      "layer order postcondition drifted from the protocol fixture");
  require(digest_layer_parent_set_postcondition(parent_change)
              == "8d0973ba11c31b52a41925c226e7bf72d5a4addcdc027cc85781d63a5dda3166",
      "layer parent postcondition drifted from the protocol fixture");
  require(digest_layer_duplicate_postcondition(duplicated)
              == "11feec12d79b03a39fa0e5f582e58ed61010bfbf812dd57ff9ed470fb632ed62",
      "layer duplicate postcondition drifted from the protocol fixture");

  const auto success = [](auto value, std::string request_id, std::string digest) {
    using Success = aemcp::native::rpc::NativeValueSuccess<decltype(value)>;
    return Success{std::move(request_id), std::string(kSession), std::string(kHost),
        std::move(value), 1'900'000'000'000ULL, 1'900'000'000'025ULL,
        std::string(kDigest), std::move(digest), false};
  };
  const std::array<std::string, 8> encoded{{
      body(encode_layer_details_success(success(
          details, "layer-details", digest_layer_details_postcondition(details)))),
      body(encode_layer_name_set_success(success(
          name, "layer-name", digest_layer_name_set_postcondition(name)))),
      body(encode_layer_range_set_success(success(
          range, "layer-range", digest_layer_range_set_postcondition(range)))),
      body(encode_layer_start_time_set_success(success(
          start, "layer-start", digest_layer_start_time_set_postcondition(start)))),
      body(encode_layer_stretch_set_success(success(
          stretch, "layer-stretch", digest_layer_stretch_set_postcondition(stretch)))),
      body(encode_layer_order_set_success(success(
          order, "layer-order", digest_layer_order_set_postcondition(order)))),
      body(encode_layer_parent_set_success(success(
          parent_change, "layer-parent", digest_layer_parent_set_postcondition(parent_change)))),
      body(encode_layer_duplicate_success(success(
          duplicated, "layer-duplicate", digest_layer_duplicate_postcondition(duplicated)))),
  }};
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    require(encoded[index].find("\"capabilityId\":\"" + std::get<1>(requests[index])
                + "\"") != std::string::npos,
        "layer timeline encoder emitted the wrong capability branch");
  }
  auto bad_duplicate = duplicated;
  bad_duplicate.new_layer.layer_locator = fresh_source_layer;
  expect_argument_error([&] {
    (void)encode_layer_duplicate_success(success(
        bad_duplicate, "layer-duplicate-bad", std::string(kDigest)));
  }, "layer duplicate with mismatched nested locator");
  auto bad_digest = success(name, "layer-name-bad-digest", std::string(kDigest));
  expect_argument_error([&] {
    (void)encode_layer_name_set_success(bad_digest);
  }, "layer name result with unbound postcondition digest");
}

void framing_fragmentation_and_multiple_frames_work() {
  const auto first = frame(hello_json());
  const auto second = frame("{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"cap-default\","
        "\"method\":\"capabilities\",\"params\":{}}");
  FrameDecoder decoder;
  std::vector<ParsedRequest> all;
  for (std::size_t offset = 0; offset < first.size();) {
    const std::size_t size = std::min<std::size_t>((offset % 7) + 1, first.size() - offset);
    auto parsed = decoder.push(std::span(first).subspan(offset, size));
    all.insert(all.end(), parsed.begin(), parsed.end());
    offset += size;
  }
  require(all.size() == 1 && decoder.pending_bytes() == 0, "fragmented frame was not decoded once");
  std::vector<std::uint8_t> joined(first);
  joined.insert(joined.end(), second.begin(), second.end());
  require(joined.size() <= kMaxFrameBytes + 4, "test multiframe chunk violates adapter bound");
  FrameDecoder multi;
  auto parsed = multi.push(joined);
  require(parsed.size() == 2 && parsed[1].method == RpcMethod::kCapabilities,
      "multiple frames in one chunk failed");
  multi.finalize();

  FrameDecoder unfinished;
  (void)unfinished.push(std::span(first).first(first.size() - 1));
  expect_codec_error([&] { unfinished.finalize(); }, "INVALID_REQUEST", "unfinished stream");
  require(unfinished.failed(), "unfinished decoder was not poisoned");
}

void strict_json_and_frame_limits_fail_closed() {
  const std::array<std::pair<std::string, std::string>, 10> cases = {{
    {"duplicate key", "{\"wireVersion\":1,\"wireVersion\":1}"},
    {"trailing bytes", hello_json() + "x"},
    {"invalid escape", "{\"x\":\"\\q\"}"},
    {"lone high surrogate", "{\"x\":\"\\ud800\"}"},
    {"lone low surrogate", "{\"x\":\"\\udc00\"}"},
    {"unsafe integer", invoke_json("unsafe", 9'007'199'254'740'991ULL).replace(
      invoke_json("unsafe", 9'007'199'254'740'991ULL).find("9007199254740991"), 16,
      "9007199254740992")},
    {"non-finite", "{\"wireVersion\":1e999,\"kind\":\"request\"}"},
    {"trailing comma", "{\"wireVersion\":1,}"},
    {"leading zero", "{\"wireVersion\":01}"},
    {"bad literal", "{\"wireVersion\":tru}"},
  }};
  for (const auto& [name, json] : cases) {
    expect_codec_error([&] { (void)decode_request_frame(frame(json)); }, "INVALID_REQUEST", name);
  }

  std::string nested = "0";
  for (int level = 0; level < 17; ++level) nested = "[" + nested + "]";
  expect_codec_error([&] { (void)decode_request_frame(frame(nested)); }, "INVALID_REQUEST", "depth 17");

  std::string nodes = "[";
  for (int index = 0; index < 2'048; ++index) {
    if (index != 0) nodes.push_back(',');
    nodes += "null";
  }
  nodes.push_back(']');
  expect_codec_error([&] { (void)decode_request_frame(frame(nodes)); }, "INVALID_REQUEST", "node 2049");

  std::string long_nonce(8'193, 'a');
  expect_codec_error([&] { (void)decode_request_frame(frame("{\"x\":\"" + long_nonce + "\"}")); },
      "INVALID_REQUEST", "string scalar 8193");

  std::vector<std::uint8_t> invalid_utf8 = {0, 0, 0, 2, 0xc3, 0x28};
  expect_codec_error([&] { (void)decode_request_frame(invalid_utf8); }, "INVALID_REQUEST", "invalid UTF-8");
  expect_codec_error([&] { (void)decode_request_frame(std::array<std::uint8_t, 4>{0, 0, 0, 0}); },
      "INVALID_REQUEST", "zero frame");
  expect_codec_error([&] { (void)decode_request_frame(std::array<std::uint8_t, 4>{0, 1, 0, 1}); },
      "INVALID_REQUEST", "oversize frame");

  std::string maximum_body = hello_json();
  maximum_body.append(kMaxFrameBytes - maximum_body.size(), ' ');
  require(decode_request_frame(frame(maximum_body)).method == RpcMethod::kHello,
      "maximum-size frame was rejected");

  std::string at_depth = "0";
  for (int level = 0; level < 12; ++level) at_depth = "[" + at_depth + "]";
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invoke_json("depth-16", 1'900'000'005'000ULL,
      "{\"x\":" + at_depth + "}")));
  }, "INVALID_ARGUMENT", "depth 16 closed-argument rejection");
  at_depth = "[" + at_depth + "]";
  expect_codec_error([&] {
    (void)decode_request_frame(frame(invoke_json("depth-17", 1'900'000'005'000ULL,
      "{\"x\":" + at_depth + "}")));
  }, "INVALID_REQUEST", "depth 17 parser rejection");
}

void negative_contract_vectors_are_classified() {
  const std::vector<std::tuple<std::string, std::string, std::string>> cases = {
    {"unknown method", "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"bad-1\",\"method\":\"execute\","
        "\"params\":{}}", "INVALID_REQUEST"},
    {"invoke missing session", "{\"wireVersion\":1,\"kind\":\"request\","
      "\"requestId\":\"bad-2\",\"method\":\"invoke\",\"params\":{"
      "\"capabilityId\":\"ae.project.summary\",\"capabilityVersion\":1,"
      "\"arguments\":{}}}", "SESSION_STALE"},
    {"wrong detail enum", "{\"wireVersion\":1,\"kind\":\"request\",\"sessionId\":\""
      + std::string(kSession) + "\",\"requestId\":\"bad-3\","
        "\"method\":\"capabilities\",\"params\":{\"detail\":\"everything\"}}",
      "INVALID_ARGUMENT"},
    {"missing capability version", "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession) + "\",\"requestId\":\"bad-5\","
      "\"method\":\"invoke\",\"params\":{\"capabilityId\":\"ae.project.summary\","
      "\"arguments\":{}}}", "INVALID_ARGUMENT"},
    {"nested executable alias", invoke_json("bad-7", 1'900'000'005'000ULL,
      "{\"payload\":{\"code\":\"synthetic executable input\"}}"), "INVALID_ARGUMENT"},
  };
  for (const auto& [name, json, expected] : cases) {
    expect_codec_error([&] { (void)decode_request_frame(frame(json)); }, expected, name);
  }

  const std::vector<std::uint8_t> overlong = {0, 0, 0, 2, 0xc0, 0xaf};
  expect_codec_error([&] { (void)decode_request_frame(overlong); },
      "INVALID_REQUEST", "overlong UTF-8");
  const std::vector<std::uint8_t> encoded_surrogate = {0, 0, 0, 3, 0xed, 0xa0, 0x80};
  expect_codec_error([&] { (void)decode_request_frame(encoded_surrogate); },
      "INVALID_REQUEST", "UTF-8 encoded surrogate");
}

class FakeClock final : public SessionClock {
 public:
  [[nodiscard]] std::uint64_t now_unix_ms() const noexcept override { return now; }
  std::uint64_t now{1'900'000'000'000ULL};
};

void authorization_session_and_replay_gate_are_bounded() {
  FakeClock clock;
  RpcSessionFrontDoor door(
      "opaque-connection-7", std::string(kHost), std::string(kSession), clock,
      SessionFrontDoorConfig{1, 2, 1'000, 5'000, 30'000});
  const ParsedRequest hello = decode_request_frame(frame(hello_json()));
  require(door.admit(hello).code == SessionIngressCode::kPairingRequired,
      "unauthorized hello was not kept pending");
  const ParsedRequest invoke = decode_request_frame(frame(invoke_json(
      "invoke-1", clock.now + 5'000)));
  require(door.admit(invoke).code == SessionIngressCode::kAuthorizationRequired,
      "unauthorized invoke passed the gate");
  require(door.authorize_pairing(), "pairing authorization failed");
  require(door.admit(invoke).code == SessionIngressCode::kHelloRequired,
      "request was accepted before hello");
  require(door.admit(hello).code == SessionIngressCode::kAcceptedHello && door.hello_complete(),
      "authorized hello did not establish session");
  const auto admitted = door.admit(invoke);
  require(admitted.dispatchable() && admitted.effective_deadline_unix_ms == clock.now + 5'000,
      "valid request was not dispatchable");
  const auto active_duplicate = door.admit(invoke);
  require(active_duplicate.code == SessionIngressCode::kDuplicateRequest
      && active_duplicate.duplicate_content_matches, "active replay was not recognized");

  ParsedRequest mismatched = invoke;
  mismatched.request_fingerprint_sha256[0] = mismatched.request_fingerprint_sha256[0] == 'a' ? 'b' : 'a';
  const auto content_mismatch = door.admit(mismatched);
  require(content_mismatch.code == SessionIngressCode::kDuplicateRequest
      && !content_mismatch.duplicate_content_matches, "content-mismatched replay was not distinguished");

  const ParsedRequest second = decode_request_frame(frame(invoke_json("invoke-2", clock.now + 5'000)));
  require(door.admit(second).code == SessionIngressCode::kLedgerFull,
      "active ledger capacity was not enforced");
  require(door.complete_request("invoke-1") && door.tombstone_count() == 1,
      "terminal tombstone was not recorded");
  require(door.admit(invoke).code == SessionIngressCode::kDuplicateRequest,
      "terminal replay was accepted");
  clock.now += 1'001;
  require(door.admit(second).code == SessionIngressCode::kAcceptedRequest,
      "expired tombstone did not release the request ID ledger");
  door.revoke_pairing();
  require(!door.paired() && door.active_request_count() == 0
      && door.admit(second).code == SessionIngressCode::kAuthorizationRequired,
      "revocation did not purge and close the dispatch gate");
  door.close();
  require(door.admit(hello).code == SessionIngressCode::kClosed && !door.authorize_pairing(),
      "closed session could be reopened");

  RpcSessionFrontDoor mismatch("conn", std::string(kHost), std::string(kSession), clock);
  require(mismatch.authorize_pairing(), "mismatch pairing setup failed");
  const ParsedRequest future = decode_request_frame(frame(hello_json(2, 3)));
  require(mismatch.admit(future).code == SessionIngressCode::kWireVersionMismatch
      && !mismatch.hello_complete(), "wire mismatch established a session");

  RpcSessionFrontDoor deadlines("deadline-conn", std::string(kHost), std::string(kSession), clock);
  require(deadlines.authorize_pairing()
      && deadlines.admit(hello).code == SessionIngressCode::kAcceptedHello,
      "deadline session setup failed");
  const std::string capabilities_without_deadline = "{\"wireVersion\":1,\"kind\":\"request\","
      "\"sessionId\":\"" + std::string(kSession)
      + "\",\"requestId\":\"cap-deadline\",\"method\":\"capabilities\",\"params\":{}}";
  const auto defaulted = deadlines.admit(decode_request_frame(frame(capabilities_without_deadline)));
  require(defaulted.effective_deadline_unix_ms == clock.now + 5'000,
      "omitted deadline did not materialize to five seconds");
  require(deadlines.complete_request("cap-deadline"), "defaulted request did not complete");
  require(deadlines.admit(decode_request_frame(frame(invoke_json("expired", clock.now)))).code
      == SessionIngressCode::kDeadlineExceeded, "expired request entered dispatch");
  require(deadlines.admit(decode_request_frame(frame(invoke_json("too-far", clock.now + 30'001)))).code
      == SessionIngressCode::kInvalidDeadline, "over-maximum deadline entered dispatch");
  std::string wrong_session_json = invoke_json("wrong-session", clock.now + 5'000);
  wrong_session_json.replace(wrong_session_json.find(kSession), kSession.size(),
      "44444444-4444-4444-8444-444444444444");
  require(deadlines.admit(decode_request_frame(frame(wrong_session_json))).code
      == SessionIngressCode::kSessionStale, "cross-session request entered dispatch");
}

void response_helpers_are_bounded_and_typed() {
  HelloSuccess hello;
  hello.request_id = "hello-1";
  hello.session_id = std::string(kSession);
  hello.client_nonce = "abcdefghijklmnopqrstuvwxyzABCDEF";
  hello.plugin_version = "0.0.0-test";
  hello.compiled_sdk_version = "25.6";
  hello.compiled_sdk_build = 61;
  hello.architecture = "arm64";
  hello.host_version = "26.3.0";
  hello.host_build = 87;
  hello.platform = "macos-arm64";
  hello.host_instance_id = std::string(kHost);
  hello.session_generation = 1;
  hello.capabilities_digest = std::string(kDigest);
  const std::string hello_body = body(encode_hello_success(hello));
  require(hello_body.find("\"selectedWireVersion\":1") != std::string::npos
      && hello_body.find("\"clientNonce\":\"abcdefghijklmnopqrstuvwxyzABCDEF\"") != std::string::npos,
      "hello serializer omitted negotiated bindings");

  CapabilitiesSuccess capabilities;
  capabilities.request_id = "capabilities-1";
  capabilities.session_id = std::string(kSession);
  capabilities.detail = CapabilityDetail::kFull;
  capabilities.query_digest = std::string(kDigest);
  capabilities.capabilities_digest = std::string(kCapabilitiesRegistryDigest);
  capabilities.project_summary_contract_digest = std::string(kContractDigest);
  capabilities.project_bit_depth_read_contract_digest =
      std::string(kProjectBitDepthReadContractDigest);
  capabilities.project_bit_depth_set_contract_digest =
      std::string(kProjectBitDepthSetContractDigest);
  capabilities.project_items_list_contract_digest =
      std::string(kProjectItemsContractDigest);
  capabilities.composition_layers_list_contract_digest =
      std::string(kCompositionLayersContractDigest);
  capabilities.composition_time_read_contract_digest =
      std::string(kCompositionTimeContractDigest);
  capabilities.composition_time_set_contract_digest =
      std::string(kCompositionTimeSetContractDigest);
  capabilities.composition_create_contract_digest =
      std::string(kCompositionCreateContractDigest);
  capabilities.composition_layer_create_contract_digest =
      std::string(kCompositionLayerCreateContractDigest);
  capabilities.layer_effect_apply_contract_digest =
      std::string(kLayerEffectApplyContractDigest);
  capabilities.layer_properties_list_contract_digest =
      std::string(kLayerPropertiesContractDigest);
  capabilities.layer_property_keyframes_list_contract_digest =
      std::string(kLayerPropertyKeyframesContractDigest);
  capabilities.layer_property_set_contract_digest =
      std::string(kLayerPropertySetContractDigest);
  capabilities.include_composition_selected_layers_list = true;
  capabilities.composition_selected_layers_list_contract_digest =
      std::string(kCompositionLayersContractDigest);
  capabilities.include_project_context_read = true;
  capabilities.include_project_item_metadata_read = true;
  capabilities.include_composition_settings_read = true;
  capabilities.include_composition_work_area_set = true;
  capabilities.include_project_item_name_set = true;
  capabilities.include_project_item_comment_set = true;
  capabilities.include_project_item_label_set = true;
  capabilities.include_composition_duplicate = true;
  capabilities.project_context_read_contract_digest =
      std::string(kProjectContextReadContractDigest);
  capabilities.project_item_metadata_read_contract_digest =
      std::string(kProjectItemMetadataReadContractDigest);
  capabilities.composition_settings_read_contract_digest =
      std::string(kCompositionSettingsReadContractDigest);
  capabilities.composition_work_area_set_contract_digest =
      std::string(kCompositionWorkAreaSetContractDigest);
  capabilities.project_item_name_set_contract_digest =
      std::string(kProjectItemNameSetContractDigest);
  capabilities.project_item_comment_set_contract_digest =
      std::string(kProjectItemCommentSetContractDigest);
  capabilities.project_item_label_set_contract_digest =
      std::string(kProjectItemLabelSetContractDigest);
  capabilities.composition_duplicate_contract_digest =
      std::string(kCompositionDuplicateContractDigest);
  capabilities.include_layer_details_read = true;
  capabilities.include_layer_name_set = true;
  capabilities.include_layer_range_set = true;
  capabilities.include_layer_start_time_set = true;
  capabilities.include_layer_stretch_set = true;
  capabilities.include_layer_order_set = true;
  capabilities.include_layer_parent_set = true;
  capabilities.include_layer_duplicate = true;
  capabilities.layer_details_read_contract_digest =
      std::string(kLayerDetailsContractDigest);
  capabilities.layer_name_set_contract_digest =
      std::string(kLayerNameContractDigest);
  capabilities.layer_range_set_contract_digest =
      std::string(kLayerRangeContractDigest);
  capabilities.layer_start_time_set_contract_digest =
      std::string(kLayerStartTimeContractDigest);
  capabilities.layer_stretch_set_contract_digest =
      std::string(kLayerStretchContractDigest);
  capabilities.layer_order_set_contract_digest =
      std::string(kLayerOrderContractDigest);
  capabilities.layer_parent_set_contract_digest =
      std::string(kLayerParentContractDigest);
  capabilities.layer_duplicate_contract_digest =
      std::string(kLayerDuplicateContractDigest);
  const std::string capabilities_body = body(encode_capabilities_success(capabilities));
  require(capabilities_body.find("\"additionalProperties\":false") != std::string::npos
      && capabilities_body.find("aemcp.requirement.native.project-read") != std::string::npos
      && capabilities_body.find("aemcp.requirement.native.project-bit-depth-read")
          != std::string::npos
      && capabilities_body.find("aemcp.requirement.native.project-bit-depth-set")
          != std::string::npos
      && capabilities_body.find(
          "\"summary\":\"Read the open After Effects project's bit depth.\"")
          != std::string::npos
      && capabilities_body.find(
          "\"sideEffectSummary\":\"Reads project bit depth without changing After Effects state.\"")
          != std::string::npos
      && capabilities_body.find(
          "\"summary\":\"Set the open After Effects project's bit depth.\"")
          != std::string::npos
      && capabilities_body.find(
          "\"sideEffectSummary\":\"Changes project bit depth and creates one After Effects Undo step.\"")
          != std::string::npos
      && capabilities_body.find(
          "targetDepth must differ from the current project bit depth.")
          != std::string::npos
      && capabilities_body.find(
          "\"bitsPerChannel\":{\"enum\":[8,16,32]}")
          != std::string::npos
      && capabilities_body.find(
          "\"targetDepth\":{\"enum\":[8,16,32]}")
          != std::string::npos
      && capabilities_body.find(
          "beforeBitsPerChannel-must-differ-from-afterBitsPerChannel")
          != std::string::npos
      && capabilities_body.find(std::string(kProjectBitDepthReadContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kProjectBitDepthSetContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kProjectItemsContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kCompositionLayersContractDigest))
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"ae.composition.selected-layers.list\"")
          != std::string::npos
      && capabilities_body.find(
          "List a bounded page of selected layers in one After Effects composition.")
          != std::string::npos
      && capabilities_body.find(
          "aemcp.requirement.native.composition-selected-layers-list")
          != std::string::npos
      && capabilities_body.find(std::string(kCompositionTimeContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kCompositionTimeSetContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kCompositionCreateContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kLayerPropertiesContractDigest))
          != std::string::npos
      && capabilities_body.find(std::string(kLayerPropertyKeyframesContractDigest))
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.property.keyframes.list\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.project.items.list\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.composition.layers.list\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.composition.time.read\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.composition.time.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.composition.create\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.composition.layer.create\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-composition-layer-create-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "Create and verify one named null layer with Undo available.")
          != std::string::npos
      && capabilities_body.find("Controller") == std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.properties.list\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-project-item-metadata-read-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-composition-settings-read-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-composition-work-area-set-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-project-item-name-set-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-project-item-comment-set-stale\"")
          != std::string::npos
      && capabilities_body.find(
          "\"id\":\"aemcp-example-project-item-label-set-stale\"")
          != std::string::npos
      && capabilities_body.find("\"beforeName\":\"SYNTHETIC_ITEM\"")
          != std::string::npos
      && capabilities_body.find("aemcp-example-project-item-metadata-stale")
          == std::string::npos
      && capabilities_body.find("aemcp-example-composition-settings-stale")
          == std::string::npos
      && capabilities_body.find("aemcp-example-composition-work-area-stale")
          == std::string::npos
      && capabilities_body.find("aemcp-example-project-item-name-stale")
          == std::string::npos
      && capabilities_body.find("aemcp-example-project-item-comment-stale")
          == std::string::npos
      && capabilities_body.find("aemcp-example-project-item-label-stale")
          == std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.details.read\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.name.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.range.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.start-time.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.stretch.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.order.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.parent.set\"")
          != std::string::npos
      && capabilities_body.find("\"id\":\"ae.layer.duplicate\"")
          != std::string::npos
      && capabilities_body.find("\"beforeName\":\"\"") == std::string::npos,
      "full capability serializer omitted the closed contract");
  capabilities.capabilities_digest = std::string(kDigest);
  expect_argument_error([&] {
    (void)encode_capabilities_success(capabilities);
  }, "full capability registry digest drift");
  capabilities.include_composition_duplicate = false;
  capabilities.include_layer_details_read = false;
  capabilities.include_layer_name_set = false;
  capabilities.include_layer_range_set = false;
  capabilities.include_layer_start_time_set = false;
  capabilities.include_layer_stretch_set = false;
  capabilities.include_layer_order_set = false;
  capabilities.include_layer_parent_set = false;
  capabilities.include_layer_duplicate = false;
  const std::string filtered_capabilities_body = body(
      encode_capabilities_success(capabilities));
  require(filtered_capabilities_body.find(std::string(kDigest)) != std::string::npos,
      "filtered capability response rejected the advertised full-registry digest");

  const std::string progress_body = body(encode_progress_event(ProgressEvent{
    "invoke-1", std::string(kSession), 1, ProgressPhase::kQueued, 0.25, "Queued safely."}));
  require(progress_body.find("\"fraction\":0.25") != std::string::npos,
      "progress serializer changed the fraction");

  ProjectSummarySuccess summary;
  summary.request_id = "invoke-1";
  summary.session_id = std::string(kSession);
  summary.host_instance_id = std::string(kHost);
  summary.project_open = true;
  summary.project_name = "测试 🎬.aep";
  summary.item_count = 3;
  summary.started_at_unix_ms = 1'900'000'000'000ULL;
  summary.completed_at_unix_ms = 1'900'000'000'025ULL;
  summary.request_digest = std::string(kDigest);
  summary.postcondition_digest = std::string(kDigest);
  const std::string summary_body = body(encode_project_summary_success(summary));
  require(summary_body.find("\"engine\":\"native-aegp\"") != std::string::npos
      && summary_body.find("\"itemCount\":3") != std::string::npos,
      "project summary serializer omitted typed provenance");
  require(digest_project_summary_postcondition(true, "fixture.aep", 3)
      == "0e82d012b2b7f26e310703c35b1d82e744809137f1ea5e6d1920aa29c0baca77",
      "project summary postcondition digest changed its canonical contract");
  expect_argument_error([&] {
    (void)digest_project_summary_postcondition(
        true, "fixture.aep", aemcp::native::rpc::kMaxSafeInteger + 1);
  }, "unsafe postcondition item count");

  ProjectBitDepthReadSuccess bit_depth_read;
  bit_depth_read.request_id = "invoke-bit-depth-read-1";
  bit_depth_read.session_id = std::string(kSession);
  bit_depth_read.host_instance_id = std::string(kHost);
  bit_depth_read.bits_per_channel = 16;
  bit_depth_read.started_at_unix_ms = 1'900'000'000'000ULL;
  bit_depth_read.completed_at_unix_ms = 1'900'000'000'025ULL;
  bit_depth_read.request_digest = std::string(kDigest);
  bit_depth_read.postcondition_digest =
      digest_project_bit_depth_read_postcondition(16);
  require(bit_depth_read.postcondition_digest
          == "0c07bc760ecf8ebf047e2c897e70925683d56c6fdeb96e38fb1983b9d45d8acc",
      "project bit-depth read postcondition digest diverged from JCS");
  const std::string bit_depth_read_body = body(
      encode_project_bit_depth_read_success(bit_depth_read));
  require(bit_depth_read_body.find(
              "\"capabilityId\":\"ae.project.bit-depth.read\"")
          != std::string::npos
          && bit_depth_read_body.find("\"effect\":\"none\"") != std::string::npos
          && bit_depth_read_body.find("\"bitsPerChannel\":16")
            != std::string::npos
          && bit_depth_read_body.find("\"kind\":\"project-bit-depth-read\"")
            != std::string::npos,
      "project bit-depth read serializer omitted typed native evidence");
  bit_depth_read.bits_per_channel = 12;
  expect_argument_error([&] {
    (void)encode_project_bit_depth_read_success(bit_depth_read);
  }, "invalid project bit-depth read enum");
  bit_depth_read.bits_per_channel = 16;
  bit_depth_read.replayed = true;
  expect_argument_error([&] {
    (void)encode_project_bit_depth_read_success(bit_depth_read);
  }, "unvalidated project bit-depth read replay");

  ProjectBitDepthSetSuccess bit_depth_set;
  bit_depth_set.request_id = "invoke-bit-depth-set-1";
  bit_depth_set.session_id = std::string(kSession);
  bit_depth_set.host_instance_id = std::string(kHost);
  bit_depth_set.changed = true;
  bit_depth_set.before_bits_per_channel = 8;
  bit_depth_set.after_bits_per_channel = 16;
  bit_depth_set.started_at_unix_ms = 1'900'000'000'000ULL;
  bit_depth_set.completed_at_unix_ms = 1'900'000'000'025ULL;
  bit_depth_set.request_digest = std::string(kDigest);
  bit_depth_set.postcondition_digest =
      digest_project_bit_depth_set_postcondition(true, 8, 16);
  require(bit_depth_set.postcondition_digest
          == "5316001167cd099990550c70e30341b016e4bdb2aef620b9e92ede1002cbc68a",
      "project bit-depth set postcondition digest diverged from JCS");
  const std::string bit_depth_set_body = body(
      encode_project_bit_depth_set_success(bit_depth_set));
  require(bit_depth_set_body.find(
              "\"capabilityId\":\"ae.project.bit-depth.set\"")
          != std::string::npos
          && bit_depth_set_body.find("\"effect\":\"committed\"")
            != std::string::npos
          && bit_depth_set_body.find(
              "\"undo\":{\"available\":true,\"verified\":false}")
            != std::string::npos
          && bit_depth_set_body.find("groupId") == std::string::npos
          && bit_depth_set_body.find("\"kind\":\"project-bit-depth-set\"")
            != std::string::npos
          && bit_depth_set_body.find(
              "\"afterBitsPerChannel\":16,\"beforeBitsPerChannel\":8,"
              "\"changed\":true") != std::string::npos,
      "project bit-depth set serializer omitted native write or undo evidence");
  bit_depth_set.changed = false;
  expect_argument_error([&] {
    (void)encode_project_bit_depth_set_success(bit_depth_set);
  }, "unchanged project bit-depth write result");
  bit_depth_set.changed = true;
  bit_depth_set.after_bits_per_channel = 8;
  expect_argument_error([&] {
    (void)encode_project_bit_depth_set_success(bit_depth_set);
  }, "project bit-depth write without exact state transition");
  bit_depth_set.after_bits_per_channel = 16;
  bit_depth_set.replayed = true;
  expect_argument_error([&] {
    (void)encode_project_bit_depth_set_success(bit_depth_set);
  }, "business key masquerading as transport replay");

  CancelSuccess cancel;
  cancel.request_id = "cancel-1";
  cancel.session_id = std::string(kSession);
  cancel.target_request_id = "invoke-1";
  cancel.state = CancelState::kQueuedCancelled;
  cancel.terminal_response_expected = true;
  const std::string cancel_body = body(encode_cancel_success(cancel));
  require(cancel_body.find("\"state\":\"queued-cancelled\"") != std::string::npos
      && cancel_body.find("\"terminalResponseExpected\":true") != std::string::npos,
      "cancel serializer omitted its typed terminal contract");
  cancel.terminal_response_expected = false;
  expect_argument_error([&] { (void)encode_cancel_success(cancel); },
      "cancel terminal expectation mismatch");

  ErrorResponse error;
  error.method = RpcMethod::kInvoke;
  error.request_id = "invoke-1";
  error.session_id = std::string(kSession);
  error.code = RpcErrorCode::kQueueFull;
  error.message = "The bounded native queue is full.";
  error.recovery_hint = "Retry after the bounded delay.";
  error.retry_after_ms = 250;
  const std::string error_body = body(encode_error_response(error));
  require(error_body.find("\"code\":\"QUEUE_FULL\"") != std::string::npos
      && error_body.find("\"retryAfterMs\":250") != std::string::npos,
      "error serializer violated the bound policy tuple");

  error.code = RpcErrorCode::kWireVersionMismatch;
  error.method = RpcMethod::kHello;
  error.session_id.reset();
  error.retry_after_ms.reset();
  error.details = ErrorDetails{};
  expect_argument_error([&] { (void)encode_error_response(error); }, "mismatch without supported range");
  summary.project_name = std::string(1'025, 'x');
  expect_argument_error([&] { (void)encode_project_summary_success(summary); }, "oversized project name");
  summary.project_name = "fixture.aep";
  summary.replayed = true;
  expect_argument_error([&] { (void)encode_project_summary_success(summary); },
      "unvalidated replay response");
  summary.replayed = false;
  summary.project_name = std::string("\xc3\x28", 2);
  expect_argument_error([&] { (void)encode_project_summary_success(summary); },
      "invalid UTF-8 project name");
}

void fixed_seed_mutation_fuzz_is_bounded() {
  const auto golden = frame(invoke_json("fuzz-1", 1'900'000'005'000ULL));
  std::uint32_t state = 0x5eed1234U;
  std::size_t accepted = 0;
  std::size_t rejected = 0;
  for (int iteration = 0; iteration < 512; ++iteration) {
    auto candidate = golden;
    state = state * 1'664'525U + 1'013'904'223U;
    const std::size_t mutations = 1 + (state % 4U);
    for (std::size_t count = 0; count < mutations; ++count) {
      state = state * 1'664'525U + 1'013'904'223U;
      const std::size_t index = 4 + (state % (candidate.size() - 4));
      state = state * 1'664'525U + 1'013'904'223U;
      candidate[index] ^= static_cast<std::uint8_t>(1U << (state % 8U));
    }
    try {
      FrameDecoder decoder;
      std::vector<ParsedRequest> parsed;
      std::size_t offset = 0;
      while (offset < candidate.size()) {
        state = state * 1'664'525U + 1'013'904'223U;
        const std::size_t chunk = std::min<std::size_t>(1 + state % 31U, candidate.size() - offset);
        auto values = decoder.push(std::span(candidate).subspan(offset, chunk));
        parsed.insert(parsed.end(), values.begin(), values.end());
        offset += chunk;
      }
      decoder.finalize();
      require(parsed.size() == 1, "accepted fuzz input did not yield exactly one request");
      ++accepted;
    } catch (const CodecError&) {
      ++rejected;
    }
  }
  require(accepted > 0 && rejected > 400, "fixed-seed fuzz did not exercise both paths");
}

}  // namespace

int main() {
  golden_requests_are_typed_and_closed();
  project_bit_depth_invokes_are_closed_and_explicitly_mapped();
  invalidate_graph_requests_and_results_are_closed_and_deterministic();
  project_graph_invokes_and_results_are_closed_and_deterministic();
  project_composition_package_parses_and_serializes_all_eight_contracts();
  layer_timeline_package_parses_and_serializes_all_eight_contracts();
  framing_fragmentation_and_multiple_frames_work();
  strict_json_and_frame_limits_fail_closed();
  negative_contract_vectors_are_classified();
  authorization_session_and_replay_gate_are_bounded();
  response_helpers_are_bounded_and_typed();
  fixed_seed_mutation_fuzz_is_bounded();
  std::cout << "rpc_codec_test: PASS\n";
  return 0;
}

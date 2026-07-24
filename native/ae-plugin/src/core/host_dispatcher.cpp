#include "aemcp_native/host_dispatcher.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace aemcp::native {
namespace {

bool valid_request_id(std::string_view value) {
  if (value.empty() || value.size() > 64) return false;
  const auto ascii_alphanumeric = [](unsigned char character) {
    return (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9');
  };
  if (!ascii_alphanumeric(static_cast<unsigned char>(value.front()))) return false;
  return std::all_of(value.begin() + 1, value.end(), [&](unsigned char character) {
    return ascii_alphanumeric(character) || character == '.' || character == '_'
        || character == ':' || character == '-';
  });
}

bool valid_idempotency_key(std::string_view value) {
  if (value.size() < 16 || value.size() > 64) return false;
  const auto ascii_alphanumeric = [](unsigned char character) {
    return (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9');
  };
  if (!ascii_alphanumeric(static_cast<unsigned char>(value.front()))) return false;
  return std::all_of(value.begin() + 1, value.end(), [&](unsigned char character) {
    return ascii_alphanumeric(character) || character == '.' || character == '_'
        || character == ':' || character == '-';
  });
}

bool valid_bit_depth(std::int32_t value) {
  return value == 8 || value == 16 || value == 32;
}

bool valid_composition_time(const CompositionCurrentTime& value) {
  return value.scale > 0
      && value.seconds_rational
          == canonical_seconds_rational(value.value, value.scale);
}

bool composition_times_equal(
    const CompositionCurrentTime& left,
    const CompositionCurrentTime& right) {
  return static_cast<std::int64_t>(left.value)
          * static_cast<std::int64_t>(right.scale)
      == static_cast<std::int64_t>(right.value)
          * static_cast<std::int64_t>(left.scale);
}

bool has_nondefault_time(const CompositionCurrentTime& value) {
  return value.value != 0 || value.scale != 1 || value.seconds_rational != "0";
}

bool valid_layer_create_color(const CompositionLayerCreateColor& value) {
  return value.red <= 255 && value.green <= 255
      && value.blue <= 255 && value.alpha <= 255;
}

bool valid_positive_ratio(const CompositionPositiveRatio& value) {
  return value.numerator > 0 && value.denominator > 0
      && value.rational == canonical_seconds_rational(
          value.numerator, static_cast<std::uint32_t>(value.denominator));
}

bool valid_layer_stretch(const LayerStretchRatio& value) {
  return value.numerator != 0 && value.denominator > 0
      && value.rational == canonical_seconds_rational(
          value.numerator, static_cast<std::uint32_t>(value.denominator));
}

bool has_layer_timeline_arguments(const Request& request) {
  return request.layer_parent_locator.has_value()
      || has_nondefault_time(request.layer_in_point)
      || has_nondefault_time(request.layer_duration)
      || has_nondefault_time(request.layer_start_time)
      || request.layer_stretch != LayerStretchRatio{}
      || request.target_stack_index != 0 || !request.layer_new_name.empty();
}

bool has_keyframe_arguments(const Request& request) {
  return request.keyframe_time != LayerPropertySampleTime{}
      || !request.keyframe_in_interpolation.empty()
      || !request.keyframe_out_interpolation.empty()
      || !request.keyframe_temporal_ease.empty()
      || !request.keyframe_behavior.empty()
      || request.keyframe_behavior_enabled.has_value();
}

bool has_layer_compositing_arguments(const Request& request) {
  return !request.layer_switch_name.empty()
      || request.layer_switch_enabled.has_value()
      || !request.layer_quality.empty()
      || !request.layer_blending_mode.empty();
}

bool has_native_media_arguments(const Request& request) {
  const NativeMediaCommand& command = request.native_media;
  return !command.host_instance_id.empty() || !command.session_id.empty()
      || !command.operation.empty() || command.layer_locator.has_value()
      || command.item_locator.has_value() || command.folder_locator.has_value()
      || command.offset != 0 || command.limit != 0 || command.effect_index != 0
      || command.installed_effect_key != 0 || command.mask_index != 0
      || command.mask_id != 0 || command.target_index != 0
      || command.enabled.has_value()
      || command.mask_properties.mode.has_value()
      || command.mask_properties.inverted.has_value()
      || command.mask_properties.motion_blur.has_value()
      || command.mask_properties.feather_falloff.has_value()
      || command.mask_properties.color.has_value()
      || command.mask_properties.locked.has_value()
      || command.mask_properties.roto_bezier.has_value()
      || command.mask_closed.has_value() || !command.mask_vertices.empty()
      || !command.source_path.empty() || command.sequence.enabled
      || command.sequence.force_alphabetical || command.sequence.start_frame != -1
      || command.sequence.end_frame != -1 || command.proxy
      || command.interpretation.has_value();
}

bool valid_layer_switch_name(std::string_view value) {
  return value == "visibility" || value == "solo" || value == "locked"
      || value == "shy" || value == "motion-blur" || value == "three-d"
      || value == "adjustment";
}

bool valid_layer_quality(std::string_view value) {
  return value == "wireframe" || value == "draft" || value == "best";
}

bool valid_layer_blending_mode(std::string_view value) {
  static constexpr std::array<std::string_view, 28> modes{
      "normal", "dissolve", "add", "multiply", "screen", "overlay",
      "soft-light", "hard-light", "darken", "lighten", "difference", "hue",
      "saturation", "color", "luminosity", "color-dodge", "color-burn",
      "exclusion", "linear-dodge", "linear-burn", "linear-light", "vivid-light",
      "pin-light", "hard-mix", "lighter-color", "darker-color", "subtract",
      "divide"};
  return std::find(modes.begin(), modes.end(), value) != modes.end();
}

bool valid_composition_create_request(const Request& request) {
  return !request.composition_create_name.empty()
      && request.composition_create_name.size() <= 1024
      && request.composition_create_name.find('\0') == std::string::npos
      && request.composition_create_width >= 1
      && request.composition_create_width <= 30000
      && request.composition_create_height >= 1
      && request.composition_create_height <= 30000
      && request.composition_create_duration.value > 0
      && valid_composition_time(request.composition_create_duration)
      && valid_positive_ratio(request.composition_create_frame_rate)
      && valid_positive_ratio(request.composition_create_pixel_aspect_ratio);
}

bool valid_bounded_text(
    std::string_view value, std::size_t maximum_bytes, bool allow_empty) {
  return (allow_empty || !value.empty()) && value.size() <= maximum_bytes
      && value.find('\0') == std::string_view::npos;
}

bool valid_uuid(std::string_view value);
bool valid_locator(const ObjectLocator& locator);
bool valid_item_locator(const ObjectLocator& locator);

bool native_media_read_operation(std::string_view operation) {
  static constexpr std::array<std::string_view, 8> operations{
      "effects-installed-list",
      "effects-layer-list",
      "effect-details",
      "masks-list",
      "mask-details",
      "mask-path",
      "footage-details",
      "footage-interpretation"};
  return std::find(operations.begin(), operations.end(), operation) != operations.end();
}

bool native_media_write_operation(std::string_view operation) {
  static constexpr std::array<std::string_view, 13> operations{
      "effect-enabled",
      "effect-reorder",
      "effect-duplicate",
      "effect-delete",
      "mask-create",
      "mask-properties",
      "mask-path",
      "mask-duplicate",
      "mask-delete",
      "footage-import",
      "footage-replace",
      "footage-interpretation",
      "footage-proxy"};
  if (std::find(operations.begin(), operations.end(), operation) != operations.end()) {
    return true;
  }
  return operation == "item-use-proxy";
}

bool valid_native_media_locator(
    const std::optional<ObjectLocator>& locator,
    std::string_view kind,
    const NativeMediaCommand& command) {
  return locator.has_value() && valid_locator(*locator)
      && locator->kind == kind
      && locator->host_instance_id == command.host_instance_id
      && locator->session_id == command.session_id;
}

bool valid_native_media_command(
    const NativeMediaCommand& command, bool mutation) {
  if (!valid_uuid(command.host_instance_id) || !valid_uuid(command.session_id)) {
    return false;
  }
  if ((mutation && !native_media_write_operation(command.operation))
      || (!mutation && !native_media_read_operation(command.operation))) {
    return false;
  }
  if (command.offset > 9'007'199'254'740'991ULL || command.limit > 100
      || command.effect_index > 9'007'199'254'740'991ULL
      || command.mask_index > 9'007'199'254'740'991ULL
      || command.target_index > 9'007'199'254'740'991ULL
      || command.mask_vertices.size() > 128
      || command.source_path.size() > 4096
      || command.source_path.find('\0') != std::string::npos) {
    return false;
  }
  const bool needs_layer = command.operation == "effects-layer-list"
      || command.operation == "effect-details"
      || command.operation == "effect-enabled"
      || command.operation == "effect-reorder"
      || command.operation == "effect-duplicate"
      || command.operation == "effect-delete"
      || command.operation == "masks-list"
      || command.operation == "mask-details"
      || command.operation == "mask-path"
      || command.operation == "mask-create"
      || command.operation == "mask-properties"
      || command.operation == "mask-duplicate"
      || command.operation == "mask-delete";
  if (needs_layer
      && !valid_native_media_locator(command.layer_locator, "layer", command)) {
    return false;
  }
  const bool needs_item = command.operation == "footage-details"
      || command.operation == "footage-interpretation"
      || command.operation == "footage-replace"
      || command.operation == "footage-proxy"
      || command.operation == "item-use-proxy";
  if (needs_item && (!command.item_locator.has_value()
      || !valid_item_locator(*command.item_locator)
      || command.item_locator->host_instance_id != command.host_instance_id
      || command.item_locator->session_id != command.session_id)) {
    return false;
  }
  if (command.folder_locator.has_value()
      && (!valid_item_locator(*command.folder_locator)
          || command.folder_locator->kind != "item"
          || command.folder_locator->host_instance_id != command.host_instance_id
          || command.folder_locator->session_id != command.session_id)) {
    return false;
  }
  const bool needs_effect = command.operation == "effect-details"
      || command.operation == "effect-enabled"
      || command.operation == "effect-reorder"
      || command.operation == "effect-duplicate"
      || command.operation == "effect-delete";
  if (needs_effect && (command.effect_index < 1 || command.installed_effect_key == 0)) {
    return false;
  }
  const bool needs_mask = command.operation == "mask-details"
      || command.operation == "mask-path"
      || command.operation == "mask-properties"
      || command.operation == "mask-duplicate"
      || command.operation == "mask-delete";
  if (needs_mask && (command.mask_index < 1 || command.mask_id == 0)) return false;
  if ((command.operation == "effects-installed-list"
          || command.operation == "effects-layer-list"
          || command.operation == "masks-list")
      && command.limit < 1) {
    return false;
  }
  if ((command.operation == "effect-reorder"
          || command.operation == "mask-duplicate")
      && command.target_index < 1) {
    return false;
  }
  if ((command.operation == "effect-enabled"
          || command.operation == "item-use-proxy")
      && !command.enabled.has_value()) {
    return false;
  }
  if ((command.operation == "footage-import"
          || command.operation == "footage-replace"
          || command.operation == "footage-proxy")
      && command.source_path.empty()) {
    return false;
  }
  if ((command.operation == "footage-interpretation")
      && mutation != command.interpretation.has_value()) {
    return false;
  }
  if (command.mask_closed.has_value()) {
    const std::size_t minimum = *command.mask_closed ? 3 : 2;
    if (command.mask_vertices.size() < minimum) return false;
  } else if (!command.mask_vertices.empty()) {
    return false;
  }
  for (const NativeMediaMaskVertex& vertex : command.mask_vertices) {
    if (vertex.position_x.empty() || vertex.position_y.empty()
        || vertex.in_tangent_x.empty() || vertex.in_tangent_y.empty()
        || vertex.out_tangent_x.empty() || vertex.out_tangent_y.empty()) {
      return false;
    }
  }
  return true;
}

bool has_composition_create_arguments(const Request& request) {
  return !request.composition_create_name.empty()
      || request.composition_create_width != 0
      || request.composition_create_height != 0
      || request.composition_create_duration.value != 0
      || request.composition_create_duration.scale != 1
      || request.composition_create_duration.seconds_rational != "0"
      || request.composition_create_frame_rate
          != CompositionPositiveRatio{}
      || request.composition_create_pixel_aspect_ratio
          != CompositionPositiveRatio{};
}

bool valid_layer_create_request(const Request& request) {
  if ((request.layer_create_kind != "null"
          && request.layer_create_kind != "solid")
      || request.layer_create_name.empty()
      || request.layer_create_name.size() > 1024
      || request.layer_create_name.find('\0') != std::string::npos) {
    return false;
  }
  const bool has_solid_options = request.layer_create_color.has_value()
      || request.layer_create_width.has_value()
      || request.layer_create_height.has_value()
      || request.layer_create_duration.has_value();
  if (request.layer_create_kind == "null" && has_solid_options) return false;
  if (request.layer_create_color.has_value()
      && !valid_layer_create_color(*request.layer_create_color)) return false;
  if (request.layer_create_width.has_value()
      && (*request.layer_create_width < 1 || *request.layer_create_width > 30000)) {
    return false;
  }
  if (request.layer_create_height.has_value()
      && (*request.layer_create_height < 1 || *request.layer_create_height > 30000)) {
    return false;
  }
  return !request.layer_create_duration.has_value()
      || valid_composition_time(*request.layer_create_duration);
}

bool valid_layer_effect_match_name(std::string_view value) {
  return !value.empty() && value.size() <= 47
      && value.find('\0') == std::string_view::npos;
}

bool valid_sha256(std::string_view value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char character) {
    return (character >= '0' && character <= '9')
        || (character >= 'a' && character <= 'f');
  });
}

bool valid_uuid(std::string_view value) {
  if (value.size() != 36 || value[8] != '-' || value[13] != '-'
      || value[18] != '-' || value[23] != '-') {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) continue;
    const char character = value[index];
    if (!((character >= '0' && character <= '9')
          || (character >= 'a' && character <= 'f'))) {
      return false;
    }
  }
  return value[14] >= '1' && value[14] <= '5'
      && (value[19] == '8' || value[19] == '9'
          || value[19] == 'a' || value[19] == 'b');
}

bool valid_locator(const ObjectLocator& locator) {
  return (locator.kind == "project" || locator.kind == "item"
          || locator.kind == "composition" || locator.kind == "layer"
          || locator.kind == "stream")
      && valid_uuid(locator.host_instance_id) && valid_uuid(locator.session_id)
      && valid_uuid(locator.project_id) && locator.generation > 0
      && valid_uuid(locator.object_id);
}

bool valid_item_locator(const ObjectLocator& locator) {
  return valid_locator(locator)
      && (locator.kind == "item" || locator.kind == "composition");
}

bool valid_property_value(const LayerPropertyValue& value) {
  if (const auto* scalar = std::get_if<LayerPropertyScalarValue>(&value)) {
    return !scalar->value.empty();
  }
  if (const auto* vector = std::get_if<LayerPropertyVectorValue>(&value)) {
    return (vector->components.size() == 2 || vector->components.size() == 3)
        && std::all_of(vector->components.begin(), vector->components.end(),
            [](const std::string& component) { return !component.empty(); });
  }
  if (const auto* color = std::get_if<LayerPropertyColorValue>(&value)) {
    return !color->alpha.empty() && !color->red.empty()
        && !color->green.empty() && !color->blue.empty();
  }
  return false;
}

bool keyframe_write_capability(std::string_view capability_id) {
  return capability_id == kLayerPropertyKeyframeAddCapability
      || capability_id == kLayerPropertyKeyframeValueSetCapability
      || capability_id == kLayerPropertyKeyframeInterpolationSetCapability
      || capability_id == kLayerPropertyKeyframeTemporalEaseSetCapability
      || capability_id == kLayerPropertyKeyframeBehaviorSetCapability
      || capability_id == kLayerPropertyKeyframeDeleteCapability;
}

bool valid_keyframe_time(const LayerPropertySampleTime& value) {
  return value.value >= std::numeric_limits<std::int32_t>::min()
      && value.value <= std::numeric_limits<std::int32_t>::max()
      && value.scale >= 1
      && value.scale <= std::numeric_limits<std::uint32_t>::max();
}

bool keyframe_times_equal(
    const LayerPropertySampleTime& left,
    const LayerPropertySampleTime& right) {
  // valid_keyframe_time narrows values to int32 and scales to uint32.  Their
  // signed cross-products therefore fit exactly inside int64, including the
  // INT32_MIN * UINT32_MAX boundary, without a non-standard integer type.
  return static_cast<std::int64_t>(left.value)
          * static_cast<std::int64_t>(right.scale)
      == static_cast<std::int64_t>(right.value)
          * static_cast<std::int64_t>(left.scale);
}

bool same_locator_context(const ObjectLocator& left, const ObjectLocator& right) {
  return left.host_instance_id == right.host_instance_id
      && left.session_id == right.session_id
      && left.project_id == right.project_id
      && left.generation == right.generation;
}

bool valid_project_item_entry(const ProjectItemEntry& value) {
  return valid_item_locator(value.locator)
      && valid_bounded_text(value.name, 4096, true)
      && (value.type == "folder" || value.type == "composition"
          || value.type == "footage" || value.type == "unknown")
      && (!value.parent_locator.has_value()
          || (valid_locator(*value.parent_locator)
            && (value.parent_locator->kind == "project"
              || value.parent_locator->kind == "item")
            && same_locator_context(value.locator, *value.parent_locator)));
}

bool valid_composition_settings(const CompositionSettings& value) {
  return valid_locator(value.composition_locator)
      && value.composition_locator.kind == "composition"
      && valid_bounded_text(value.name, 4096, true)
      && value.width >= 1 && value.width <= 30000
      && value.height >= 1 && value.height <= 30000
      && valid_composition_time(value.duration) && value.duration.value > 0
      && valid_composition_time(value.frame_duration)
      && value.frame_duration.value > 0
      && valid_positive_ratio(value.frame_rate)
      && valid_positive_ratio(value.pixel_aspect_ratio)
      && valid_composition_time(value.work_area_start)
      && value.work_area_start.value >= 0
      && valid_composition_time(value.work_area_duration)
      && value.work_area_duration.value > 0
      && valid_composition_time(value.display_start_time);
}

bool valid_layer_type(std::string_view value) {
  return value == "av" || value == "camera" || value == "light"
      || value == "text" || value == "shape" || value == "model3d"
      || value == "null" || value == "adjustment" || value == "unknown";
}

bool valid_layer_details(const LayerDetails& value) {
  if (!valid_locator(value.layer_locator) || value.layer_locator.kind != "layer"
      || !valid_locator(value.composition_locator)
      || value.composition_locator.kind != "composition"
      || !same_locator_context(value.layer_locator, value.composition_locator)
      || value.stack_index < 1 || !valid_bounded_text(value.name, 4096, true)
      || !valid_layer_type(value.type) || !valid_composition_time(value.in_point)
      || !valid_composition_time(value.duration) || value.duration.value <= 0
      || !valid_composition_time(value.start_time)
      || !valid_layer_stretch(value.stretch)) {
    return false;
  }
  if (value.parent_locator.has_value()
      && (!valid_locator(*value.parent_locator)
        || value.parent_locator->kind != "layer"
        || !same_locator_context(value.layer_locator, *value.parent_locator))) {
    return false;
  }
  return !value.source_item_locator.has_value()
      || (valid_item_locator(*value.source_item_locator)
        && same_locator_context(value.layer_locator, *value.source_item_locator));
}

bool valid_layer_compositing_state(const LayerCompositingState& value) {
  return valid_locator(value.layer_locator) && value.layer_locator.kind == "layer"
      && valid_layer_quality(value.quality)
      && valid_layer_blending_mode(value.blending_mode)
      && (value.track_matte == "none" || value.track_matte == "alpha"
          || value.track_matte == "inverted-alpha" || value.track_matte == "luma"
          || value.track_matte == "inverted-luma");
}

bool duplicated_layer_stable_semantics_match(
    const LayerDetails& source, const LayerDetails& duplicate) {
  const auto ratios_equal = [](const LayerStretchRatio& left,
                               const LayerStretchRatio& right) {
    return static_cast<std::int64_t>(left.numerator) * right.denominator
        == static_cast<std::int64_t>(right.numerator) * left.denominator;
  };
  return source.composition_locator == duplicate.composition_locator
      && source.type == duplicate.type
      && source.video_enabled == duplicate.video_enabled
      && source.is_three_d == duplicate.is_three_d
      && source.locked == duplicate.locked
      && source.parent_locator == duplicate.parent_locator
      && source.source_item_locator == duplicate.source_item_locator
      && composition_times_equal(source.in_point, duplicate.in_point)
      && composition_times_equal(source.duration, duplicate.duration)
      && composition_times_equal(source.start_time, duplicate.start_time)
      && ratios_equal(source.stretch, duplicate.stretch);
}

bool composition_settings_equivalent(
    const CompositionSettings& left, const CompositionSettings& right) {
  const auto ratios_equal = [](const CompositionPositiveRatio& lhs,
                               const CompositionPositiveRatio& rhs) {
    return static_cast<std::int64_t>(lhs.numerator) * rhs.denominator
        == static_cast<std::int64_t>(rhs.numerator) * lhs.denominator;
  };
  return left.name == right.name && left.width == right.width
      && left.height == right.height
      && composition_times_equal(left.duration, right.duration)
      && composition_times_equal(left.frame_duration, right.frame_duration)
      && ratios_equal(left.frame_rate, right.frame_rate)
      && ratios_equal(left.pixel_aspect_ratio, right.pixel_aspect_ratio)
      && composition_times_equal(left.work_area_start, right.work_area_start)
      && composition_times_equal(left.work_area_duration, right.work_area_duration)
      && composition_times_equal(left.display_start_time, right.display_start_time)
      && left.layer_count == right.layer_count;
}

bool rebind_creation_replay_session(Completion& replay, const Request& request) {
  const auto rebind = [&](ObjectLocator& locator) {
    if (!valid_locator(locator)
        || locator.host_instance_id != request.host_instance_id) {
      return false;
    }
    locator.session_id = request.session_id;
    return valid_locator(locator);
  };

  if (replay.capability_id == kCompositionCreateCapability) {
    ObjectLocator& composition = replay.composition_create_result.composition_locator;
    return composition.kind == "composition" && rebind(composition);
  }
  if (replay.capability_id == kCompositionDuplicateCapability) {
    CompositionDuplicated& duplicated = replay.composition_duplicate_result;
    return duplicated.source_composition_locator.kind == "composition"
        && duplicated.new_composition_locator.kind == "composition"
        && rebind(duplicated.source_composition_locator)
        && rebind(duplicated.new_composition_locator)
        && same_locator_context(
            duplicated.source_composition_locator,
            duplicated.new_composition_locator);
  }
  if (replay.capability_id == kLayerEffectApplyCapability) {
    ObjectLocator& layer = replay.layer_effect_apply_result.layer_locator;
    return layer.kind == "layer" && rebind(layer);
  }
  if (replay.capability_id == kLayerDuplicateCapability) {
    if (!replay.layer_timeline_result) return false;
    replay.layer_timeline_result = std::make_shared<LayerTimelineResult>(
        *replay.layer_timeline_result);
    auto* duplicated_value = std::get_if<LayerDuplicated>(
        replay.layer_timeline_result.get());
    if (duplicated_value == nullptr) return false;
    LayerDuplicated& duplicated = *duplicated_value;
    LayerDetails& details = duplicated.new_layer;
    if (!duplicated.source_layer.has_value()) return false;
    LayerDetails& source_details = *duplicated.source_layer;
    if (duplicated.source_layer_locator.kind != "layer"
        || duplicated.new_layer_locator.kind != "layer"
        || duplicated.composition_locator.kind != "composition"
        || !rebind(duplicated.source_layer_locator)
        || !rebind(duplicated.new_layer_locator)
        || !rebind(duplicated.composition_locator)
        || !rebind(source_details.layer_locator)
        || !rebind(source_details.composition_locator)
        || !rebind(details.layer_locator)
        || !rebind(details.composition_locator)) {
      return false;
    }
    if (source_details.parent_locator.has_value()
        && !rebind(*source_details.parent_locator)) return false;
    if (source_details.source_item_locator.has_value()
        && !rebind(*source_details.source_item_locator)) return false;
    if (details.parent_locator.has_value()
        && !rebind(*details.parent_locator)) return false;
    if (details.source_item_locator.has_value()
        && !rebind(*details.source_item_locator)) return false;
    return duplicated.source_layer_locator == source_details.layer_locator
        && duplicated.composition_locator == source_details.composition_locator
        && duplicated.new_layer_locator == details.layer_locator
        && duplicated.composition_locator == details.composition_locator
        && duplicated_layer_stable_semantics_match(source_details, details)
        && same_locator_context(
            duplicated.source_layer_locator, duplicated.new_layer_locator)
        && same_locator_context(
            duplicated.composition_locator, duplicated.new_layer_locator);
  }
  if (replay.capability_id != kCompositionLayerCreateCapability) return false;

  CompositionLayerCreated& created = replay.composition_layer_create_result;
  if (created.composition_locator.kind != "composition"
      || created.layer_locator.kind != "layer"
      || !rebind(created.composition_locator)
      || !rebind(created.layer_locator)
      || !same_locator_context(created.composition_locator, created.layer_locator)) {
    return false;
  }
  if (!created.source_item_locator.has_value()) return true;
  ObjectLocator& source = *created.source_item_locator;
  return (source.kind == "item" || source.kind == "composition")
      && rebind(source)
      && same_locator_context(created.composition_locator, source);
}

bool property_value_matches_type(
    const LayerPropertyValue& value, std::string_view value_type) {
  if (value_type == "one-d") {
    return std::holds_alternative<LayerPropertyScalarValue>(value);
  }
  if (value_type == "color") {
    return std::holds_alternative<LayerPropertyColorValue>(value);
  }
  const auto* vector = std::get_if<LayerPropertyVectorValue>(&value);
  if (vector == nullptr) return false;
  if (value_type == "two-d" || value_type == "two-d-spatial") {
    return vector->components.size() == 2;
  }
  if (value_type == "three-d" || value_type == "three-d-spatial") {
    return vector->components.size() == 3;
  }
  return false;
}

std::optional<double> parse_property_decimal(std::string_view value) {
  std::istringstream input{std::string(value)};
  input.imbue(std::locale::classic());
  double parsed = 0.0;
  input >> parsed;
  if (!input || input.peek() != std::char_traits<char>::eof()
      || !std::isfinite(parsed)) {
    return std::nullopt;
  }
  return parsed;
}

bool property_decimals_equal(std::string_view left, std::string_view right) {
  const auto left_value = parse_property_decimal(left);
  const auto right_value = parse_property_decimal(right);
  return left_value.has_value() && right_value.has_value()
      && *left_value == *right_value;
}

bool property_values_semantically_equal(
    const LayerPropertyValue& left, const LayerPropertyValue& right) {
  if (const auto* left_scalar = std::get_if<LayerPropertyScalarValue>(&left)) {
    const auto* right_scalar = std::get_if<LayerPropertyScalarValue>(&right);
    return right_scalar != nullptr
        && property_decimals_equal(left_scalar->value, right_scalar->value);
  }
  if (const auto* left_vector = std::get_if<LayerPropertyVectorValue>(&left)) {
    const auto* right_vector = std::get_if<LayerPropertyVectorValue>(&right);
    if (right_vector == nullptr
        || left_vector->components.size() != right_vector->components.size()) {
      return false;
    }
    for (std::size_t index = 0; index < left_vector->components.size(); ++index) {
      if (!property_decimals_equal(
              left_vector->components[index], right_vector->components[index])) {
        return false;
      }
    }
    return true;
  }
  if (const auto* left_color = std::get_if<LayerPropertyColorValue>(&left)) {
    const auto* right_color = std::get_if<LayerPropertyColorValue>(&right);
    return right_color != nullptr
        && property_decimals_equal(left_color->alpha, right_color->alpha)
        && property_decimals_equal(left_color->red, right_color->red)
        && property_decimals_equal(left_color->green, right_color->green)
        && property_decimals_equal(left_color->blue, right_color->blue);
  }
  return std::holds_alternative<std::monostate>(right);
}

bool valid_route(std::string_view route_id, std::uint64_t session_generation) {
  // Empty/zero is the one legacy in-process route. The authenticated transport
  // supplies an opaque, bounded route; its syntax is deliberately not parsed.
  if (route_id.empty()) return session_generation == 0;
  return session_generation > 0 && route_id.size() <= 128
      && route_id.find('\0') == std::string_view::npos;
}

Completion failure_for(
    const Request& request,
    std::string code,
    std::string message,
    std::string field = {}) {
  Completion completion;
  completion.request_id = request.request_id;
  completion.capability_id = request.capability_id;
  completion.route_id = request.route_id;
  completion.session_generation = request.session_generation;
  completion.idempotency_key = request.idempotency_key;
  completion.error_code = std::move(code);
  completion.message = std::move(message);
  completion.error_field = std::move(field);
  return completion;
}

void hash_combine(std::size_t& seed, std::size_t value) noexcept {
  seed ^= value + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
}

}  // namespace

TimePoint SystemClock::now() const noexcept {
  return std::chrono::steady_clock::now();
}

std::size_t json_encoded_string_size(std::string_view value) noexcept {
  std::size_t result = 2;
  for (const unsigned char character : value) {
    const std::size_t additional = character == '"' || character == '\\'
            || character == '\b' || character == '\f' || character == '\n'
            || character == '\r' || character == '\t'
        ? 2U
        : (character < 0x20U ? 6U : 1U);
    if (result > std::numeric_limits<std::size_t>::max() - additional) {
      return std::numeric_limits<std::size_t>::max();
    }
    result += additional;
  }
  return result;
}

BoundedPageBudget::BoundedPageBudget(
    std::size_t initial_bytes, std::size_t maximum_bytes) noexcept
    : used_bytes_(initial_bytes), maximum_bytes_(maximum_bytes) {}

bool BoundedPageBudget::try_reserve(std::size_t bytes) noexcept {
  if (used_bytes_ > maximum_bytes_ || bytes > maximum_bytes_ - used_bytes_) {
    return false;
  }
  used_bytes_ += bytes;
  return true;
}

HostReadResult HostReadResult::success(ProjectSummary summary) {
  HostReadResult result;
  result.ok = true;
  result.value = std::move(summary);
  return result;
}

HostReadResult HostReadResult::failure(std::string code, std::string detail) {
  HostReadResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostBitDepthReadResult HostBitDepthReadResult::success(ProjectBitDepth value) {
  HostBitDepthReadResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostBitDepthReadResult HostBitDepthReadResult::failure(
    std::string code, std::string detail) {
  HostBitDepthReadResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostBitDepthWriteResult HostBitDepthWriteResult::success(ProjectBitDepthChanged value) {
  HostBitDepthWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostBitDepthWriteResult HostBitDepthWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostBitDepthWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectItemsResult HostProjectItemsResult::success(ProjectItemsPage value) {
  HostProjectItemsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemsResult HostProjectItemsResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectItemsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectContextResult HostProjectContextResult::success(ProjectContext value) {
  HostProjectContextResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectContextResult HostProjectContextResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectContextResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectItemMetadataResult HostProjectItemMetadataResult::success(
    ProjectItemMetadata value) {
  HostProjectItemMetadataResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemMetadataResult HostProjectItemMetadataResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectItemMetadataResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionSettingsResult HostCompositionSettingsResult::success(
    CompositionSettings value) {
  HostCompositionSettingsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionSettingsResult HostCompositionSettingsResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionSettingsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionWorkAreaWriteResult HostCompositionWorkAreaWriteResult::success(
    CompositionWorkAreaChanged value) {
  HostCompositionWorkAreaWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionWorkAreaWriteResult HostCompositionWorkAreaWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionWorkAreaWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectItemTextWriteResult HostProjectItemTextWriteResult::success(
    ProjectItemTextChanged value) {
  HostProjectItemTextWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemTextWriteResult HostProjectItemTextWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectItemTextWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostProjectItemLabelWriteResult HostProjectItemLabelWriteResult::success(
    ProjectItemLabelChanged value) {
  HostProjectItemLabelWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostProjectItemLabelWriteResult HostProjectItemLabelWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostProjectItemLabelWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionDuplicateResult HostCompositionDuplicateResult::success(
    CompositionDuplicated value) {
  HostCompositionDuplicateResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionDuplicateResult HostCompositionDuplicateResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionDuplicateResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionLayersResult HostCompositionLayersResult::success(
    CompositionLayersPage value) {
  HostCompositionLayersResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionLayersResult HostCompositionLayersResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionLayersResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionTimeResult HostCompositionTimeResult::success(
    CompositionTimeRead value) {
  HostCompositionTimeResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionTimeResult HostCompositionTimeResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionTimeResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionTimeWriteResult HostCompositionTimeWriteResult::success(
    CompositionTimeChanged value) {
  HostCompositionTimeWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionTimeWriteResult HostCompositionTimeWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionTimeWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionCreateResult HostCompositionCreateResult::success(
    CompositionCreated value) {
  HostCompositionCreateResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionCreateResult HostCompositionCreateResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionCreateResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostCompositionLayerCreateResult HostCompositionLayerCreateResult::success(
    CompositionLayerCreated value) {
  HostCompositionLayerCreateResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostCompositionLayerCreateResult HostCompositionLayerCreateResult::failure(
    std::string code, std::string detail, std::string field) {
  HostCompositionLayerCreateResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerEffectApplyResult HostLayerEffectApplyResult::success(
    LayerEffectApplied value) {
  HostLayerEffectApplyResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerEffectApplyResult HostLayerEffectApplyResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerEffectApplyResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostNativeMediaResult HostNativeMediaResult::success(
    std::string canonical_value_json) {
  HostNativeMediaResult result;
  result.ok = true;
  result.canonical_value_json = std::move(canonical_value_json);
  return result;
}

HostNativeMediaResult HostNativeMediaResult::failure(
    std::string code, std::string detail, std::string field) {
  HostNativeMediaResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertiesResult HostLayerPropertiesResult::success(
    LayerPropertiesPage value) {
  HostLayerPropertiesResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertiesResult HostLayerPropertiesResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertiesResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframesResult HostLayerPropertyKeyframesResult::success(
    LayerPropertyKeyframesPage value) {
  HostLayerPropertyKeyframesResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframesResult HostLayerPropertyKeyframesResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertyKeyframesResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyWriteResult HostLayerPropertyWriteResult::success(
    LayerPropertyChanged value) {
  HostLayerPropertyWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyWriteResult HostLayerPropertyWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertyWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframeDetailsResult
HostLayerPropertyKeyframeDetailsResult::success(
    LayerPropertyKeyframeDetails value) {
  HostLayerPropertyKeyframeDetailsResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframeDetailsResult
HostLayerPropertyKeyframeDetailsResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertyKeyframeDetailsResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

HostLayerPropertyKeyframeWriteResult
HostLayerPropertyKeyframeWriteResult::success(
    LayerPropertyKeyframeChanged value) {
  HostLayerPropertyKeyframeWriteResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

HostLayerPropertyKeyframeWriteResult
HostLayerPropertyKeyframeWriteResult::failure(
    std::string code, std::string detail, std::string field) {
  HostLayerPropertyKeyframeWriteResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

#define AEMCP_DEFINE_HOST_RESULT(ResultType, ValueType)                        \
  ResultType ResultType::success(ValueType value) {                           \
    ResultType result;                                                        \
    result.ok = true;                                                         \
    result.value = std::move(value);                                          \
    return result;                                                            \
  }                                                                           \
  ResultType ResultType::failure(                                             \
      std::string code, std::string detail, std::string field) {              \
    ResultType result;                                                        \
    result.error_code = std::move(code);                                      \
    result.message = std::move(detail);                                       \
    result.error_field = std::move(field);                                    \
    return result;                                                            \
  }

AEMCP_DEFINE_HOST_RESULT(HostLayerDetailsResult, LayerDetails)
AEMCP_DEFINE_HOST_RESULT(HostLayerNameWriteResult, LayerNameChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerRangeWriteResult, LayerRangeChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerStartTimeWriteResult, LayerStartTimeChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerStretchWriteResult, LayerStretchChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerOrderWriteResult, LayerOrderChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerParentWriteResult, LayerParentChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerDuplicateResult, LayerDuplicated)
AEMCP_DEFINE_HOST_RESULT(HostLayerCompositingReadResult, LayerCompositingState)
AEMCP_DEFINE_HOST_RESULT(HostLayerSwitchWriteResult, LayerSwitchChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerQualityWriteResult, LayerQualityChanged)
AEMCP_DEFINE_HOST_RESULT(HostLayerBlendingModeWriteResult, LayerBlendingModeChanged)

#undef AEMCP_DEFINE_HOST_RESULT

HostProjectGraphInvalidationResult HostProjectGraphInvalidationResult::success(
    ProjectGraphInvalidation value) {
  HostProjectGraphInvalidationResult result;
  result.ok = true;
  result.value = value;
  return result;
}

HostProjectGraphInvalidationResult HostProjectGraphInvalidationResult::failure(
    std::string code, std::string detail) {
  HostProjectGraphInvalidationResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  return result;
}

HostBitDepthReadResult HostApi::read_project_bit_depth(TimePoint) {
  return HostBitDepthReadResult::failure(
      "NATIVE_UNSUPPORTED", "project bit-depth reads are unavailable");
}

HostBitDepthWriteResult HostApi::set_project_bit_depth(std::int32_t, TimePoint) {
  return HostBitDepthWriteResult::failure(
      "NATIVE_UNSUPPORTED", "project bit-depth writes are unavailable");
}

HostProjectItemsResult HostApi::list_project_items(
    const ProjectItemsQuery&, TimePoint) {
  return HostProjectItemsResult::failure(
      "NATIVE_UNSUPPORTED", "project item reads are unavailable");
}

HostProjectContextResult HostApi::read_project_context(
    const ProjectContextQuery&, TimePoint) {
  return HostProjectContextResult::failure(
      "NATIVE_UNSUPPORTED", "project context reads are unavailable");
}

HostProjectItemMetadataResult HostApi::read_project_item_metadata(
    const ProjectItemQuery&, TimePoint) {
  return HostProjectItemMetadataResult::failure(
      "NATIVE_UNSUPPORTED", "project item metadata reads are unavailable");
}

HostCompositionSettingsResult HostApi::read_composition_settings(
    const CompositionSettingsQuery&, TimePoint) {
  return HostCompositionSettingsResult::failure(
      "NATIVE_UNSUPPORTED", "composition settings reads are unavailable");
}

HostCompositionWorkAreaWriteResult HostApi::set_composition_work_area(
    const CompositionWorkAreaSetCommand&, TimePoint) {
  return HostCompositionWorkAreaWriteResult::failure(
      "NATIVE_UNSUPPORTED", "composition work-area writes are unavailable");
}

HostProjectItemTextWriteResult HostApi::set_project_item_name(
    const ProjectItemTextSetCommand&, TimePoint) {
  return HostProjectItemTextWriteResult::failure(
      "NATIVE_UNSUPPORTED", "project item name writes are unavailable");
}

HostProjectItemTextWriteResult HostApi::set_project_item_comment(
    const ProjectItemTextSetCommand&, TimePoint) {
  return HostProjectItemTextWriteResult::failure(
      "NATIVE_UNSUPPORTED", "project item comment writes are unavailable");
}

HostProjectItemLabelWriteResult HostApi::set_project_item_label(
    const ProjectItemLabelSetCommand&, TimePoint) {
  return HostProjectItemLabelWriteResult::failure(
      "NATIVE_UNSUPPORTED", "project item label writes are unavailable");
}

HostCompositionDuplicateResult HostApi::duplicate_composition(
    const CompositionDuplicateCommand&, TimePoint) {
  return HostCompositionDuplicateResult::failure(
      "NATIVE_UNSUPPORTED", "composition duplication is unavailable");
}

HostCompositionLayersResult HostApi::list_composition_layers(
    const CompositionLayersQuery&, TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition layer reads are unavailable");
}

HostCompositionLayersResult HostApi::list_selected_composition_layers(
    const CompositionLayersQuery&, TimePoint) {
  return HostCompositionLayersResult::failure(
      "NATIVE_UNSUPPORTED", "composition selected-layer reads are unavailable");
}

HostCompositionTimeResult HostApi::read_composition_time(
    const CompositionTimeQuery&, TimePoint) {
  return HostCompositionTimeResult::failure(
      "NATIVE_UNSUPPORTED", "composition time reads are unavailable");
}

HostCompositionTimeWriteResult HostApi::set_composition_time(
    const CompositionTimeSetCommand&, TimePoint) {
  return HostCompositionTimeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "composition time writes are unavailable");
}

HostCompositionCreateResult HostApi::create_composition(
    const CompositionCreateCommand&, TimePoint) {
  return HostCompositionCreateResult::failure(
      "NATIVE_UNSUPPORTED", "composition creation is unavailable");
}

HostCompositionLayerCreateResult HostApi::create_composition_layer(
    const CompositionLayerCreateCommand&, TimePoint) {
  return HostCompositionLayerCreateResult::failure(
      "NATIVE_UNSUPPORTED", "composition layer creation is unavailable");
}

HostLayerEffectApplyResult HostApi::apply_layer_effect(
    const LayerEffectApplyCommand&, TimePoint) {
  return HostLayerEffectApplyResult::failure(
      "NATIVE_UNSUPPORTED", "layer effect application is unavailable");
}

HostNativeMediaResult HostApi::execute_native_media(
    const NativeMediaCommand&, TimePoint) {
  return HostNativeMediaResult::failure(
      "NATIVE_UNSUPPORTED", "native media operations are unavailable");
}

HostLayerPropertiesResult HostApi::list_layer_properties(
    const LayerPropertiesQuery&, TimePoint) {
  return HostLayerPropertiesResult::failure(
      "NATIVE_UNSUPPORTED", "layer property reads are unavailable");
}

HostLayerPropertyKeyframesResult HostApi::list_layer_property_keyframes(
    const LayerPropertyKeyframesQuery&, TimePoint) {
  return HostLayerPropertyKeyframesResult::failure(
      "NATIVE_UNSUPPORTED", "layer property keyframe reads are unavailable");
}

HostLayerPropertyWriteResult HostApi::set_layer_property(
    const LayerPropertySetCommand&, TimePoint) {
  return HostLayerPropertyWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer property writes are unavailable");
}

HostLayerPropertyKeyframeDetailsResult
HostApi::read_layer_property_keyframe_details(
    const LayerPropertyKeyframeDetailsQuery&, TimePoint) {
  return HostLayerPropertyKeyframeDetailsResult::failure(
      "NATIVE_UNSUPPORTED", "layer property keyframe detail reads are unavailable");
}

HostLayerPropertyKeyframeWriteResult HostApi::mutate_layer_property_keyframe(
    const LayerPropertyKeyframeMutationCommand&, TimePoint) {
  return HostLayerPropertyKeyframeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer property keyframe writes are unavailable");
}

HostLayerDetailsResult HostApi::read_layer_details(
    const LayerDetailsQuery&, TimePoint) {
  return HostLayerDetailsResult::failure(
      "NATIVE_UNSUPPORTED", "layer detail reads are unavailable");
}

HostLayerNameWriteResult HostApi::set_layer_name(
    const LayerNameSetCommand&, TimePoint) {
  return HostLayerNameWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer name writes are unavailable");
}

HostLayerRangeWriteResult HostApi::set_layer_range(
    const LayerRangeSetCommand&, TimePoint) {
  return HostLayerRangeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer range writes are unavailable");
}

HostLayerStartTimeWriteResult HostApi::set_layer_start_time(
    const LayerStartTimeSetCommand&, TimePoint) {
  return HostLayerStartTimeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer start-time writes are unavailable");
}

HostLayerStretchWriteResult HostApi::set_layer_stretch(
    const LayerStretchSetCommand&, TimePoint) {
  return HostLayerStretchWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer stretch writes are unavailable");
}

HostLayerOrderWriteResult HostApi::set_layer_order(
    const LayerOrderSetCommand&, TimePoint) {
  return HostLayerOrderWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer order writes are unavailable");
}

HostLayerParentWriteResult HostApi::set_layer_parent(
    const LayerParentSetCommand&, TimePoint) {
  return HostLayerParentWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer parent writes are unavailable");
}

HostLayerDuplicateResult HostApi::duplicate_layer(
    const LayerDuplicateCommand&, TimePoint) {
  return HostLayerDuplicateResult::failure(
      "NATIVE_UNSUPPORTED", "layer duplication is unavailable");
}

HostLayerCompositingReadResult HostApi::read_layer_compositing(
    const LayerDetailsQuery&, TimePoint) {
  return HostLayerCompositingReadResult::failure(
      "NATIVE_UNSUPPORTED", "layer compositing reads are unavailable");
}

HostLayerSwitchWriteResult HostApi::set_layer_switch(
    const LayerSwitchSetCommand&, TimePoint) {
  return HostLayerSwitchWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer switch writes are unavailable");
}

HostLayerQualityWriteResult HostApi::set_layer_quality(
    const LayerQualitySetCommand&, TimePoint) {
  return HostLayerQualityWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer quality writes are unavailable");
}

HostLayerBlendingModeWriteResult HostApi::set_layer_blending_mode(
    const LayerBlendingModeSetCommand&, TimePoint) {
  return HostLayerBlendingModeWriteResult::failure(
      "NATIVE_UNSUPPORTED", "layer blending-mode writes are unavailable");
}

HostProjectGraphInvalidationResult HostApi::invalidate_project_graph(TimePoint) {
  return HostProjectGraphInvalidationResult::failure(
      "NATIVE_UNSUPPORTED", "project graph invalidation is unavailable");
}

std::size_t HostDispatcher::RequestKeyHash::operator()(const RequestKey& key) const noexcept {
  std::size_t value = std::hash<std::string>{}(key.route_id);
  hash_combine(value, std::hash<std::uint64_t>{}(key.session_generation));
  hash_combine(value, std::hash<std::string>{}(key.request_id));
  return value;
}

HostDispatcher::HostDispatcher(
    std::thread::id owner_thread, Clock& clock, DispatcherConfig config)
    : owner_thread_(owner_thread), clock_(clock), config_(config) {
  if (owner_thread_ == std::thread::id{} || config_.max_queue_depth == 0
      || config_.max_queue_depth > 256 || config_.max_tasks_per_idle == 0
      || config_.max_tasks_per_idle > 64 || config_.idle_budget.count() <= 0
      || config_.idle_budget > std::chrono::milliseconds(16)
      || config_.max_outbound_depth == 0 || config_.max_outbound_depth > 512
      || config_.max_terminal_tombstones == 0
      || config_.max_terminal_tombstones > 4096
      || config_.terminal_ttl.count() <= 0
      || config_.terminal_ttl > std::chrono::milliseconds(300000)
      || config_.max_route_fences == 0 || config_.max_route_fences > 4096
      || config_.max_idempotency_entries == 0
      || config_.max_idempotency_entries > 4096) {
    throw std::invalid_argument("invalid native host dispatcher configuration");
  }
}

EnqueueResult HostDispatcher::enqueue(Request request) {
  if (!valid_request_id(request.request_id) || request.capability_id.empty()
      || !valid_route(request.route_id, request.session_generation)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_REQUEST"};
  }
  const bool project_summary = request.capability_id == kProjectSummaryCapability;
  const bool project_bit_depth_read =
      request.capability_id == kProjectBitDepthReadCapability;
  const bool project_bit_depth_set =
      request.capability_id == kProjectBitDepthSetCapability;
  const bool project_items_list = request.capability_id == kProjectItemsListCapability;
  const bool composition_layers_list =
      request.capability_id == kCompositionLayersListCapability;
  const bool composition_selected_layers_list =
      request.capability_id == kCompositionSelectedLayersListCapability;
  const bool composition_time_read =
      request.capability_id == kCompositionTimeReadCapability;
  const bool composition_time_set =
      request.capability_id == kCompositionTimeSetCapability;
  const bool composition_create =
      request.capability_id == kCompositionCreateCapability;
  const bool composition_layer_create =
      request.capability_id == kCompositionLayerCreateCapability;
  const bool layer_effect_apply =
      request.capability_id == kLayerEffectApplyCapability;
  const bool layer_properties_list =
      request.capability_id == kLayerPropertiesListCapability;
  const bool layer_property_keyframes_list =
      request.capability_id == kLayerPropertyKeyframesListCapability;
  const bool layer_property_set =
      request.capability_id == kLayerPropertySetCapability;
  const bool keyframe_details_read =
      request.capability_id == kLayerPropertyKeyframeDetailsReadCapability;
  const bool keyframe_write = keyframe_write_capability(request.capability_id);
  const bool project_context_read =
      request.capability_id == kProjectContextReadCapability;
  const bool project_item_metadata_read =
      request.capability_id == kProjectItemMetadataReadCapability;
  const bool composition_settings_read =
      request.capability_id == kCompositionSettingsReadCapability;
  const bool composition_work_area_set =
      request.capability_id == kCompositionWorkAreaSetCapability;
  const bool project_item_name_set =
      request.capability_id == kProjectItemNameSetCapability;
  const bool project_item_comment_set =
      request.capability_id == kProjectItemCommentSetCapability;
  const bool project_item_label_set =
      request.capability_id == kProjectItemLabelSetCapability;
  const bool composition_duplicate =
      request.capability_id == kCompositionDuplicateCapability;
  const bool layer_details_read =
      request.capability_id == kLayerDetailsReadCapability;
  const bool layer_name_set = request.capability_id == kLayerNameSetCapability;
  const bool layer_range_set = request.capability_id == kLayerRangeSetCapability;
  const bool layer_start_time_set =
      request.capability_id == kLayerStartTimeSetCapability;
  const bool layer_stretch_set =
      request.capability_id == kLayerStretchSetCapability;
  const bool layer_order_set = request.capability_id == kLayerOrderSetCapability;
  const bool layer_parent_set = request.capability_id == kLayerParentSetCapability;
  const bool layer_duplicate = request.capability_id == kLayerDuplicateCapability;
  const bool layer_timeline = layer_details_read || layer_name_set || layer_range_set
      || layer_start_time_set || layer_stretch_set || layer_order_set
      || layer_parent_set || layer_duplicate;
  const bool layer_compositing_read =
      request.capability_id == kLayerCompositingReadCapability;
  const bool layer_switch_set = request.capability_id == kLayerSwitchSetCapability;
  const bool layer_quality_set = request.capability_id == kLayerQualitySetCapability;
  const bool layer_blending_mode_set =
      request.capability_id == kLayerBlendingModeSetCapability;
  const bool layer_compositing = layer_compositing_read || layer_switch_set
      || layer_quality_set || layer_blending_mode_set;
  const bool native_media_read =
      request.capability_id == kNativeMediaReadCapability;
  const bool native_media_write =
      request.capability_id == kNativeMediaWriteCapability;
  const bool mutation = project_bit_depth_set || composition_time_set
      || composition_create
      || composition_layer_create
      || layer_effect_apply
      || layer_property_set || keyframe_write || composition_work_area_set
      || project_item_name_set || project_item_comment_set
      || project_item_label_set || composition_duplicate || layer_name_set
      || layer_range_set || layer_start_time_set || layer_stretch_set
      || layer_order_set || layer_parent_set || layer_duplicate
      || layer_switch_set || layer_quality_set || layer_blending_mode_set
      || native_media_write;
  const bool project_graph_invalidate =
      request.capability_id == kProjectGraphInvalidateControl;
  if (!project_summary && !project_bit_depth_read && !project_bit_depth_set
      && !project_items_list && !composition_layers_list
      && !composition_selected_layers_list && !composition_time_read
      && !composition_time_set && !composition_create && !composition_layer_create
      && !layer_effect_apply && !layer_properties_list
      && !layer_property_keyframes_list && !layer_property_set
      && !keyframe_details_read && !keyframe_write
      && !project_context_read && !project_item_metadata_read
      && !composition_settings_read && !composition_work_area_set
      && !project_item_name_set && !project_item_comment_set
      && !project_item_label_set && !composition_duplicate
      && !layer_timeline && !layer_compositing
      && !native_media_read && !native_media_write
      && !project_graph_invalidate) {
    return {EnqueueCode::kUnsupportedCapability, "NATIVE_UNSUPPORTED"};
  }
  if (project_graph_invalidate
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !request.host_instance_id.empty() || !request.session_id.empty()
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !request.layer_create_kind.empty()
          || !request.layer_create_name.empty()
          || request.layer_create_color.has_value()
          || request.layer_create_width.has_value()
          || request.layer_create_height.has_value()
          || request.layer_create_duration.has_value()
          || !request.layer_effect_match_name.empty()
          || request.item_locator.has_value()
          || !request.item_text.empty() || request.item_label_id != 0
          || !request.duplicate_new_name.empty()
          || has_layer_timeline_arguments(request)
          || has_layer_compositing_arguments(request)
          || has_keyframe_arguments(request)
          || has_native_media_arguments(request)
          || has_nondefault_time(request.work_area_start)
          || has_nondefault_time(request.work_area_duration)
          || has_composition_create_arguments(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project graph invalidation parameters are not closed",
        "params"};
  }
  if ((project_summary || project_bit_depth_read)
      && (request.target_depth != 0 || !request.idempotency_key.empty()
        || !request.arguments_fingerprint_sha256.empty()
        || has_native_media_arguments(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native capability arguments failed closed validation",
        "params.arguments"};
  }
  if (project_bit_depth_set && !valid_bit_depth(request.target_depth)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "targetDepth must be one of 8, 16, or 32",
        "params.arguments.targetDepth"};
  }
  if (project_bit_depth_set
      && (!valid_idempotency_key(request.idempotency_key)
        || !valid_sha256(request.arguments_fingerprint_sha256))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native capability arguments failed closed validation",
        "params.arguments"};
  }
  if (layer_property_set
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.parent_property_locator.has_value()
          || !request.layer_locator.has_value()
          || !request.property_locator.has_value()
          || !valid_property_value(request.property_value))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native layer property write arguments failed closed validation",
        "params.arguments"};
  }
  if (keyframe_details_read
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || !request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !valid_keyframe_time(request.keyframe_time))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native keyframe details arguments failed closed validation",
        "params.arguments"};
  }
  if (keyframe_write
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.parent_property_locator.has_value()
          || !request.layer_locator.has_value()
          || !request.property_locator.has_value()
          || !valid_keyframe_time(request.keyframe_time))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native keyframe write arguments failed closed validation",
        "params.arguments"};
  }
  if ((project_items_list || composition_layers_list
          || composition_selected_layers_list || layer_properties_list
          || layer_property_keyframes_list)
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.limit < 1
          || request.limit > ((layer_properties_list
              || layer_property_keyframes_list) ? 25 : 50))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native project graph arguments failed closed validation",
        "params.arguments"};
  }
  if (composition_time_read
      && (request.target_depth != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value() || request.layer_locator.has_value()
          || request.parent_property_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native composition time arguments failed closed validation",
        "params.arguments"};
  }
  if (composition_time_set
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value() || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !valid_composition_time(request.target_time))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native composition time write arguments failed closed validation",
        "params.arguments"};
  }
  if (composition_create
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !request.layer_create_kind.empty()
          || !request.layer_create_name.empty()
          || request.layer_create_color.has_value()
          || request.layer_create_width.has_value()
          || request.layer_create_height.has_value()
          || request.layer_create_duration.has_value()
          || !valid_composition_create_request(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native composition create arguments failed closed validation",
        "params.arguments"};
  }
  if (composition_layer_create
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value() || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !valid_layer_create_request(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native composition layer create arguments failed closed validation",
        "params.arguments"};
  }
  if (layer_effect_apply
      && (request.target_depth != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_uuid(request.host_instance_id) || !valid_uuid(request.session_id)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !request.layer_locator.has_value()
          || !valid_layer_effect_match_name(request.layer_effect_match_name))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native layer effect apply arguments failed closed validation",
        "params.arguments"};
  }
  if ((native_media_read || native_media_write)
      && (request.target_depth != 0
          || (native_media_read && (!request.idempotency_key.empty()
            || !request.arguments_fingerprint_sha256.empty()))
          || (native_media_write && (!valid_idempotency_key(request.idempotency_key)
            || !valid_sha256(request.arguments_fingerprint_sha256)))
          || request.host_instance_id != request.native_media.host_instance_id
          || request.session_id != request.native_media.session_id
          || !valid_native_media_command(request.native_media, native_media_write)
          || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || has_nondefault_time(request.target_time)
          || !request.layer_create_kind.empty() || !request.layer_create_name.empty()
          || request.layer_create_color.has_value()
          || request.layer_create_width.has_value()
          || request.layer_create_height.has_value()
          || request.layer_create_duration.has_value()
          || has_composition_create_arguments(request)
          || !request.layer_effect_match_name.empty()
          || request.item_locator.has_value()
          || has_nondefault_time(request.work_area_start)
          || has_nondefault_time(request.work_area_duration)
          || !request.item_text.empty() || request.item_label_id != 0
          || !request.duplicate_new_name.empty()
          || has_layer_timeline_arguments(request)
          || has_keyframe_arguments(request)
          || has_layer_compositing_arguments(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native media arguments failed closed validation",
        "params.arguments"};
  }
  if (!native_media_read && !native_media_write
      && has_native_media_arguments(request)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "native media arguments are not accepted by this capability",
        "params.arguments"};
  }
  const bool package150_capability = project_context_read
      || project_item_metadata_read || composition_settings_read
      || composition_work_area_set || project_item_name_set
      || project_item_comment_set || project_item_label_set
      || composition_duplicate;
  if (!package150_capability
      && (request.item_locator.has_value() || !request.item_text.empty()
          || request.item_label_id != 0 || !request.duplicate_new_name.empty()
          || has_nondefault_time(request.work_area_start)
          || has_nondefault_time(request.work_area_duration))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project context arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (package150_capability
      && (request.target_depth != 0 || request.project_locator.has_value()
          || request.layer_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || !request.layer_create_kind.empty() || !request.layer_create_name.empty()
          || request.layer_create_color.has_value()
          || request.layer_create_width.has_value()
          || request.layer_create_height.has_value()
          || request.layer_create_duration.has_value()
          || has_composition_create_arguments(request)
          || !request.layer_effect_match_name.empty()
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project context capability arguments failed closed validation",
        "params.arguments"};
  }
  if (project_context_read
      && (request.offset > 9'007'199'254'740'991ULL || request.limit < 1
          || request.limit > 50 || request.composition_locator.has_value()
          || request.item_locator.has_value() || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || !request.item_text.empty() || request.item_label_id != 0
          || !request.duplicate_new_name.empty()
          || has_nondefault_time(request.work_area_start)
          || has_nondefault_time(request.work_area_duration))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project context page arguments failed closed validation",
        "params.arguments"};
  }
  if (project_item_metadata_read
      && (!request.item_locator.has_value()
          || !valid_item_locator(*request.item_locator)
          || request.composition_locator.has_value() || request.offset != 0
          || request.limit != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "itemLocator must be a closed item or composition locator",
        "params.arguments.itemLocator"};
  }
  if (composition_settings_read
      && (!request.composition_locator.has_value()
          || request.item_locator.has_value() || request.offset != 0
          || request.limit != 0 || !request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "compositionLocator is required for composition settings",
        "params.arguments.compositionLocator"};
  }
  const bool package150_item_write = project_item_name_set
      || project_item_comment_set || project_item_label_set;
  if (package150_item_write
      && (!request.item_locator.has_value()
          || !valid_item_locator(*request.item_locator)
          || request.composition_locator.has_value() || request.offset != 0
          || request.limit != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || (project_item_name_set
            && !valid_bounded_text(request.item_text, 1020, false))
          || (project_item_comment_set
            && !valid_bounded_text(request.item_text, 4096, true))
          || (project_item_label_set && request.item_label_id > 16))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "project item write arguments failed closed validation",
        project_item_label_set
            ? "params.arguments.labelId"
            : project_item_name_set
                ? "params.arguments.name" : "params.arguments.comment"};
  }
  if (composition_work_area_set
      && (!request.composition_locator.has_value()
          || request.item_locator.has_value() || request.offset != 0
          || request.limit != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_composition_time(request.work_area_start)
          || request.work_area_start.value < 0
          || !valid_composition_time(request.work_area_duration)
          || request.work_area_duration.value <= 0)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "composition work-area arguments failed closed validation",
        request.work_area_start.value < 0
            ? "params.arguments.start" : "params.arguments.duration"};
  }
  if (composition_duplicate
      && (!request.composition_locator.has_value()
          || request.item_locator.has_value() || request.offset != 0
          || request.limit != 0
          || !valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256)
          || !valid_bounded_text(request.duplicate_new_name, 1020, false))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "composition duplicate arguments failed closed validation",
        "params.arguments.newName"};
  }
  if (layer_timeline
      && (request.target_depth != 0 || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || request.item_locator.has_value()
          || !request.layer_locator.has_value()
          || !valid_locator(*request.layer_locator)
          || request.layer_locator->kind != "layer"
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id)
          || has_layer_compositing_arguments(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer timeline arguments failed closed validation",
        "params.arguments.layerLocator"};
  }
  if (layer_timeline
      && (request.layer_locator->host_instance_id != request.host_instance_id
          || request.layer_locator->session_id != request.session_id)) {
    return {
        EnqueueCode::kInvalidRequest,
        "STALE_LOCATOR",
        "layerLocator belongs to another host or native session",
        "params.arguments.layerLocator"};
  }
  if (layer_details_read
      && (!request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || has_layer_timeline_arguments(request))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer detail read accepts only layerLocator",
        "params.arguments"};
  }
  if (layer_timeline && !layer_details_read
      && (!valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer write requires a valid idempotency key and argument digest",
        "params.arguments.idempotencyKey"};
  }
  if (layer_name_set
      && (!valid_bounded_text(request.layer_new_name, 1020, false)
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || has_nondefault_time(request.layer_start_time)
          || request.layer_stretch != LayerStretchRatio{}
          || request.target_stack_index != 0)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer name arguments failed closed validation", "params.arguments.name"};
  }
  if (layer_range_set
      && (!valid_composition_time(request.layer_in_point)
          || !valid_composition_time(request.layer_duration)
          || request.layer_duration.value <= 0
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_start_time)
          || request.layer_stretch != LayerStretchRatio{}
          || request.target_stack_index != 0 || !request.layer_new_name.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer range arguments failed closed validation", "params.arguments"};
  }
  if (layer_start_time_set
      && (!valid_composition_time(request.layer_start_time)
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || request.layer_stretch != LayerStretchRatio{}
          || request.target_stack_index != 0 || !request.layer_new_name.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer start-time arguments failed closed validation",
        "params.arguments.startTime"};
  }
  if (layer_stretch_set
      && (!valid_layer_stretch(request.layer_stretch)
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || has_nondefault_time(request.layer_start_time)
          || request.target_stack_index != 0 || !request.layer_new_name.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer stretch arguments failed closed validation", "params.arguments.stretch"};
  }
  if (layer_order_set
      && (request.target_stack_index < 1
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || has_nondefault_time(request.layer_start_time)
          || request.layer_stretch != LayerStretchRatio{}
          || !request.layer_new_name.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer order arguments failed closed validation",
        "params.arguments.targetStackIndex"};
  }
  if (layer_parent_set
      && (has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || has_nondefault_time(request.layer_start_time)
          || request.layer_stretch != LayerStretchRatio{}
          || request.target_stack_index != 0 || !request.layer_new_name.empty()
          || (request.layer_parent_locator.has_value()
            && (!valid_locator(*request.layer_parent_locator)
              || request.layer_parent_locator->kind != "layer"
              || !same_locator_context(
                  *request.layer_locator, *request.layer_parent_locator))))) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer parent arguments failed closed validation",
        "params.arguments.parentLayerLocator"};
  }
  if (layer_duplicate
      && (!valid_bounded_text(request.layer_new_name, 1020, false)
          || request.layer_parent_locator.has_value()
          || has_nondefault_time(request.layer_in_point)
          || has_nondefault_time(request.layer_duration)
          || has_nondefault_time(request.layer_start_time)
          || request.layer_stretch != LayerStretchRatio{}
          || request.target_stack_index != 0)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer duplicate arguments failed closed validation",
        "params.arguments.newName"};
  }
  if (!layer_timeline && has_layer_timeline_arguments(request)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer timeline arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (layer_compositing
      && (request.target_depth != 0 || request.offset != 0 || request.limit != 0
          || request.project_locator.has_value()
          || request.composition_locator.has_value()
          || request.parent_property_locator.has_value()
          || request.property_locator.has_value()
          || !std::holds_alternative<std::monostate>(request.property_value)
          || request.item_locator.has_value()
          || !request.layer_locator.has_value()
          || !valid_locator(*request.layer_locator)
          || request.layer_locator->kind != "layer"
          || request.layer_locator->host_instance_id != request.host_instance_id
          || request.layer_locator->session_id != request.session_id
          || !valid_uuid(request.host_instance_id)
          || !valid_uuid(request.session_id)
          || has_layer_timeline_arguments(request)
          || has_keyframe_arguments(request))) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer compositing arguments failed closed validation",
        "params.arguments.layerLocator"};
  }
  if (layer_compositing_read
      && (!request.idempotency_key.empty()
          || !request.arguments_fingerprint_sha256.empty()
          || has_layer_compositing_arguments(request))) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer compositing read accepts only layerLocator", "params.arguments"};
  }
  if (layer_compositing && !layer_compositing_read
      && (!valid_idempotency_key(request.idempotency_key)
          || !valid_sha256(request.arguments_fingerprint_sha256))) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer compositing write requires idempotency and argument digest",
        "params.arguments.idempotencyKey"};
  }
  if (layer_switch_set
      && (!valid_layer_switch_name(request.layer_switch_name)
          || !request.layer_switch_enabled.has_value()
          || !request.layer_quality.empty() || !request.layer_blending_mode.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer switch arguments failed closed validation", "params.arguments.switch"};
  }
  if (layer_quality_set
      && (!valid_layer_quality(request.layer_quality)
          || !request.layer_switch_name.empty()
          || request.layer_switch_enabled.has_value()
          || !request.layer_blending_mode.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer quality arguments failed closed validation", "params.arguments.quality"};
  }
  if (layer_blending_mode_set
      && (!valid_layer_blending_mode(request.layer_blending_mode)
          || !request.layer_switch_name.empty()
          || request.layer_switch_enabled.has_value() || !request.layer_quality.empty())) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer blending-mode arguments failed closed validation", "params.arguments.mode"};
  }
  if (!layer_compositing && has_layer_compositing_arguments(request)) {
    return {EnqueueCode::kInvalidRequest, "INVALID_ARGUMENT",
        "layer compositing arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (!composition_layer_create
      && (!request.layer_create_kind.empty()
          || !request.layer_create_name.empty()
          || request.layer_create_color.has_value()
          || request.layer_create_width.has_value()
          || request.layer_create_height.has_value()
          || request.layer_create_duration.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "composition layer create arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (!composition_create && has_composition_create_arguments(request)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "composition create arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (!layer_effect_apply && !request.layer_effect_match_name.empty()) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer effect apply arguments are not accepted by this capability",
        "params.arguments"};
  }
  if (project_items_list
      && ((request.offset > 0 && !request.project_locator.has_value())
          || request.composition_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "projectLocator must be supplied for non-zero offsets",
        "params.arguments.projectLocator"};
  }
  if (project_items_list && request.project_locator.has_value()) {
    const ObjectLocator& locator = *request.project_locator;
    if (!valid_locator(locator) || locator.kind != "project") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "projectLocator must be a closed project locator",
          "params.arguments.projectLocator"};
    }
    if (locator.host_instance_id != request.host_instance_id
        || locator.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "projectLocator belongs to another host or native session",
          "params.arguments.projectLocator"};
    }
  }
  if ((composition_layers_list || composition_selected_layers_list
          || composition_time_read || composition_time_set
          || composition_layer_create || composition_settings_read
          || composition_work_area_set || composition_duplicate)
      && (request.project_locator.has_value() || !request.composition_locator.has_value())) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "compositionLocator is required for composition reads",
        "params.arguments.compositionLocator"};
  }
  if (composition_layers_list || composition_selected_layers_list
      || composition_time_read || composition_time_set
      || composition_layer_create || composition_settings_read
      || composition_work_area_set || composition_duplicate) {
    const ObjectLocator& locator = *request.composition_locator;
    if (!valid_locator(locator) || locator.kind != "composition") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "compositionLocator must be a closed composition locator",
          "params.arguments.compositionLocator"};
    }
    if (locator.host_instance_id != request.host_instance_id
        || locator.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "compositionLocator belongs to another host or native session",
          "params.arguments.compositionLocator"};
      }
  }
  if (project_item_metadata_read || package150_item_write) {
    const ObjectLocator& locator = *request.item_locator;
    if (locator.host_instance_id != request.host_instance_id
        || locator.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "itemLocator belongs to another host or native session",
          "params.arguments.itemLocator"};
    }
  }
  if ((layer_properties_list || layer_property_keyframes_list
          || layer_property_set || layer_effect_apply || layer_timeline
          || layer_compositing
          || keyframe_details_read || keyframe_write)
      && (request.project_locator.has_value()
          || request.composition_locator.has_value()
          || ((layer_property_keyframes_list || keyframe_details_read)
              ? !request.property_locator.has_value()
              : !request.layer_locator.has_value()))) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        (layer_property_keyframes_list || keyframe_details_read)
            ? "propertyLocator is required for keyframe access"
            : "layerLocator is required for layer property access",
        (layer_property_keyframes_list || keyframe_details_read)
            ? "params.arguments.propertyLocator"
            : "params.arguments.layerLocator"};
  }
  if (layer_property_keyframes_list || keyframe_details_read) {
    const ObjectLocator& property = *request.property_locator;
    if (!valid_locator(property) || property.kind != "stream") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "propertyLocator must be a closed stream locator",
          "params.arguments.propertyLocator"};
    }
    if (property.host_instance_id != request.host_instance_id
        || property.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "propertyLocator belongs to another host or native session",
          "params.arguments.propertyLocator"};
    }
    if (request.layer_locator.has_value()
        || request.parent_property_locator.has_value()
        || !std::holds_alternative<std::monostate>(request.property_value)) {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "unrelated layer property arguments are not accepted by the keyframe read",
          "params.arguments"};
    }
  } else if (layer_properties_list || layer_property_set || layer_effect_apply
      || layer_timeline || layer_compositing || keyframe_write) {
    const ObjectLocator& layer = *request.layer_locator;
    if (!valid_locator(layer) || layer.kind != "layer") {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "layerLocator must be a closed layer locator",
          "params.arguments.layerLocator"};
    }
    if (layer.host_instance_id != request.host_instance_id
        || layer.session_id != request.session_id) {
      return {
          EnqueueCode::kInvalidRequest,
          "STALE_LOCATOR",
          "layerLocator belongs to another host or native session",
          "params.arguments.layerLocator"};
    }
    if (layer_properties_list && request.parent_property_locator.has_value()) {
      const ObjectLocator& parent = *request.parent_property_locator;
      if (!valid_locator(parent) || parent.kind != "stream") {
        return {
            EnqueueCode::kInvalidRequest,
            "INVALID_ARGUMENT",
            "parentPropertyLocator must be a closed stream locator",
            "params.arguments.parentPropertyLocator"};
      }
      if (parent.host_instance_id != request.host_instance_id
          || parent.session_id != request.session_id
          || parent.project_id != layer.project_id
          || parent.generation != layer.generation) {
        return {
            EnqueueCode::kInvalidRequest,
            "STALE_LOCATOR",
            "parentPropertyLocator belongs to another layer session",
            "params.arguments.parentPropertyLocator"};
      }
    }
    if (layer_properties_list
        && (request.property_locator.has_value()
            || !std::holds_alternative<std::monostate>(request.property_value))) {
      return {
          EnqueueCode::kInvalidRequest,
          "INVALID_ARGUMENT",
          "property write arguments are not accepted by the read capability",
          "params.arguments"};
    }
    if (layer_property_set || keyframe_write) {
      const ObjectLocator& property = *request.property_locator;
      if (!valid_locator(property) || property.kind != "stream") {
        return {
            EnqueueCode::kInvalidRequest,
            "INVALID_ARGUMENT",
            "propertyLocator must be a closed stream locator",
            "params.arguments.propertyLocator"};
      }
      if (!same_locator_context(*request.layer_locator, property)) {
        return {
            EnqueueCode::kInvalidRequest,
            "STALE_LOCATOR",
            "propertyLocator belongs to another layer session",
            "params.arguments.propertyLocator"};
      }
      if (keyframe_write) {
        const bool value_write = request.capability_id == kLayerPropertyKeyframeAddCapability
            || request.capability_id == kLayerPropertyKeyframeValueSetCapability;
        const bool interpolation_write =
            request.capability_id == kLayerPropertyKeyframeInterpolationSetCapability;
        const bool ease_write =
            request.capability_id == kLayerPropertyKeyframeTemporalEaseSetCapability;
        const bool behavior_write =
            request.capability_id == kLayerPropertyKeyframeBehaviorSetCapability;
        const auto interpolation_valid = [](std::string_view value) {
          return value == "linear" || value == "bezier" || value == "hold";
        };
        constexpr std::array<std::string_view, 5> behaviors = {
            "temporal-continuous", "temporal-auto-bezier", "spatial-continuous",
            "spatial-auto-bezier", "roving"};
        const bool ease_valid = !request.keyframe_temporal_ease.empty()
            && request.keyframe_temporal_ease.size() <= 4
            && std::all_of(
                request.keyframe_temporal_ease.begin(),
                request.keyframe_temporal_ease.end(),
                [&](const LayerPropertyKeyframeDimensionEase& dimension) {
                  return dimension.dimension
                      == static_cast<std::size_t>(
                          &dimension - request.keyframe_temporal_ease.data());
                });
        if ((value_write && !valid_property_value(request.property_value))
            || (interpolation_write
                && (!interpolation_valid(request.keyframe_in_interpolation)
                    || !interpolation_valid(request.keyframe_out_interpolation)))
            || (ease_write && !ease_valid)
            || (behavior_write
                && (std::find(
                        behaviors.begin(), behaviors.end(), request.keyframe_behavior)
                    == behaviors.end()
                    || !request.keyframe_behavior_enabled.has_value()))) {
          return {
              EnqueueCode::kInvalidRequest,
              "INVALID_ARGUMENT",
              "keyframe write payload is invalid",
              "params.arguments"};
        }
      }
    }
  } else if (request.layer_locator.has_value()
      || request.parent_property_locator.has_value()
      || request.property_locator.has_value()
      || !std::holds_alternative<std::monostate>(request.property_value)) {
    return {
        EnqueueCode::kInvalidRequest,
        "INVALID_ARGUMENT",
        "layer property locators are not accepted by this capability",
        "params.arguments"};
  }
  const TimePoint now = clock_.now();
  if (request.deadline <= now) {
    return {EnqueueCode::kDeadlineExceeded, "DEADLINE_EXCEEDED"};
  }

  std::lock_guard lock(mutex_);
  if (state_ != State::kRunning) {
    return {EnqueueCode::kShuttingDown, "AE_SHUTTING_DOWN"};
  }
  purge_terminal_locked(now);
  const RequestKey key = key_for(request);
  if (route_stale_locked(key.route_id, key.session_generation)) {
    return {EnqueueCode::kStaleRoute, "SESSION_STALE"};
  }
  if (active_requests_.contains(key) || terminal_locked(key)
      || pending_outbound_locked(key)) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  if (mutation) {
    const auto existing = idempotency_ledger_.find(request.idempotency_key);
    if (existing != idempotency_ledger_.end()) {
      const bool same_arguments = existing->second.arguments_fingerprint_sha256
          == request.arguments_fingerprint_sha256;
      if ((composition_create || composition_layer_create || layer_effect_apply
              || composition_duplicate || layer_duplicate)
          && same_arguments
          && existing->second.state == IdempotencyState::kSucceeded
          && existing->second.replay_completion.has_value()) {
        if (outbound_.size() + active_requests_.size() >= config_.max_outbound_depth) {
          return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
        }
        Completion replay = *existing->second.replay_completion;
        if (rebind_creation_replay_session(replay, request)) {
          replay.request_id = request.request_id;
          replay.route_id = request.route_id;
          replay.session_generation = request.session_generation;
          replay.idempotency_key = request.idempotency_key;
          replay.replayed = true;
          replay.route_revoked = false;
          finish_request_locked(key, replay, now);
          return {EnqueueCode::kAccepted, {}};
        }
        existing->second.state = IdempotencyState::kAmbiguous;
        existing->second.replay_completion.reset();
      }
      return {
          EnqueueCode::kDuplicateRequest,
          "DUPLICATE_REQUEST",
          same_arguments && existing->second.state == IdempotencyState::kAmbiguous
              ? "idempotency key outcome requires current-state inspection before any new intent"
              : same_arguments
              ? "idempotency key already reserved or committed; inspect the original request"
              : "idempotency key is already bound to different arguments",
          "params.arguments.idempotencyKey"};
    }
  }
  if (queue_.size() >= config_.max_queue_depth
      || outbound_.size() + active_requests_.size() >= config_.max_outbound_depth) {
    return {EnqueueCode::kQueueFull, "QUEUE_FULL"};
  }
  if (mutation
      && idempotency_ledger_.size() >= config_.max_idempotency_entries) {
    return {
        EnqueueCode::kQueueFull,
        "QUEUE_FULL",
        "native idempotency ledger is full; restart After Effects and use a new key",
        "params.arguments.idempotencyKey"};
  }
  const auto [active, inserted] = active_requests_.insert(key);
  if (!inserted) {
    return {EnqueueCode::kDuplicateRequest, "DUPLICATE_REQUEST"};
  }
  bool idempotency_reserved = false;
  const std::string reserved_idempotency_key = request.idempotency_key;
  try {
    if (mutation) {
      const bool reserved = idempotency_ledger_.emplace(
          request.idempotency_key,
          IdempotencyEntry{
              request.arguments_fingerprint_sha256,
              IdempotencyState::kReserved,
              std::nullopt}).second;
      if (!reserved) {
        active_requests_.erase(active);
        return {
            EnqueueCode::kDuplicateRequest,
            "DUPLICATE_REQUEST",
            "idempotency key was concurrently reserved",
            "params.arguments.idempotencyKey"};
      }
      idempotency_reserved = true;
    }
    queue_.push_back(std::move(request));
  } catch (...) {
    if (idempotency_reserved) idempotency_ledger_.erase(reserved_idempotency_key);
    active_requests_.erase(active);
    throw;
  }
  return {EnqueueCode::kAccepted, {}};
}

CancelResult HostDispatcher::cancel(
    std::string_view route_id,
    std::uint64_t session_generation,
    std::string_view target_request_id) {
  if (!valid_route(route_id, session_generation) || !valid_request_id(target_request_id)) {
    return {CancelCode::kInvalidRequest, false};
  }

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  RequestKey key{std::string(route_id), session_generation, std::string(target_request_id)};
  if (terminal_locked(key) || pending_outbound_locked(key)) {
    return {CancelCode::kAlreadyTerminal, false};
  }
  if (route_revoked_locked(route_id, session_generation)) {
    return {CancelCode::kStaleRoute, false};
  }

  const auto queued = std::find_if(queue_.begin(), queue_.end(), [&](const Request& request) {
    return request.route_id == route_id && request.session_generation == session_generation
        && request.request_id == target_request_id;
  });
  if (queued != queue_.end()) {
    Completion completion = failure_for(
        *queued, "CANCELLED", "native request was cancelled before host dispatch");
    finish_idempotency_locked(*queued, completion);
    queue_.erase(queued);
    finish_request_locked(key, completion, now);
    return {CancelCode::kQueuedCancelled, true};
  }
  if (active_requests_.contains(key)) {
    return {CancelCode::kRunningNotCancellable, true};
  }
  if (route_stale_locked(route_id, session_generation)) {
    return {CancelCode::kStaleRoute, false};
  }
  return {CancelCode::kNotFound, false};
}

RouteRevocationResult HostDispatcher::revoke_route(
    std::string_view route_id, std::uint64_t session_generation) {
  RouteRevocationResult result;
  if (!valid_route(route_id, session_generation)) return result;

  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  purge_terminal_locked(now);
  result.fence_recorded = fence_route_locked(std::string(route_id), session_generation);
  result.fence_saturated = route_fences_saturated_;

  for (Completion& completion : outbound_) {
    if (completion.route_id == route_id
        && completion.session_generation <= session_generation
        && !completion.route_revoked) {
      completion.route_revoked = true;
      ++result.pending_outbound_marked;
    }
  }

  auto queued = queue_.begin();
  while (queued != queue_.end()) {
    if (queued->route_id != route_id || queued->session_generation > session_generation) {
      ++queued;
      continue;
    }
    const RequestKey key = key_for(*queued);
    Completion completion = failure_for(
        *queued, "CANCELLED", "native request route was revoked before host dispatch");
    completion.route_revoked = true;
    finish_idempotency_locked(*queued, completion);
    queued = queue_.erase(queued);
    finish_request_locked(key, completion, now);
    ++result.queued_cancelled;
  }

  for (const RequestKey& key : active_requests_) {
    if (key.route_id == route_id && key.session_generation <= session_generation) {
      if (detached_requests_.insert(key).second) ++result.running_detached;
    }
  }
  return result;
}

DrainBatch HostDispatcher::drain(HostApi& host) {
  DrainBatch batch;
  if (std::this_thread::get_id() != owner_thread_) {
    batch.wrong_thread = true;
    batch.remaining = queued();
    return batch;
  }

  const TimePoint started = clock_.now();
  const TimePoint idle_deadline = started + config_.idle_budget;
  while (batch.completions.size() < config_.max_tasks_per_idle) {
    if (!batch.completions.empty() && clock_.now() - started >= config_.idle_budget) {
      batch.budget_exhausted = true;
      break;
    }

    Request request;
    {
      std::lock_guard lock(mutex_);
      if (state_ != State::kRunning || queue_.empty()) break;
      request = std::move(queue_.front());
      queue_.pop_front();
    }

    Completion completion;
    if (request.deadline <= clock_.now()) {
      completion = expired(request, false);
    } else {
      try {
        if (request.capability_id == kProjectGraphInvalidateControl) {
          HostProjectGraphInvalidationResult host_result =
              host.invalidate_project_graph(std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty()
                    ? "native graph invalidation failed" : host_result.message);
          } else if (host_result.value.invalidated
              ? host_result.value.generation < 1
              : host_result.value.generation != 0) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native graph invalidation result was inconsistent");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.project_graph_invalidation_result = host_result.value;
          }
        } else if (request.capability_id == kProjectSummaryCapability) {
          HostReadResult host_result = host.read_project_summary(
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message);
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectBitDepthReadCapability) {
          HostBitDepthReadResult host_result = host.read_project_bit_depth(
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message);
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.bit_depth_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectItemsListCapability) {
          HostProjectItemsResult host_result = host.list_project_items(
              ProjectItemsQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  request.project_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.project_locator.host_instance_id
                != request.host_instance_id
              || host_result.value.project_locator.session_id != request.session_id
              || (request.project_locator.has_value()
                && host_result.value.project_locator != *request.project_locator)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native project item page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.project_items_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectContextReadCapability) {
          HostProjectContextResult host_result = host.read_project_context(
              ProjectContextQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const ProjectContext& value = host_result.value;
            bool verified = valid_locator(value.project_locator)
                && value.project_locator.kind == "project"
                && value.project_locator.host_instance_id == request.host_instance_id
                && value.project_locator.session_id == request.session_id
                && value.selection_offset == request.offset
                && value.selection_limit == request.limit
                && value.selected_items.size() <= request.limit
                && value.selection_total >= value.selected_items.size()
                && value.selection_has_more
                    == (value.selection_offset + value.selected_items.size()
                        < value.selection_total)
                && (value.selection_has_more
                    ? value.selection_next_offset
                        == std::optional<std::uint64_t>(
                            value.selection_offset + value.selected_items.size())
                    : !value.selection_next_offset.has_value());
            const auto valid_context_item = [&](const ProjectItemEntry& item) {
              return valid_project_item_entry(item)
                  && same_locator_context(value.project_locator, item.locator);
            };
            verified = verified && std::all_of(
                value.selected_items.begin(), value.selected_items.end(), valid_context_item)
                && (!value.active_item.has_value()
                    || valid_context_item(*value.active_item))
                && (!value.most_recently_used_composition.has_value()
                    || (value.most_recently_used_composition->type == "composition"
                      && value.most_recently_used_composition->locator.kind == "composition"
                      && valid_context_item(*value.most_recently_used_composition)));
            if (!verified) {
              completion = failure_for(
                  request, "CAPABILITY_FAILED",
                  "native project context result was not bound to its request");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.ok = true;
              completion.project_context_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kProjectItemMetadataReadCapability) {
          HostProjectItemMetadataResult host_result = host.read_project_item_metadata(
              ProjectItemQuery{
                  request.host_instance_id,
                  request.session_id,
                  *request.item_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const ProjectItemMetadata& value = host_result.value;
            const bool dimensions_valid = (!value.width.has_value()
                    || (*value.width >= 1 && *value.width <= 30000))
                && (!value.height.has_value()
                    || (*value.height >= 1 && *value.height <= 30000));
            const bool composition_facts_valid = value.type != "composition"
                || (value.width.has_value() && value.height.has_value()
                    && value.duration.has_value() && value.duration->value > 0
                    && value.pixel_aspect_ratio.has_value()
                    && value.layer_count.has_value());
            const bool verified = value.item_locator == *request.item_locator
                && valid_bounded_text(value.name, 4096, true)
                && valid_bounded_text(value.comment, 4096, true)
                && value.label_id <= 16
                && dimensions_valid && composition_facts_valid
                && (value.type == "folder" || value.type == "composition"
                    || value.type == "footage" || value.type == "unknown")
                && (!value.parent_locator.has_value()
                    || (valid_locator(*value.parent_locator)
                      && same_locator_context(value.item_locator, *value.parent_locator)))
                && (!value.duration.has_value()
                    || valid_composition_time(*value.duration))
                && (!value.pixel_aspect_ratio.has_value()
                    || valid_positive_ratio(*value.pixel_aspect_ratio));
            if (!verified) {
              completion = failure_for(
                  request, "CAPABILITY_FAILED",
                  "native project item metadata result was not bound to its request");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.ok = true;
              completion.project_item_metadata_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kCompositionSettingsReadCapability) {
          HostCompositionSettingsResult host_result = host.read_composition_settings(
              CompositionSettingsQuery{
                  request.host_instance_id,
                  request.session_id,
                  *request.composition_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.composition_locator
                != *request.composition_locator
              || !valid_composition_settings(host_result.value)) {
            completion = failure_for(
                request, "CAPABILITY_FAILED",
                "native composition settings result was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_settings_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionWorkAreaSetCapability) {
          HostCompositionWorkAreaWriteResult host_result =
              host.set_composition_work_area(
                  CompositionWorkAreaSetCommand{
                      request.host_instance_id,
                      request.session_id,
                      *request.composition_locator,
                      request.work_area_start,
                      request.work_area_duration},
                  request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect composition work area");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const CompositionWorkAreaChanged& value = host_result.value;
            const bool verified = value.changed
                && value.composition_locator == *request.composition_locator
                && valid_composition_time(value.before_start)
                && valid_composition_time(value.before_duration)
                && valid_composition_time(value.after_start)
                && valid_composition_time(value.after_duration)
                && ( !composition_times_equal(value.before_start, value.after_start)
                    || !composition_times_equal(
                        value.before_duration, value.after_duration))
                && composition_times_equal(value.after_start, request.work_area_start)
                && composition_times_equal(
                    value.after_duration, request.work_area_duration);
            if (!verified) {
              completion = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write did not verify the requested work area");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.composition_work_area_change_result =
                  std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kProjectItemNameSetCapability
            || request.capability_id == kProjectItemCommentSetCapability) {
          HostProjectItemTextWriteResult host_result =
              request.capability_id == kProjectItemNameSetCapability
              ? host.set_project_item_name(
                  ProjectItemTextSetCommand{
                      request.host_instance_id, request.session_id,
                      *request.item_locator, request.item_text},
                  request.deadline)
              : host.set_project_item_comment(
                  ProjectItemTextSetCommand{
                      request.host_instance_id, request.session_id,
                      *request.item_locator, request.item_text},
                  request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect project item metadata");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.item_locator != *request.item_locator
              || host_result.value.before_value == host_result.value.after_value
              || host_result.value.after_value != request.item_text) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested project item text");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.project_item_text_change_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kProjectItemLabelSetCapability) {
          HostProjectItemLabelWriteResult host_result = host.set_project_item_label(
              ProjectItemLabelSetCommand{
                  request.host_instance_id, request.session_id,
                  *request.item_locator, request.item_label_id},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect project item label");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.item_locator != *request.item_locator
              || host_result.value.before_label_id == host_result.value.after_label_id
              || host_result.value.after_label_id != request.item_label_id
              || host_result.value.before_label_id > 16) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested project item label");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.project_item_label_change_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionDuplicateCapability) {
          HostCompositionDuplicateResult host_result = host.duplicate_composition(
              CompositionDuplicateCommand{
                  request.host_instance_id, request.session_id,
                  *request.composition_locator, request.duplicate_new_name},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native duplicate completed after its deadline; inspect project items");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            CompositionDuplicated& value = host_result.value;
            CompositionSettings comparable_new = value.new_settings;
            comparable_new.name = value.source_settings.name;
            const bool verified = value.changed
                && value.project_item_count_after == value.project_item_count_before + 1
                && valid_composition_settings(value.source_settings)
                && valid_composition_settings(value.new_settings)
                && value.new_settings.name == request.duplicate_new_name
                && composition_settings_equivalent(
                    value.source_settings, comparable_new)
                && value.source_composition_locator.kind == "composition"
                && value.new_composition_locator.kind == "composition"
                && value.source_composition_locator.object_id
                    != value.new_composition_locator.object_id
                && same_locator_context(
                    value.source_composition_locator,
                    value.new_composition_locator)
                && value.source_composition_locator.host_instance_id
                    == request.host_instance_id
                && value.source_composition_locator.session_id == request.session_id
                && value.source_composition_locator.generation
                    > request.composition_locator->generation
                && value.source_composition_locator.project_id
                    != request.composition_locator->project_id
                && value.source_settings.composition_locator
                    == value.source_composition_locator
                && value.new_settings.composition_locator
                    == value.new_composition_locator;
            if (!verified) {
              completion = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native duplicate did not verify source and new composition state");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.composition_duplicate_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kCompositionLayersListCapability) {
          HostCompositionLayersResult host_result = host.list_composition_layers(
              CompositionLayersQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  *request.composition_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.composition_locator != *request.composition_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native composition layer page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_layers_result = std::move(host_result.value);
          }
        } else if (request.capability_id
            == kCompositionSelectedLayersListCapability) {
          HostCompositionLayersResult host_result =
              host.list_selected_composition_layers(
                  CompositionLayersQuery{
                      request.host_instance_id,
                      request.session_id,
                      request.offset,
                      request.limit,
                      *request.composition_locator},
                  std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.composition_locator != *request.composition_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native selected composition layer page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_selected_layers_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionTimeReadCapability) {
          HostCompositionTimeResult host_result = host.read_composition_time(
              CompositionTimeQuery{
                  request.host_instance_id,
                  request.session_id,
                  *request.composition_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.composition_locator
              != *request.composition_locator
              || host_result.value.current_time.scale == 0
              || host_result.value.current_time.seconds_rational
                  != canonical_seconds_rational(
                      host_result.value.current_time.value,
                      host_result.value.current_time.scale)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native composition time result was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.composition_time_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionTimeSetCapability) {
          HostCompositionTimeWriteResult host_result = host.set_composition_time(
              CompositionTimeSetCommand{
                  request.host_instance_id,
                  request.session_id,
                  *request.composition_locator,
                  request.target_time},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect composition time");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.composition_locator
                  != *request.composition_locator
              || !valid_composition_time(host_result.value.before_time)
              || !valid_composition_time(host_result.value.after_time)
              || composition_times_equal(
                  host_result.value.before_time, host_result.value.after_time)
              || !composition_times_equal(
                  host_result.value.after_time, request.target_time)) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write result did not verify the requested composition time");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.composition_time_change_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kCompositionCreateCapability) {
          HostCompositionCreateResult host_result = host.create_composition(
              CompositionCreateCommand{
                  request.host_instance_id,
                  request.session_id,
                  request.composition_create_name,
                  request.composition_create_width,
                  request.composition_create_height,
                  request.composition_create_duration,
                  request.composition_create_frame_rate,
                  request.composition_create_pixel_aspect_ratio},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect project items");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const CompositionCreated& value = host_result.value;
            const auto ratios_equal = [](const CompositionPositiveRatio& left,
                                         const CompositionPositiveRatio& right) {
              return static_cast<std::int64_t>(left.numerator) * right.denominator
                  == static_cast<std::int64_t>(right.numerator) * left.denominator;
            };
            const bool verified = value.changed
                && value.name == request.composition_create_name
                && value.project_item_count_after == value.project_item_count_before + 1
                && value.layer_count == 0
                && value.width == request.composition_create_width
                && value.height == request.composition_create_height
                && valid_composition_time(value.duration)
                && composition_times_equal(
                    value.duration, request.composition_create_duration)
                && valid_positive_ratio(value.frame_rate)
                && ratios_equal(value.frame_rate, request.composition_create_frame_rate)
                && valid_positive_ratio(value.pixel_aspect_ratio)
                && ratios_equal(
                    value.pixel_aspect_ratio,
                    request.composition_create_pixel_aspect_ratio)
                && valid_locator(value.composition_locator)
                && value.composition_locator.kind == "composition"
                && value.composition_locator.host_instance_id
                    == request.host_instance_id
                && value.composition_locator.session_id == request.session_id;
            if (!verified) {
              completion = failure_for(
                  request,
                  "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write result did not verify the requested composition");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.composition_create_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kCompositionLayerCreateCapability) {
          HostCompositionLayerCreateResult host_result = host.create_composition_layer(
              CompositionLayerCreateCommand{
                  request.host_instance_id,
                  request.session_id,
                  *request.composition_locator,
                  request.layer_create_kind,
                  request.layer_create_name,
                  request.layer_create_color,
                  request.layer_create_width,
                  request.layer_create_height,
                  request.layer_create_duration},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect composition layers");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const CompositionLayerCreated& value = host_result.value;
            bool verified = value.changed
                && value.kind == request.layer_create_kind
                && value.name == request.layer_create_name
                && value.layer_count_after == value.layer_count_before + 1
                && value.stack_index >= 1
                && value.stack_index <= value.layer_count_after
                && value.project_item_count_after >= value.project_item_count_before
                && value.composition_locator.kind == "composition"
                && value.layer_locator.kind == "layer"
                && same_locator_context(
                    value.composition_locator, value.layer_locator)
                && value.composition_locator.host_instance_id
                    == request.host_instance_id
                && value.composition_locator.session_id == request.session_id
                && value.composition_locator.generation
                    > request.composition_locator->generation
                && value.composition_locator.project_id
                    != request.composition_locator->project_id;
            if (value.source_item_locator.has_value()) {
              verified = verified
                  && (value.source_item_locator->kind == "item"
                      || value.source_item_locator->kind == "composition")
                  && same_locator_context(
                      value.composition_locator, *value.source_item_locator);
            }
            if (request.layer_create_kind == "solid") {
              verified = verified && value.solid.has_value()
                  && value.source_item_locator.has_value()
                  && value.project_item_count_after
                      > value.project_item_count_before;
              if (verified && request.layer_create_color.has_value()) {
                verified = value.solid->color == *request.layer_create_color;
              }
              if (verified && request.layer_create_width.has_value()) {
                verified = value.solid->width == *request.layer_create_width;
              }
              if (verified && request.layer_create_height.has_value()) {
                verified = value.solid->height == *request.layer_create_height;
              }
              if (verified && request.layer_create_duration.has_value()) {
                verified = composition_times_equal(
                    value.solid->duration, *request.layer_create_duration);
              }
            } else {
              verified = verified && !value.solid.has_value();
            }
            if (!verified) {
              completion = failure_for(
                  request,
                  "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write result did not verify the requested composition layer");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.composition_layer_create_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kLayerEffectApplyCapability) {
          HostLayerEffectApplyResult host_result = host.apply_layer_effect(
              LayerEffectApplyCommand{
                  request.host_instance_id,
                  request.session_id,
                  *request.layer_locator,
                  request.layer_effect_match_name},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect layer effects");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const LayerEffectApplied& value = host_result.value;
            const bool verified = value.changed
                && value.match_name == request.layer_effect_match_name
                && !value.name.empty()
                && value.effect_count_after == value.effect_count_before + 1
                && value.matching_effect_count_after
                    == value.matching_effect_count_before + 1
                && value.effect_index >= 1
                && value.effect_index <= value.effect_count_after
                && value.layer_locator.kind == "layer"
                && value.layer_locator.host_instance_id == request.host_instance_id
                && value.layer_locator.session_id == request.session_id
                && value.layer_locator.object_id == request.layer_locator->object_id
                && value.layer_locator.generation > request.layer_locator->generation
                && value.layer_locator.project_id != request.layer_locator->project_id;
            if (!verified) {
              completion = failure_for(
                  request,
                  "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write result did not verify the requested layer effect");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.layer_effect_apply_result = std::move(host_result.value);
            }
          }
        } else if (request.capability_id == kNativeMediaReadCapability
            || request.capability_id == kNativeMediaWriteCapability) {
          const bool media_write =
              request.capability_id == kNativeMediaWriteCapability;
          HostNativeMediaResult host_result = host.execute_native_media(
              request.native_media,
              media_write ? request.deadline
                          : std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = media_write
                ? failure_for(
                    request,
                    "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "native media write completed after its deadline; inspect AE state")
                : expired(request, true);
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty()
                    ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty()
                    ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.canonical_value_json.size() < 2
              || host_result.canonical_value_json.size() > 65'536
              || host_result.canonical_value_json.front() != '{'
              || host_result.canonical_value_json.back() != '}'
              || host_result.canonical_value_json.find('\0') != std::string::npos) {
            completion = failure_for(
                request,
                media_write
                    ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : "CAPABILITY_FAILED",
                "native media result failed its bounded object contract");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.native_media_result_json =
                std::move(host_result.canonical_value_json);
          }
        } else if (request.capability_id == kLayerDetailsReadCapability
            || request.capability_id == kLayerNameSetCapability
            || request.capability_id == kLayerRangeSetCapability
            || request.capability_id == kLayerStartTimeSetCapability
            || request.capability_id == kLayerStretchSetCapability
            || request.capability_id == kLayerOrderSetCapability
            || request.capability_id == kLayerParentSetCapability
            || request.capability_id == kLayerDuplicateCapability) {
          completion = [&]() -> Completion {
            Completion completion;
            if (request.capability_id == kLayerDetailsReadCapability) {
              HostLayerDetailsResult host_result = host.read_layer_details(
              LayerDetailsQuery{
                  request.host_instance_id,
                  request.session_id,
                  *request.layer_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.layer_locator != *request.layer_locator
              || !valid_layer_details(host_result.value)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native layer details were not bound to the requested layer");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                std::move(host_result.value));
            }
          } else if (request.capability_id == kLayerNameSetCapability) {
          HostLayerNameWriteResult host_result = host.set_layer_name(
              LayerNameSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_new_name},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer name");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.before_name == host_result.value.after_name
              || host_result.value.after_name != request.layer_new_name) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested layer name");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                std::move(host_result.value));
          }
        } else if (request.capability_id == kLayerRangeSetCapability) {
          HostLayerRangeWriteResult host_result = host.set_layer_range(
              LayerRangeSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_in_point,
                  request.layer_duration},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer range");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const LayerRangeChanged& value = host_result.value;
            const bool verified = value.changed
                && value.layer_locator == *request.layer_locator
                && valid_composition_time(value.before_in_point)
                && valid_composition_time(value.before_duration)
                && valid_composition_time(value.after_in_point)
                && valid_composition_time(value.after_duration)
                && (!composition_times_equal(value.before_in_point, value.after_in_point)
                  || !composition_times_equal(value.before_duration, value.after_duration))
                && composition_times_equal(value.after_in_point, request.layer_in_point)
                && composition_times_equal(value.after_duration, request.layer_duration);
            if (!verified) {
              completion = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write did not verify the requested layer range");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                  std::move(host_result.value));
            }
          }
        } else if (request.capability_id == kLayerStartTimeSetCapability) {
          HostLayerStartTimeWriteResult host_result = host.set_layer_start_time(
              LayerStartTimeSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_start_time},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer start time");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || !valid_composition_time(host_result.value.before_start_time)
              || !valid_composition_time(host_result.value.after_start_time)
              || composition_times_equal(
                  host_result.value.before_start_time,
                  host_result.value.after_start_time)
              || !composition_times_equal(
                  host_result.value.after_start_time, request.layer_start_time)) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested layer start time");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                std::move(host_result.value));
          }
        } else if (request.capability_id == kLayerStretchSetCapability) {
          HostLayerStretchWriteResult host_result = host.set_layer_stretch(
              LayerStretchSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_stretch},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer stretch");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || !valid_layer_stretch(host_result.value.before_stretch)
              || !valid_layer_stretch(host_result.value.after_stretch)
              || host_result.value.before_stretch == host_result.value.after_stretch
              || host_result.value.after_stretch != request.layer_stretch) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested layer stretch");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                std::move(host_result.value));
          }
        } else if (request.capability_id == kLayerOrderSetCapability) {
          HostLayerOrderWriteResult host_result = host.set_layer_order(
              LayerOrderSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.target_stack_index},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer order");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.before_stack_index < 1
              || host_result.value.before_stack_index
                  == host_result.value.after_stack_index
              || host_result.value.after_stack_index != request.target_stack_index) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write did not verify the requested layer order");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                std::move(host_result.value));
          }
        } else if (request.capability_id == kLayerParentSetCapability) {
          HostLayerParentWriteResult host_result = host.set_layer_parent(
              LayerParentSetCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_parent_locator},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect layer parent");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const LayerParentChanged& value = host_result.value;
            const auto valid_optional_parent = [&](const std::optional<ObjectLocator>& parent) {
              return !parent.has_value()
                  || (valid_locator(*parent) && parent->kind == "layer"
                    && same_locator_context(value.layer_locator, *parent));
            };
            const bool verified = value.changed
                && value.layer_locator == *request.layer_locator
                && valid_optional_parent(value.before_parent_locator)
                && valid_optional_parent(value.after_parent_locator)
                && value.before_parent_locator != value.after_parent_locator
                && value.after_parent_locator == request.layer_parent_locator;
            if (!verified) {
              completion = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write did not verify the requested layer parent");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                  std::move(host_result.value));
            }
          }
        } else if (request.capability_id == kLayerDuplicateCapability) {
          HostLayerDuplicateResult host_result = host.duplicate_layer(
              LayerDuplicateCommand{
                  {request.host_instance_id, request.session_id, *request.layer_locator},
                  request.layer_new_name},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its deadline; inspect composition layers");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else {
            const LayerDuplicated& value = host_result.value;
            const bool verified = value.changed
                && value.layer_count_after == value.layer_count_before + 1
                && value.source_layer.has_value()
                && valid_layer_details(*value.source_layer)
                && valid_layer_details(value.new_layer)
                && value.source_layer_locator.kind == "layer"
                && value.new_layer_locator.kind == "layer"
                && value.composition_locator.kind == "composition"
                && value.source_layer_locator.host_instance_id
                    == request.host_instance_id
                && value.source_layer_locator.session_id == request.session_id
                && value.source_layer_locator.object_id
                    == request.layer_locator->object_id
                && value.source_layer_locator.generation
                    > request.layer_locator->generation
                && value.source_layer_locator.project_id
                    != request.layer_locator->project_id
                && value.new_layer_locator.object_id
                    != value.source_layer_locator.object_id
                && same_locator_context(
                    value.source_layer_locator, value.new_layer_locator)
                && same_locator_context(
                    value.composition_locator, value.new_layer_locator)
                && value.new_layer.layer_locator == value.new_layer_locator
                && value.new_layer.composition_locator == value.composition_locator
                && value.new_layer.name == request.layer_new_name
                && value.source_layer->layer_locator
                    == value.source_layer_locator
                && value.source_layer->composition_locator
                    == value.composition_locator
                && duplicated_layer_stable_semantics_match(
                    *value.source_layer, value.new_layer);
            if (!verified) {
              completion = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write did not verify the duplicated layer");
            } else {
              completion.request_id = request.request_id;
              completion.capability_id = request.capability_id;
              completion.route_id = request.route_id;
              completion.session_generation = request.session_generation;
              completion.idempotency_key = request.idempotency_key;
              completion.ok = true;
              completion.layer_timeline_result = std::make_shared<LayerTimelineResult>(
                  std::move(host_result.value));
            }
          }
            }
            return completion;
          }();
        } else if (request.capability_id == kLayerCompositingReadCapability
            || request.capability_id == kLayerSwitchSetCapability
            || request.capability_id == kLayerQualitySetCapability
            || request.capability_id == kLayerBlendingModeSetCapability) {
          completion = [&]() -> Completion {
            Completion result;
            const auto complete = [&](auto value, bool write) {
              result.request_id = request.request_id;
              result.capability_id = request.capability_id;
              result.route_id = request.route_id;
              result.session_generation = request.session_generation;
              if (write) result.idempotency_key = request.idempotency_key;
              result.ok = true;
              result.layer_compositing_result =
                  std::make_shared<LayerCompositingResult>(std::move(value));
            };
            const auto fail_host = [&](const auto& host_result) {
              result = failure_for(
                  request,
                  host_result.error_code.empty()
                      ? "CAPABILITY_FAILED" : host_result.error_code,
                  host_result.message.empty()
                      ? "native capability failed" : host_result.message,
                  host_result.error_field);
            };
            if (request.capability_id == kLayerCompositingReadCapability) {
              auto host_result = host.read_layer_compositing(
                  LayerDetailsQuery{
                      request.host_instance_id, request.session_id,
                      *request.layer_locator},
                  std::min(request.deadline, idle_deadline));
              if (clock_.now() > request.deadline) {
                result = expired(request, true);
              } else if (!host_result.ok) {
                fail_host(host_result);
              } else if (host_result.value.layer_locator != *request.layer_locator
                  || !valid_layer_compositing_state(host_result.value)) {
                result = failure_for(
                    request, "CAPABILITY_FAILED",
                    "native compositing state was not bound to the requested layer");
              } else {
                complete(std::move(host_result.value), false);
              }
              return result;
            }
            if (request.capability_id == kLayerSwitchSetCapability) {
              auto host_result = host.set_layer_switch(
                  LayerSwitchSetCommand{
                      {request.host_instance_id, request.session_id,
                       *request.layer_locator},
                      request.layer_switch_name,
                      *request.layer_switch_enabled},
                  request.deadline);
              if (clock_.now() > request.deadline) {
                result = failure_for(
                    request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "native write completed after its deadline; inspect layer switches");
                result.late_result_discarded = true;
              } else if (!host_result.ok) {
                fail_host(host_result);
              } else {
                const auto& value = host_result.value;
                if (!value.changed || value.layer_locator != *request.layer_locator
                    || value.switch_name != request.layer_switch_name
                    || value.before_enabled == value.after_enabled
                    || value.after_enabled != *request.layer_switch_enabled) {
                  result = failure_for(
                      request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                      "native write did not verify the requested layer switch");
                } else {
                  complete(std::move(host_result.value), true);
                }
              }
              return result;
            }
            if (request.capability_id == kLayerQualitySetCapability) {
              auto host_result = host.set_layer_quality(
                  LayerQualitySetCommand{
                      {request.host_instance_id, request.session_id,
                       *request.layer_locator},
                      request.layer_quality},
                  request.deadline);
              if (clock_.now() > request.deadline) {
                result = failure_for(
                    request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "native write completed after its deadline; inspect layer quality");
                result.late_result_discarded = true;
              } else if (!host_result.ok) {
                fail_host(host_result);
              } else {
                const auto& value = host_result.value;
                if (!value.changed || value.layer_locator != *request.layer_locator
                    || value.before_quality == value.after_quality
                    || value.after_quality != request.layer_quality) {
                  result = failure_for(
                      request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                      "native write did not verify the requested layer quality");
                } else {
                  complete(std::move(host_result.value), true);
                }
              }
              return result;
            }
            auto host_result = host.set_layer_blending_mode(
                LayerBlendingModeSetCommand{
                    {request.host_instance_id, request.session_id,
                     *request.layer_locator},
                    request.layer_blending_mode},
                request.deadline);
            if (clock_.now() > request.deadline) {
              result = failure_for(
                  request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                  "native write completed after its deadline; inspect layer blending mode");
              result.late_result_discarded = true;
            } else if (!host_result.ok) {
              fail_host(host_result);
            } else {
              const auto& value = host_result.value;
              if (!value.changed || value.layer_locator != *request.layer_locator
                  || value.before_mode == value.after_mode
                  || value.after_mode != request.layer_blending_mode
                  || (value.track_matte != "none" && value.track_matte != "alpha"
                    && value.track_matte != "inverted-alpha"
                    && value.track_matte != "luma"
                    && value.track_matte != "inverted-luma")) {
                result = failure_for(
                    request, "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "native write did not verify the requested layer blending mode");
              } else {
                complete(std::move(host_result.value), true);
              }
            }
            return result;
          }();
        } else if (request.capability_id == kLayerPropertiesListCapability) {
          HostLayerPropertiesResult host_result = host.list_layer_properties(
              LayerPropertiesQuery{
                  request.host_instance_id,
                  request.session_id,
                  request.offset,
                  request.limit,
                  *request.layer_locator,
                  request.parent_property_locator},
              std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.parent_property_locator
                != request.parent_property_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native layer property page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.layer_properties_result = std::move(host_result.value);
          }
        } else if (request.capability_id == kLayerPropertyKeyframesListCapability) {
          HostLayerPropertyKeyframesResult host_result =
              host.list_layer_property_keyframes(
                  LayerPropertyKeyframesQuery{
                      request.host_instance_id,
                      request.session_id,
                      request.offset,
                      request.limit,
                      *request.property_locator},
                  std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.offset != request.offset
              || host_result.value.limit != request.limit
              || host_result.value.property_locator != *request.property_locator) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native layer property keyframe page was not bound to its request");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.layer_property_keyframes_result = std::move(host_result.value);
          }
        } else if (request.capability_id
            == kLayerPropertyKeyframeDetailsReadCapability) {
          HostLayerPropertyKeyframeDetailsResult host_result =
              host.read_layer_property_keyframe_details(
                  LayerPropertyKeyframeDetailsQuery{
                      request.host_instance_id,
                      request.session_id,
                      *request.property_locator,
                      request.keyframe_time},
                  std::min(request.deadline, idle_deadline));
          if (clock_.now() > request.deadline) {
            completion = expired(request, true);
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (host_result.value.property_locator != *request.property_locator
              || !keyframe_times_equal(host_result.value.time, request.keyframe_time)) {
            completion = failure_for(
                request,
                "CAPABILITY_FAILED",
                "native keyframe details were not bound to the requested target");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.ok = true;
            completion.layer_property_keyframe_details_result =
                std::move(host_result.value);
          }
        } else if (keyframe_write_capability(request.capability_id)) {
          LayerPropertyKeyframeMutationKind kind =
              LayerPropertyKeyframeMutationKind::kAdd;
          if (request.capability_id == kLayerPropertyKeyframeValueSetCapability) {
            kind = LayerPropertyKeyframeMutationKind::kSetValue;
          } else if (request.capability_id
              == kLayerPropertyKeyframeInterpolationSetCapability) {
            kind = LayerPropertyKeyframeMutationKind::kSetInterpolation;
          } else if (request.capability_id
              == kLayerPropertyKeyframeTemporalEaseSetCapability) {
            kind = LayerPropertyKeyframeMutationKind::kSetTemporalEase;
          } else if (request.capability_id
              == kLayerPropertyKeyframeBehaviorSetCapability) {
            kind = LayerPropertyKeyframeMutationKind::kSetBehavior;
          } else if (request.capability_id == kLayerPropertyKeyframeDeleteCapability) {
            kind = LayerPropertyKeyframeMutationKind::kDelete;
          }
          HostLayerPropertyKeyframeWriteResult host_result =
              host.mutate_layer_property_keyframe(
                  LayerPropertyKeyframeMutationCommand{
                      request.host_instance_id,
                      request.session_id,
                      *request.layer_locator,
                      *request.property_locator,
                      request.keyframe_time,
                      kind,
                      request.property_value,
                      request.keyframe_in_interpolation,
                      request.keyframe_out_interpolation,
                      request.keyframe_temporal_ease,
                      request.keyframe_behavior,
                      request.keyframe_behavior_enabled.value_or(false)},
                  request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native keyframe write completed after its deadline; inspect keyframe state");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.property_locator != *request.property_locator
              || !keyframe_times_equal(host_result.value.time, request.keyframe_time)
              || (!host_result.value.before.has_value()
                  && !host_result.value.after.has_value())) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native keyframe write result was not bound to the requested target");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_property_keyframe_change_result =
                std::move(host_result.value);
          }
        } else if (request.capability_id == kLayerPropertySetCapability) {
          HostLayerPropertyWriteResult host_result = host.set_layer_property(
              LayerPropertySetCommand{
                  request.host_instance_id,
                  request.session_id,
                  *request.layer_locator,
                  *request.property_locator,
                  request.property_value},
              request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect property state");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || host_result.value.layer_locator != *request.layer_locator
              || host_result.value.property_locator != *request.property_locator
              || property_values_semantically_equal(
                  host_result.value.before_value, host_result.value.after_value)
              || !property_values_semantically_equal(
                  host_result.value.after_value, request.property_value)
              || !property_value_matches_type(
                  host_result.value.before_value, host_result.value.value_type)
              || !property_value_matches_type(
                  host_result.value.after_value, host_result.value.value_type)) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write result did not verify the requested layer property value");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.layer_property_change_result = std::move(host_result.value);
          }
        } else {
          // The idle budget decides whether another task may start in this
          // batch. An AEGP write is synchronous and cannot be interrupted, so
          // its semantic deadline remains the caller's request deadline.
          HostBitDepthWriteResult host_result = host.set_project_bit_depth(
              request.target_depth, request.deadline);
          if (clock_.now() > request.deadline) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write completed after its request deadline; inspect project state");
            completion.late_result_discarded = true;
          } else if (!host_result.ok) {
            completion = failure_for(
                request,
                host_result.error_code.empty() ? "CAPABILITY_FAILED" : host_result.error_code,
                host_result.message.empty() ? "native capability failed" : host_result.message,
                host_result.error_field);
          } else if (!host_result.value.changed
              || !valid_bit_depth(host_result.value.before_bits_per_channel)
              || !valid_bit_depth(host_result.value.after_bits_per_channel)
              || host_result.value.before_bits_per_channel
                == host_result.value.after_bits_per_channel
              || host_result.value.after_bits_per_channel != request.target_depth) {
            completion = failure_for(
                request,
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "native write result did not verify the requested project bit depth");
          } else {
            completion.request_id = request.request_id;
            completion.capability_id = request.capability_id;
            completion.route_id = request.route_id;
            completion.session_generation = request.session_generation;
            completion.idempotency_key = request.idempotency_key;
            completion.ok = true;
            completion.bit_depth_change_result = std::move(host_result.value);
          }
        }
      } catch (...) {
        completion = failure_for(
            request,
            (request.capability_id == kProjectBitDepthSetCapability
                || request.capability_id == kCompositionTimeSetCapability
                || request.capability_id == kCompositionCreateCapability
                || request.capability_id == kCompositionLayerCreateCapability
                || request.capability_id == kLayerEffectApplyCapability
                || request.capability_id == kLayerPropertySetCapability
                || keyframe_write_capability(request.capability_id)
                || request.capability_id == kCompositionWorkAreaSetCapability
                || request.capability_id == kProjectItemNameSetCapability
                || request.capability_id == kProjectItemCommentSetCapability
                || request.capability_id == kProjectItemLabelSetCapability
                || request.capability_id == kCompositionDuplicateCapability
                || request.capability_id == kLayerNameSetCapability
                || request.capability_id == kLayerRangeSetCapability
                || request.capability_id == kLayerStartTimeSetCapability
                || request.capability_id == kLayerStretchSetCapability
                || request.capability_id == kLayerOrderSetCapability
                || request.capability_id == kLayerParentSetCapability
                || request.capability_id == kLayerDuplicateCapability
                || request.capability_id == kNativeMediaWriteCapability)
                ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : "CAPABILITY_FAILED",
            "native host adapter raised an exception");
      }
    }
    {
      std::lock_guard lock(mutex_);
      if (request.capability_id == kProjectGraphInvalidateControl
          && completion.ok) {
        invalidate_composition_creation_replays_locked();
      }
      finish_idempotency_locked(request, completion);
      finish_request_locked(key_for(request), completion, clock_.now());
    }
    batch.completions.push_back(std::move(completion));
  }

  batch.remaining = queued();
  if (batch.remaining > 0 && batch.completions.size() >= config_.max_tasks_per_idle) {
    batch.budget_exhausted = true;
  }
  return batch;
}

std::vector<Completion> HostDispatcher::take_outbound(std::size_t max_items) {
  std::vector<Completion> completions;
  if (max_items == 0) return completions;
  std::lock_guard lock(mutex_);
  const std::size_t count = std::min(max_items, outbound_.size());
  completions.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    completions.push_back(std::move(outbound_.front()));
    outbound_.pop_front();
  }
  return completions;
}

std::vector<Completion> HostDispatcher::shutdown() {
  if (std::this_thread::get_id() != owner_thread_) {
    throw std::logic_error("native host dispatcher shutdown must run on its owner thread");
  }
  std::vector<Completion> completions;
  const TimePoint now = clock_.now();
  std::lock_guard lock(mutex_);
  if (state_ == State::kStopped) return completions;
  state_ = State::kStopping;
  completions.reserve(queue_.size());
  while (!queue_.empty()) {
    Request request = std::move(queue_.front());
    queue_.pop_front();
    Completion completion = failure_for(
        request, "AE_SHUTTING_DOWN", "After Effects is shutting down");
    finish_idempotency_locked(request, completion);
    finish_request_locked(key_for(request), completion, now);
    completions.push_back(std::move(completion));
  }
  state_ = State::kStopped;
  return completions;
}

std::size_t HostDispatcher::queued() const {
  std::lock_guard lock(mutex_);
  return queue_.size();
}

std::size_t HostDispatcher::outbound() const {
  std::lock_guard lock(mutex_);
  return outbound_.size();
}

std::size_t HostDispatcher::terminal_count() {
  std::lock_guard lock(mutex_);
  purge_terminal_locked(clock_.now());
  return terminal_tombstones_.size();
}

bool HostDispatcher::has_terminal(
    std::string_view route_id,
    std::uint64_t session_generation,
    std::string_view request_id) {
  if (!valid_route(route_id, session_generation) || !valid_request_id(request_id)) return false;
  std::lock_guard lock(mutex_);
  purge_terminal_locked(clock_.now());
  return terminal_locked(
      {std::string(route_id), session_generation, std::string(request_id)});
}

void HostDispatcher::mark_idempotency_ambiguous(std::string_view idempotency_key) {
  if (!valid_idempotency_key(idempotency_key)) return;
  std::lock_guard lock(mutex_);
  const auto entry = idempotency_ledger_.find(std::string(idempotency_key));
  if (entry != idempotency_ledger_.end()) {
    entry->second.state = IdempotencyState::kAmbiguous;
  }
}

void HostDispatcher::invalidate_composition_creation_replays() {
  std::lock_guard lock(mutex_);
  invalidate_composition_creation_replays_locked();
}

bool HostDispatcher::running() const {
  std::lock_guard lock(mutex_);
  return state_ == State::kRunning;
}

Completion HostDispatcher::expired(const Request& request, bool late) const {
  Completion completion = failure_for(
      request, "DEADLINE_EXCEEDED", "native request deadline elapsed");
  completion.late_result_discarded = late;
  return completion;
}

HostDispatcher::RequestKey HostDispatcher::key_for(const Request& request) {
  return {request.route_id, request.session_generation, request.request_id};
}

bool HostDispatcher::route_revoked_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  const auto fence = route_fences_.find(std::string(route_id));
  return fence != route_fences_.end() && session_generation <= fence->second;
}

bool HostDispatcher::route_stale_locked(
    std::string_view route_id, std::uint64_t session_generation) const {
  if (route_revoked_locked(route_id, session_generation)) return true;
  // Fences are never evicted. Once their bounded registry is exhausted, an
  // unseen authenticated route fails closed until the AE plug-in restarts.
  return !route_id.empty() && route_fences_saturated_
      && route_fences_.find(std::string(route_id)) == route_fences_.end();
}

bool HostDispatcher::pending_outbound_locked(const RequestKey& key) const {
  return std::any_of(outbound_.begin(), outbound_.end(), [&](const Completion& completion) {
    return completion.route_id == key.route_id
        && completion.session_generation == key.session_generation
        && completion.request_id == key.request_id;
  });
}

bool HostDispatcher::terminal_locked(const RequestKey& key) const {
  return std::any_of(
      terminal_tombstones_.begin(), terminal_tombstones_.end(),
      [&](const TerminalTombstone& tombstone) { return tombstone.key == key; });
}

void HostDispatcher::purge_terminal_locked(TimePoint now) {
  std::erase_if(terminal_tombstones_, [&](const TerminalTombstone& tombstone) {
    return tombstone.expires_at <= now;
  });
}

void HostDispatcher::remember_terminal_locked(RequestKey key, TimePoint now) {
  // Active admission excludes an existing tombstone for this key, so append
  // before eviction. Allocation failure then preserves every older fence.
  terminal_tombstones_.push_back({std::move(key), now + config_.terminal_ttl});
  while (terminal_tombstones_.size() > config_.max_terminal_tombstones) {
    terminal_tombstones_.pop_front();
  }
}

void HostDispatcher::invalidate_composition_creation_replays_locked() {
  for (auto& [idempotency_key, entry] : idempotency_ledger_) {
    (void)idempotency_key;
    if (entry.replay_completion.has_value()) {
      entry.state = IdempotencyState::kAmbiguous;
      entry.replay_completion.reset();
    }
  }
}

bool HostDispatcher::fence_route_locked(
    std::string route_id, std::uint64_t session_generation) {
  const auto existing = route_fences_.find(route_id);
  if (existing != route_fences_.end()) {
    existing->second = std::max(existing->second, session_generation);
    return true;
  }
  if (route_fences_.size() >= config_.max_route_fences) {
    route_fences_saturated_ = true;
    return false;
  }
  route_fences_.emplace(std::move(route_id), session_generation);
  return true;
}

void HostDispatcher::finish_request_locked(
    const RequestKey& key, Completion& completion, TimePoint now) {
  if (route_revoked_locked(key.route_id, key.session_generation)
      || detached_requests_.contains(key)) {
    completion.route_revoked = true;
  }
  outbound_.push_back(completion);
  remember_terminal_locked(key, now);
  active_requests_.erase(key);
  detached_requests_.erase(key);
}

void HostDispatcher::finish_idempotency_locked(
    const Request& request, const Completion& completion) {
  if ((request.capability_id != kProjectBitDepthSetCapability
          && request.capability_id != kCompositionTimeSetCapability
          && request.capability_id != kCompositionCreateCapability
          && request.capability_id != kCompositionLayerCreateCapability
          && request.capability_id != kLayerEffectApplyCapability
          && request.capability_id != kLayerPropertySetCapability
          && request.capability_id != kCompositionWorkAreaSetCapability
          && request.capability_id != kProjectItemNameSetCapability
          && request.capability_id != kProjectItemCommentSetCapability
          && request.capability_id != kProjectItemLabelSetCapability
          && request.capability_id != kCompositionDuplicateCapability
          && request.capability_id != kLayerNameSetCapability
          && request.capability_id != kLayerRangeSetCapability
          && request.capability_id != kLayerStartTimeSetCapability
          && request.capability_id != kLayerStretchSetCapability
          && request.capability_id != kLayerOrderSetCapability
          && request.capability_id != kLayerParentSetCapability
          && request.capability_id != kLayerDuplicateCapability
          && request.capability_id != kNativeMediaWriteCapability)
      || request.idempotency_key.empty()) {
    return;
  }
  const auto entry = idempotency_ledger_.find(request.idempotency_key);
  if (entry == idempotency_ledger_.end()) return;
  if (completion.ok) {
    entry->second.state = IdempotencyState::kSucceeded;
    if (request.capability_id == kCompositionCreateCapability
        || request.capability_id == kCompositionLayerCreateCapability
        || request.capability_id == kLayerEffectApplyCapability
        || request.capability_id == kCompositionDuplicateCapability
        || request.capability_id == kLayerDuplicateCapability) {
      entry->second.replay_completion = completion;
    }
    return;
  }
  if (completion.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE") {
    entry->second.state = IdempotencyState::kAmbiguous;
    return;
  }
  // Safe pre-mutation failures and cancellation release the reservation so a
  // caller can retry with the same user-intent key. Successful or ambiguous
  // fences above are deliberately process-lifetime and never evicted.
  idempotency_ledger_.erase(entry);
}

}  // namespace aemcp::native

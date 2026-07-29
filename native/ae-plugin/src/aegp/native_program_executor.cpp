#include "native_program_executor.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <utility>

namespace aemcp::native {
namespace {

using AdapterValue = std::variant<NativeHandle, JsonValue>;

struct AdapterResult {
  bool ok{false};
  AdapterValue value;
  std::string error_code;
  std::string message;
  std::string error_field;
};

using PrimitiveExecutor = AdapterResult (*)(
    NativeProgramPrimitiveHost&,
    NativeHandleFrame&,
    const NativeProgramOperation&,
    TimePoint);

struct PrimitiveBinding {
  std::string_view id;
  PrimitiveExecutor execute;
};

[[nodiscard]] AdapterResult adapter_success(AdapterValue value) {
  AdapterResult result;
  result.ok = true;
  result.value = std::move(value);
  return result;
}

template <typename Result>
[[nodiscard]] AdapterResult adapter_failure(const Result& result) {
  AdapterResult failure;
  failure.error_code = result.error_code.empty()
      ? "CAPABILITY_FAILED" : result.error_code;
  failure.message = result.message.empty()
      ? "native primitive failed" : result.message;
  failure.error_field = result.error_field;
  return failure;
}

[[nodiscard]] JsonValue json_value(JsonObject object) {
  return JsonValue{std::move(object)};
}

[[nodiscard]] JsonValue json_array(JsonValue::Array array) {
  return JsonValue{std::move(array)};
}

[[nodiscard]] JsonValue json_number(std::uint64_t value) {
  return JsonValue{JsonNumber{static_cast<double>(value)}};
}

[[nodiscard]] JsonValue json_number(std::int64_t value) {
  return JsonValue{JsonNumber{static_cast<double>(value)}};
}

[[nodiscard]] const JsonValue* member(
    const JsonObject& object, std::string_view name) {
  const auto found = std::find_if(
      object.begin(), object.end(), [&](const auto& entry) {
        return entry.first == name;
      });
  return found == object.end() ? nullptr : &found->second;
}

[[nodiscard]] const JsonObject& required_object(
    const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const auto* nested = value == nullptr
      ? nullptr : std::get_if<JsonObject>(&value->value);
  if (nested == nullptr) {
    throw std::invalid_argument(
        "native primitive argument is not an object: " + std::string(name));
  }
  return *nested;
}

[[nodiscard]] const JsonValue::Array& required_array(
    const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const auto* array = value == nullptr
      ? nullptr : std::get_if<JsonValue::Array>(&value->value);
  if (array == nullptr) {
    throw std::invalid_argument(
        "native primitive argument is not an array: " + std::string(name));
  }
  return *array;
}

[[nodiscard]] std::string required_string(
    const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const auto* text = value == nullptr
      ? nullptr : std::get_if<std::string>(&value->value);
  if (text == nullptr) {
    throw std::invalid_argument(
        "native primitive argument is not a string: " + std::string(name));
  }
  return *text;
}

[[nodiscard]] bool required_bool(
    const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const auto* boolean = value == nullptr
      ? nullptr : std::get_if<bool>(&value->value);
  if (boolean == nullptr) {
    throw std::invalid_argument(
        "native primitive argument is not a boolean: " + std::string(name));
  }
  return *boolean;
}

template <typename Integer>
[[nodiscard]] Integer required_integer(
    const JsonObject& object, std::string_view name) {
  const JsonValue* value = member(object, name);
  const auto* number = value == nullptr
      ? nullptr : std::get_if<JsonNumber>(&value->value);
  if (number == nullptr || !std::isfinite(number->value)
      || std::trunc(number->value) != number->value
      || number->value < static_cast<double>(std::numeric_limits<Integer>::min())
      || number->value > static_cast<double>(std::numeric_limits<Integer>::max())) {
    throw std::invalid_argument(
        "native primitive argument is not an integer: " + std::string(name));
  }
  return static_cast<Integer>(number->value);
}

[[nodiscard]] ObjectLocator locator_from_json(const JsonObject& object) {
  return {
      required_string(object, "kind"),
      required_string(object, "hostInstanceId"),
      required_string(object, "sessionId"),
      required_string(object, "projectId"),
      required_integer<std::uint64_t>(object, "generation"),
      required_string(object, "objectId"),
  };
}

[[nodiscard]] JsonValue locator_json(const ObjectLocator& locator) {
  return json_value({
      {"kind", JsonValue{locator.kind}},
      {"hostInstanceId", JsonValue{locator.host_instance_id}},
      {"sessionId", JsonValue{locator.session_id}},
      {"projectId", JsonValue{locator.project_id}},
      {"generation", json_number(locator.generation)},
      {"objectId", JsonValue{locator.object_id}},
  });
}

[[nodiscard]] JsonValue exact_time_json(const CompositionCurrentTime& time) {
  return json_value({
      {"value", json_number(static_cast<std::int64_t>(time.value))},
      {"scale", json_number(static_cast<std::uint64_t>(time.scale))},
      {"secondsRational", JsonValue{time.seconds_rational}},
  });
}

[[nodiscard]] JsonValue sample_time_json(const LayerPropertySampleTime& time) {
  return json_value({
      {"value", json_number(time.value)},
      {"scale", json_number(time.scale)},
  });
}

[[nodiscard]] JsonValue ratio_json(const CompositionPositiveRatio& ratio) {
  return json_value({
      {"numerator", json_number(static_cast<std::int64_t>(ratio.numerator))},
      {"denominator", json_number(static_cast<std::int64_t>(ratio.denominator))},
      {"rational", JsonValue{ratio.rational}},
  });
}

[[nodiscard]] CompositionCurrentTime exact_time_from_json(
    const JsonObject& object) {
  const auto value = required_integer<std::int32_t>(object, "value");
  const auto scale = required_integer<std::uint32_t>(object, "scale");
  return {value, scale, canonical_seconds_rational(value, scale)};
}

[[nodiscard]] LayerPropertySampleTime sample_time_from_json(
    const JsonObject& object) {
  return {
      required_integer<std::int64_t>(object, "value"),
      required_integer<std::uint64_t>(object, "scale"),
  };
}

[[nodiscard]] CompositionPositiveRatio positive_ratio_from_json(
    const JsonObject& object) {
  const auto numerator = required_integer<std::int32_t>(object, "numerator");
  const auto denominator =
      required_integer<std::int32_t>(object, "denominator");
  return {
      numerator,
      denominator,
      canonical_seconds_rational(
          numerator, static_cast<std::uint32_t>(denominator)),
  };
}

[[nodiscard]] std::string reference_name(
    const NativeProgramOperation& operation, std::string_view argument) {
  return required_string(required_object(operation.arguments, argument), "ref");
}

template <typename Handle>
[[nodiscard]] const Handle& required_handle(
    const NativeProgramOperation& operation,
    NativeHandleFrame& frame,
    std::string_view argument,
    HandleKind kind) {
  return std::get<Handle>(
      frame.require(reference_name(operation, argument), kind));
}

[[nodiscard]] LayerPropertyValue property_value_from_json(
    const JsonObject& object) {
  const std::string kind = required_string(object, "kind");
  if (kind == "scalar") {
    return LayerPropertyScalarValue{required_string(object, "value")};
  }
  if (kind == "vector") {
    LayerPropertyVectorValue result;
    for (const JsonValue& value : required_array(object, "components")) {
      const auto* component = std::get_if<std::string>(&value.value);
      if (component == nullptr) {
        throw std::invalid_argument("property vector component is not a string");
      }
      result.components.push_back(*component);
    }
    return result;
  }
  if (kind == "color") {
    return LayerPropertyColorValue{
        required_string(object, "alpha"),
        required_string(object, "red"),
        required_string(object, "green"),
        required_string(object, "blue"),
    };
  }
  throw std::invalid_argument("unknown property value kind");
}

[[nodiscard]] JsonValue property_value_json(const LayerPropertyValue& value) {
  if (const auto* scalar = std::get_if<LayerPropertyScalarValue>(&value)) {
    return json_value({
        {"kind", JsonValue{std::string("scalar")}},
        {"value", JsonValue{scalar->value}},
    });
  }
  if (const auto* vector = std::get_if<LayerPropertyVectorValue>(&value)) {
    JsonValue::Array components;
    for (const std::string& component : vector->components) {
      components.emplace_back(JsonValue{component});
    }
    return json_value({
        {"kind", JsonValue{std::string("vector")}},
        {"components", json_array(std::move(components))},
    });
  }
  if (const auto* color = std::get_if<LayerPropertyColorValue>(&value)) {
    return json_value({
        {"kind", JsonValue{std::string("color")}},
        {"alpha", JsonValue{color->alpha}},
        {"red", JsonValue{color->red}},
        {"green", JsonValue{color->green}},
        {"blue", JsonValue{color->blue}},
    });
  }
  return JsonValue{nullptr};
}

[[nodiscard]] JsonValue project_items_json(const ProjectItemsPage& page) {
  JsonValue::Array items;
  for (const ProjectItemEntry& item : page.items) {
    JsonObject value{
        {"locator", locator_json(item.locator)},
        {"name", JsonValue{item.name}},
        {"type", JsonValue{item.type}},
    };
    if (item.parent_locator.has_value()) {
      value.emplace_back("parentLocator", locator_json(*item.parent_locator));
    } else {
      value.emplace_back("parentLocator", JsonValue{nullptr});
    }
    items.emplace_back(json_value(std::move(value)));
  }
  JsonObject result{
      {"projectLocator", locator_json(page.project_locator)},
      {"total", json_number(page.total)},
      {"offset", json_number(page.offset)},
      {"limit", json_number(static_cast<std::uint64_t>(page.limit))},
      {"hasMore", JsonValue{page.has_more}},
      {"items", json_array(std::move(items))},
  };
  result.emplace_back(
      "nextOffset",
      page.next_offset.has_value()
          ? json_number(*page.next_offset) : JsonValue{nullptr});
  return json_value(std::move(result));
}

[[nodiscard]] JsonValue composition_layers_json(
    const CompositionLayersPage& page) {
  JsonValue::Array layers;
  for (const CompositionLayerEntry& layer : page.layers) {
    JsonObject value{
        {"locator", locator_json(layer.locator)},
        {"stackIndex", json_number(layer.stack_index)},
        {"name", JsonValue{layer.name}},
        {"type", JsonValue{layer.type}},
        {"videoEnabled", JsonValue{layer.video_enabled}},
        {"isThreeD", JsonValue{layer.is_three_d}},
        {"locked", JsonValue{layer.locked}},
        {"parentLocator", layer.parent_locator.has_value()
            ? locator_json(*layer.parent_locator) : JsonValue{nullptr}},
        {"sourceItemLocator", layer.source_item_locator.has_value()
            ? locator_json(*layer.source_item_locator) : JsonValue{nullptr}},
    };
    layers.emplace_back(json_value(std::move(value)));
  }
  JsonObject result{
      {"compositionLocator", locator_json(page.composition_locator)},
      {"compositionName", JsonValue{page.composition_name}},
      {"total", json_number(page.total)},
      {"offset", json_number(page.offset)},
      {"limit", json_number(static_cast<std::uint64_t>(page.limit))},
      {"hasMore", JsonValue{page.has_more}},
      {"layers", json_array(std::move(layers))},
  };
  result.emplace_back(
      "nextOffset",
      page.next_offset.has_value()
          ? json_number(*page.next_offset) : JsonValue{nullptr});
  return json_value(std::move(result));
}

[[nodiscard]] JsonValue composition_time_json(const CompositionTimeRead& value) {
  return json_value({
      {"compositionLocator", locator_json(value.composition_locator)},
      {"currentTime", exact_time_json(value.current_time)},
  });
}

[[nodiscard]] JsonValue composition_time_changed_json(
    const CompositionTimeChanged& value) {
  return json_value({
      {"changed", JsonValue{value.changed}},
      {"compositionLocator", locator_json(value.composition_locator)},
      {"beforeTime", exact_time_json(value.before_time)},
      {"afterTime", exact_time_json(value.after_time)},
  });
}

[[nodiscard]] JsonValue composition_settings_json(
    const CompositionSettings& value) {
  return json_value({
      {"compositionLocator", locator_json(value.composition_locator)},
      {"name", JsonValue{value.name}},
      {"width", json_number(static_cast<std::uint64_t>(value.width))},
      {"height", json_number(static_cast<std::uint64_t>(value.height))},
      {"duration", exact_time_json(value.duration)},
      {"frameDuration", exact_time_json(value.frame_duration)},
      {"frameRate", ratio_json(value.frame_rate)},
      {"pixelAspectRatio", ratio_json(value.pixel_aspect_ratio)},
      {"backgroundColor", json_value({
          {"red", json_number(static_cast<std::uint64_t>(
              value.background_color.red))},
          {"green", json_number(static_cast<std::uint64_t>(
              value.background_color.green))},
          {"blue", json_number(static_cast<std::uint64_t>(
              value.background_color.blue))},
          {"alpha", json_number(static_cast<std::uint64_t>(
              value.background_color.alpha))},
      })},
      {"workAreaStart", exact_time_json(value.work_area_start)},
      {"workAreaDuration", exact_time_json(value.work_area_duration)},
      {"displayStartTime", exact_time_json(value.display_start_time)},
      {"layerCount", json_number(value.layer_count)},
  });
}

[[nodiscard]] JsonValue composition_settings_changed_json(
    const CompositionSettingsChanged& value) {
  return json_value({
      {"changed", JsonValue{value.changed}},
      {"compositionLocator", locator_json(value.composition_locator)},
      {"before", composition_settings_json(value.before)},
      {"after", composition_settings_json(value.after)},
  });
}

[[nodiscard]] JsonValue layer_properties_json(
    const LayerPropertiesPage& page) {
  JsonValue::Array properties;
  for (const LayerPropertyEntry& property : page.properties) {
    JsonObject value{
        {"propertyLocator", locator_json(property.property_locator)},
        {"propertyIndex", json_number(property.property_index)},
        {"name", JsonValue{property.name}},
        {"matchName", JsonValue{property.match_name}},
        {"groupingType", JsonValue{property.grouping_type}},
        {"childCount", json_number(property.child_count)},
        {"hidden", JsonValue{property.hidden}},
        {"disabled", JsonValue{property.disabled}},
        {"modified", JsonValue{property.modified}},
        {"valueType", JsonValue{property.value_type}},
        {"valueStatus", JsonValue{property.value_status}},
        {"value", property_value_json(property.value)},
    };
    value.emplace_back(
        "canVaryOverTime",
        property.can_vary_over_time.has_value()
            ? JsonValue{*property.can_vary_over_time} : JsonValue{nullptr});
    value.emplace_back(
        "timeVarying",
        property.time_varying.has_value()
            ? JsonValue{*property.time_varying} : JsonValue{nullptr});
    properties.emplace_back(json_value(std::move(value)));
  }
  JsonObject result{
      {"layerLocator", locator_json(page.layer_locator)},
      {"parentPropertyLocator", page.parent_property_locator.has_value()
          ? locator_json(*page.parent_property_locator) : JsonValue{nullptr}},
      {"layerName", JsonValue{page.layer_name}},
      {"sampleTime", sample_time_json(page.sample_time)},
      {"total", json_number(page.total)},
      {"offset", json_number(page.offset)},
      {"limit", json_number(static_cast<std::uint64_t>(page.limit))},
      {"hasMore", JsonValue{page.has_more}},
      {"properties", json_array(std::move(properties))},
  };
  result.emplace_back(
      "nextOffset",
      page.next_offset.has_value()
          ? json_number(*page.next_offset) : JsonValue{nullptr});
  return json_value(std::move(result));
}

[[nodiscard]] JsonValue keyframe_entry_json(
    const LayerPropertyKeyframeEntry& value) {
  return json_value({
      {"keyframeIndex", json_number(value.keyframe_index)},
      {"time", sample_time_json(value.time)},
      {"value", property_value_json(value.value)},
      {"inInterpolation", JsonValue{value.in_interpolation}},
      {"outInterpolation", JsonValue{value.out_interpolation}},
  });
}

[[nodiscard]] JsonValue keyframes_json(
    const LayerPropertyKeyframesPage& page) {
  JsonValue::Array keyframes;
  for (const LayerPropertyKeyframeEntry& keyframe : page.keyframes) {
    keyframes.emplace_back(keyframe_entry_json(keyframe));
  }
  JsonObject result{
      {"propertyLocator", locator_json(page.property_locator)},
      {"valueType", JsonValue{page.value_type}},
      {"total", json_number(page.total)},
      {"offset", json_number(page.offset)},
      {"limit", json_number(static_cast<std::uint64_t>(page.limit))},
      {"hasMore", JsonValue{page.has_more}},
      {"keyframes", json_array(std::move(keyframes))},
  };
  result.emplace_back(
      "nextOffset",
      page.next_offset.has_value()
          ? json_number(*page.next_offset) : JsonValue{nullptr});
  return json_value(std::move(result));
}

[[nodiscard]] JsonValue keyframe_ease_json(
    const LayerPropertyKeyframeDimensionEase& value) {
  return json_value({
      {"dimension", json_number(static_cast<std::uint64_t>(value.dimension))},
      {"inEase", json_value({
          {"speed", JsonValue{value.in_ease.speed}},
          {"influence", JsonValue{value.in_ease.influence}},
      })},
      {"outEase", json_value({
          {"speed", JsonValue{value.out_ease.speed}},
          {"influence", JsonValue{value.out_ease.influence}},
      })},
  });
}

[[nodiscard]] JsonValue keyframe_details_json(
    const LayerPropertyKeyframeDetails& value) {
  JsonValue::Array ease;
  for (const LayerPropertyKeyframeDimensionEase& dimension :
       value.temporal_ease) {
    ease.emplace_back(keyframe_ease_json(dimension));
  }
  return json_value({
      {"propertyLocator", locator_json(value.property_locator)},
      {"time", sample_time_json(value.time)},
      {"valueType", JsonValue{value.value_type}},
      {"value", property_value_json(value.value)},
      {"temporalDimensionality",
          json_number(static_cast<std::uint64_t>(
              value.temporal_dimensionality))},
      {"inInterpolation", JsonValue{value.in_interpolation}},
      {"outInterpolation", JsonValue{value.out_interpolation}},
      {"temporalEase", json_array(std::move(ease))},
      {"behavior", json_value({
          {"temporalContinuous",
              JsonValue{value.behavior.temporal_continuous}},
          {"temporalAutoBezier",
              JsonValue{value.behavior.temporal_auto_bezier}},
          {"spatialContinuous",
              JsonValue{value.behavior.spatial_continuous}},
          {"spatialAutoBezier",
              JsonValue{value.behavior.spatial_auto_bezier}},
          {"roving", JsonValue{value.behavior.roving}},
      })},
  });
}

[[nodiscard]] JsonValue property_changed_json(
    const LayerPropertyChanged& value) {
  return json_value({
      {"changed", JsonValue{value.changed}},
      {"layerLocator", locator_json(value.layer_locator)},
      {"propertyLocator", locator_json(value.property_locator)},
      {"valueType", JsonValue{value.value_type}},
      {"beforeValue", property_value_json(value.before_value)},
      {"afterValue", property_value_json(value.after_value)},
  });
}

[[nodiscard]] JsonValue keyframe_changed_json(
    const LayerPropertyKeyframeChanged& value) {
  return json_value({
      {"changed", JsonValue{value.changed}},
      {"layerLocator", locator_json(value.layer_locator)},
      {"propertyLocator", locator_json(value.property_locator)},
      {"time", sample_time_json(value.time)},
      {"keyframeCountBefore", json_number(value.keyframe_count_before)},
      {"keyframeCountAfter", json_number(value.keyframe_count_after)},
      {"before", value.before.has_value()
          ? keyframe_details_json(*value.before) : JsonValue{nullptr}},
      {"after", value.after.has_value()
          ? keyframe_details_json(*value.after) : JsonValue{nullptr}},
  });
}

[[nodiscard]] AdapterResult execute_composition_resolve(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame&,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  NativeHandleResolveResult result = host.resolve_native_handle(
      HandleKind::kComposition,
      locator_from_json(required_object(operation.arguments, "locator")),
      std::nullopt,
      deadline);
  return result.ok
      ? adapter_success(std::move(result.value)) : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_layer_resolve(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  NativeHandleResolveResult result = host.resolve_native_handle(
      HandleKind::kLayer,
      locator_from_json(required_object(operation.arguments, "locator")),
      composition.locator,
      deadline);
  return result.ok
      ? adapter_success(std::move(result.value)) : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_property_resolve(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& layer = required_handle<ScopedLayerHandle>(
      operation, frame, "layer", HandleKind::kLayer);
  NativeHandleResolveResult result = host.resolve_native_handle(
      HandleKind::kProperty,
      locator_from_json(required_object(operation.arguments, "locator")),
      layer.resolved.locator,
      deadline);
  return result.ok
      ? adapter_success(std::move(result.value)) : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_project_items_list(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  ProjectItemsQuery query;
  query.offset = required_integer<std::uint64_t>(
      operation.arguments, "offset");
  query.limit = required_integer<std::uint16_t>(
      operation.arguments, "limit");
  if (const JsonValue* locator = member(
          operation.arguments, "projectLocator")) {
    const auto* object = std::get_if<JsonObject>(&locator->value);
    if (object == nullptr) {
      throw std::invalid_argument("projectLocator is not an object");
    }
    query.project_locator = locator_from_json(*object);
    query.host_instance_id = query.project_locator->host_instance_id;
    query.session_id = query.project_locator->session_id;
  } else {
    query.host_instance_id = frame.host_instance_id();
    query.session_id = frame.session_id();
  }
  HostProjectItemsResult result = host.list_project_items(query, deadline);
  return result.ok
      ? adapter_success(project_items_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] CompositionLayersQuery composition_layers_query(
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  return {
      composition.locator.host_instance_id,
      composition.locator.session_id,
      required_integer<std::uint64_t>(operation.arguments, "offset"),
      required_integer<std::uint16_t>(operation.arguments, "limit"),
      composition.locator,
  };
}

[[nodiscard]] AdapterResult execute_composition_layers_list(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  HostCompositionLayersResult result = host.list_composition_layers(
      composition_layers_query(frame, operation), deadline);
  return result.ok
      ? adapter_success(composition_layers_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_selectedLayers_list(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  HostCompositionLayersResult result =
      host.list_selected_composition_layers(
          composition_layers_query(frame, operation), deadline);
  return result.ok
      ? adapter_success(composition_layers_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_time_read(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  HostCompositionTimeResult result = host.read_composition_time({
      composition.locator.host_instance_id,
      composition.locator.session_id,
      composition.locator,
  }, deadline);
  return result.ok
      ? adapter_success(composition_time_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_time_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  HostCompositionTimeWriteResult result = host.set_composition_time({
      composition.locator.host_instance_id,
      composition.locator.session_id,
      composition.locator,
      exact_time_from_json(required_object(
          operation.arguments, "targetTime")),
  }, deadline);
  return result.ok
      ? adapter_success(composition_time_changed_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_settings_read(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  HostCompositionSettingsResult result = host.read_composition_settings({
      composition.locator.host_instance_id,
      composition.locator.session_id,
      composition.locator,
  }, deadline);
  return result.ok
      ? adapter_success(composition_settings_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_setting_write(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline,
    CompositionSettingKind kind,
    std::string_view argument) {
  const auto& composition = required_handle<ScopedCompositionHandle>(
      operation, frame, "composition", HandleKind::kComposition);
  CompositionSettingsSetCommand command;
  command.host_instance_id = composition.locator.host_instance_id;
  command.session_id = composition.locator.session_id;
  command.composition_locator = composition.locator;
  command.kind = kind;
  if (kind == CompositionSettingKind::kFrameRate
      || kind == CompositionSettingKind::kPixelAspectRatio) {
    command.ratio = positive_ratio_from_json(
        required_object(operation.arguments, argument));
  } else {
    command.time = exact_time_from_json(
        required_object(operation.arguments, argument));
  }
  HostCompositionSettingsWriteResult result =
      host.set_composition_setting(command, deadline);
  return result.ok
      ? adapter_success(composition_settings_changed_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_composition_duration_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  return execute_composition_setting_write(
      host, frame, operation, deadline,
      CompositionSettingKind::kDuration, "duration");
}

[[nodiscard]] AdapterResult execute_composition_frameRate_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  return execute_composition_setting_write(
      host, frame, operation, deadline,
      CompositionSettingKind::kFrameRate, "frameRate");
}

[[nodiscard]] AdapterResult execute_composition_pixelAspectRatio_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  return execute_composition_setting_write(
      host, frame, operation, deadline,
      CompositionSettingKind::kPixelAspectRatio, "pixelAspectRatio");
}

[[nodiscard]] AdapterResult execute_composition_displayStartTime_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  return execute_composition_setting_write(
      host, frame, operation, deadline,
      CompositionSettingKind::kDisplayStartTime, "displayStartTime");
}

[[nodiscard]] AdapterResult execute_layer_properties_list(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& layer = required_handle<ScopedLayerHandle>(
      operation, frame, "layer", HandleKind::kLayer);
  LayerPropertiesQuery query{
      layer.resolved.locator.host_instance_id,
      layer.resolved.locator.session_id,
      required_integer<std::uint64_t>(operation.arguments, "offset"),
      required_integer<std::uint16_t>(operation.arguments, "limit"),
      layer.resolved.locator,
      std::nullopt,
  };
  if (member(operation.arguments, "parentProperty") != nullptr) {
    const auto& parent = required_handle<ScopedPropertyHandle>(
        operation, frame, "parentProperty", HandleKind::kProperty);
    query.parent_property_locator = parent.locator;
  }
  HostLayerPropertiesResult result =
      host.list_layer_properties(query, deadline);
  return result.ok
      ? adapter_success(layer_properties_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_property_keyframes_list(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& property = required_handle<ScopedPropertyHandle>(
      operation, frame, "property", HandleKind::kProperty);
  HostLayerPropertyKeyframesResult result =
      host.list_layer_property_keyframes({
          property.locator.host_instance_id,
          property.locator.session_id,
          required_integer<std::uint64_t>(operation.arguments, "offset"),
          required_integer<std::uint16_t>(operation.arguments, "limit"),
          property.locator,
      }, deadline);
  return result.ok
      ? adapter_success(keyframes_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_property_value_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& layer = required_handle<ScopedLayerHandle>(
      operation, frame, "layer", HandleKind::kLayer);
  const auto& property = required_handle<ScopedPropertyHandle>(
      operation, frame, "property", HandleKind::kProperty);
  HostLayerPropertyWriteResult result = host.set_layer_property({
      layer.resolved.locator.host_instance_id,
      layer.resolved.locator.session_id,
      layer.resolved.locator,
      property.locator,
      property_value_from_json(required_object(operation.arguments, "value")),
  }, deadline);
  return result.ok
      ? adapter_success(property_changed_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_property_keyframe_details_read(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  const auto& property = required_handle<ScopedPropertyHandle>(
      operation, frame, "property", HandleKind::kProperty);
  HostLayerPropertyKeyframeDetailsResult result =
      host.read_layer_property_keyframe_details({
          property.locator.host_instance_id,
          property.locator.session_id,
          property.locator,
          sample_time_from_json(required_object(operation.arguments, "time")),
      }, deadline);
  return result.ok
      ? adapter_success(keyframe_details_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] LayerPropertyKeyframeMutationCommand keyframe_command(
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    LayerPropertyKeyframeMutationKind kind) {
  const auto& layer = required_handle<ScopedLayerHandle>(
      operation, frame, "layer", HandleKind::kLayer);
  const auto& property = required_handle<ScopedPropertyHandle>(
      operation, frame, "property", HandleKind::kProperty);
  LayerPropertyKeyframeMutationCommand command;
  command.host_instance_id = layer.resolved.locator.host_instance_id;
  command.session_id = layer.resolved.locator.session_id;
  command.layer_locator = layer.resolved.locator;
  command.property_locator = property.locator;
  command.time = sample_time_from_json(
      required_object(operation.arguments, "time"));
  command.kind = kind;
  return command;
}

[[nodiscard]] AdapterResult execute_keyframe_write(
    NativeProgramPrimitiveHost& host,
    LayerPropertyKeyframeMutationCommand command,
    TimePoint deadline) {
  HostLayerPropertyKeyframeWriteResult result =
      host.mutate_layer_property_keyframe(command, deadline);
  return result.ok
      ? adapter_success(keyframe_changed_json(result.value))
      : adapter_failure(result);
}

[[nodiscard]] AdapterResult execute_property_keyframe_add(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  auto command = keyframe_command(
      frame, operation, LayerPropertyKeyframeMutationKind::kAdd);
  command.value = property_value_from_json(
      required_object(operation.arguments, "value"));
  return execute_keyframe_write(host, std::move(command), deadline);
}

[[nodiscard]] AdapterResult execute_property_keyframe_value_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  auto command = keyframe_command(
      frame, operation, LayerPropertyKeyframeMutationKind::kSetValue);
  command.value = property_value_from_json(
      required_object(operation.arguments, "value"));
  return execute_keyframe_write(host, std::move(command), deadline);
}

[[nodiscard]] AdapterResult execute_property_keyframe_interpolation_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  auto command = keyframe_command(
      frame, operation, LayerPropertyKeyframeMutationKind::kSetInterpolation);
  command.in_interpolation =
      required_string(operation.arguments, "inInterpolation");
  command.out_interpolation =
      required_string(operation.arguments, "outInterpolation");
  return execute_keyframe_write(host, std::move(command), deadline);
}

[[nodiscard]] AdapterResult execute_property_keyframe_temporalEase_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  auto command = keyframe_command(
      frame, operation, LayerPropertyKeyframeMutationKind::kSetTemporalEase);
  for (const JsonValue& value :
       required_array(operation.arguments, "dimensions")) {
    const auto* dimension = std::get_if<JsonObject>(&value.value);
    if (dimension == nullptr) {
      throw std::invalid_argument("keyframe ease dimension is not an object");
    }
    const JsonObject& in_ease = required_object(*dimension, "inEase");
    const JsonObject& out_ease = required_object(*dimension, "outEase");
    command.temporal_ease.push_back({
        required_integer<std::uint16_t>(*dimension, "dimension"),
        {required_string(in_ease, "speed"),
         required_string(in_ease, "influence")},
        {required_string(out_ease, "speed"),
         required_string(out_ease, "influence")},
    });
  }
  return execute_keyframe_write(host, std::move(command), deadline);
}

[[nodiscard]] AdapterResult execute_property_keyframe_behavior_set(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  auto command = keyframe_command(
      frame, operation, LayerPropertyKeyframeMutationKind::kSetBehavior);
  command.behavior = required_string(operation.arguments, "behavior");
  command.enabled = required_bool(operation.arguments, "enabled");
  return execute_keyframe_write(host, std::move(command), deadline);
}

[[nodiscard]] AdapterResult execute_property_keyframe_delete(
    NativeProgramPrimitiveHost& host,
    NativeHandleFrame& frame,
    const NativeProgramOperation& operation,
    TimePoint deadline) {
  return execute_keyframe_write(
      host,
      keyframe_command(
          frame, operation, LayerPropertyKeyframeMutationKind::kDelete),
      deadline);
}

#define AEMCP_NATIVE_PRIMITIVE(id, executor) PrimitiveBinding{id, &executor},
inline constexpr std::array<PrimitiveBinding, kNativePrimitiveCount>
    kNativePrimitiveBindings{{
#include "native_primitive_bindings.generated.inc"
    }};
#undef AEMCP_NATIVE_PRIMITIVE

static_assert(
    kNativePrimitiveBindings.size() == kNativePrimitiveRegistry.size());

[[nodiscard]] HandleKind handle_kind(const NativeHandle& handle) {
  if (std::holds_alternative<ScopedCompositionHandle>(handle)) {
    return HandleKind::kComposition;
  }
  if (std::holds_alternative<ScopedLayerHandle>(handle)) {
    return HandleKind::kLayer;
  }
  return HandleKind::kProperty;
}

}  // namespace

NativeHandleFrame::NativeHandleFrame(
    std::string_view host_instance_id,
    std::string_view session_id)
    : host_instance_id_(host_instance_id),
      session_id_(session_id) {}

void NativeHandleFrame::save(std::string name, NativeHandle value) {
  if (name.empty() || !handles_.emplace(std::move(name), std::move(value)).second) {
    throw std::invalid_argument("native handle name is empty or duplicated");
  }
}

const NativeHandle& NativeHandleFrame::require(
    std::string_view name, HandleKind expected) const {
  const auto found = handles_.find(std::string(name));
  if (found == handles_.end()) {
    throw std::invalid_argument("native handle reference was not found");
  }
  if (handle_kind(found->second) != expected) {
    throw std::invalid_argument("native handle reference has the wrong kind");
  }
  return found->second;
}

void NativeHandleFrame::clear() noexcept {
  handles_.clear();
}

bool NativeHandleFrame::empty() const noexcept {
  return handles_.empty();
}

std::string_view NativeHandleFrame::host_instance_id() const noexcept {
  return host_instance_id_;
}

std::string_view NativeHandleFrame::session_id() const noexcept {
  return session_id_;
}

NativeHandleResolveResult NativeHandleResolveResult::success(
    NativeHandle handle) {
  NativeHandleResolveResult result;
  result.ok = true;
  result.value = std::move(handle);
  return result;
}

NativeHandleResolveResult NativeHandleResolveResult::failure(
    std::string code, std::string detail, std::string field) {
  NativeHandleResolveResult result;
  result.error_code = std::move(code);
  result.message = std::move(detail);
  result.error_field = std::move(field);
  return result;
}

NativeProgramHostResult execute_native_program(
    NativeProgramPrimitiveHost& host,
    const NativeProgram& program,
    std::string_view host_instance_id,
    std::string_view session_id,
    TimePoint work_deadline) {
  NativeHandleFrame frame(host_instance_id, session_id);
  struct FrameClear final {
    NativeHandleFrame& frame;
    ~FrameClear() { frame.clear(); }
  } clear{frame};

  ProgramAdmission admission;
  try {
    admission = validate_native_program(
        program, native_primitive_registry());
  } catch (const std::exception& error) {
    return NativeProgramHostResult::failure(
        "INVALID_ARGUMENT",
        error.what(),
        "params.arguments",
        {},
        std::nullopt,
        false,
        NativeProgramDisposition::kNotStarted);
  }

  std::vector<NativeProgramOperationOutcome> outcomes;
  JsonObject outputs;
  std::vector<std::size_t> completed;
  bool completed_write = false;
  outcomes.reserve(program.operations.size());
  completed.reserve(program.operations.size());
  for (std::size_t index = 0; index < program.operations.size(); ++index) {
    if (std::chrono::steady_clock::now() >= work_deadline) {
      return NativeProgramHostResult::failure(
          completed_write ? "POSSIBLY_SIDE_EFFECTING_FAILURE"
                          : "DEADLINE_EXCEEDED",
          "native program execution budget elapsed",
          {},
          std::move(completed),
          index,
          completed_write,
          completed_write
              ? NativeProgramDisposition::kPossiblySideEffecting
              : NativeProgramDisposition::kCompleted);
    }
    const NativePrimitiveDescriptor* descriptor = admission.descriptors[index];
    const std::ptrdiff_t binding_index =
        descriptor - native_primitive_registry().data();
    if (binding_index < 0
        || static_cast<std::size_t>(binding_index)
            >= kNativePrimitiveBindings.size()
        || kNativePrimitiveBindings[static_cast<std::size_t>(binding_index)].id
            != descriptor->id) {
      return NativeProgramHostResult::failure(
          "NATIVE_UNAVAILABLE",
          "generated native primitive binding is inconsistent",
          {},
          std::move(completed),
          index,
          completed_write,
          completed_write
              ? NativeProgramDisposition::kPossiblySideEffecting
              : NativeProgramDisposition::kCompleted);
    }
    AdapterResult result;
    try {
      result = kNativePrimitiveBindings[
          static_cast<std::size_t>(binding_index)].execute(
              host, frame, program.operations[index], work_deadline);
    } catch (const std::exception& error) {
      const bool possibly_side_effecting =
          completed_write
          || descriptor->mutability == PrimitiveMutability::kWrite;
      return NativeProgramHostResult::failure(
          possibly_side_effecting
              ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : "CAPABILITY_FAILED",
          error.what(),
          {},
          std::move(completed),
          index,
          possibly_side_effecting,
          possibly_side_effecting
              ? NativeProgramDisposition::kPossiblySideEffecting
              : NativeProgramDisposition::kCompleted);
    }
    if (!result.ok) {
      const bool possibly_side_effecting =
          completed_write
          || (descriptor->mutability == PrimitiveMutability::kWrite
              && result.error_code == "POSSIBLY_SIDE_EFFECTING_FAILURE");
      return NativeProgramHostResult::failure(
          possibly_side_effecting
              ? "POSSIBLY_SIDE_EFFECTING_FAILURE" : result.error_code,
          result.message,
          result.error_field,
          std::move(completed),
          index,
          possibly_side_effecting,
          possibly_side_effecting
              ? NativeProgramDisposition::kPossiblySideEffecting
              : NativeProgramDisposition::kCompleted);
    }

    JsonValue public_value{nullptr};
    if (auto* handle = std::get_if<NativeHandle>(&result.value)) {
      if (program.operations[index].save_as.has_value()) {
        frame.save(*program.operations[index].save_as, std::move(*handle));
      }
    } else {
      public_value = std::move(std::get<JsonValue>(result.value));
      if (program.operations[index].return_as.has_value()) {
        outputs.emplace_back(
            *program.operations[index].return_as, public_value);
      }
    }
    outcomes.push_back({
        index,
        program.operations[index].primitive_id,
        std::move(public_value),
    });
    completed.push_back(index);
    completed_write = completed_write
        || descriptor->mutability == PrimitiveMutability::kWrite;
  }

  NativeProgramHostResult result = NativeProgramHostResult::success(
      std::move(outcomes), std::move(outputs));
  result.write_started = completed_write;
  return result;
}

}  // namespace aemcp::native

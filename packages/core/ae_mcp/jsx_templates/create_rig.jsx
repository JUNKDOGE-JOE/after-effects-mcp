(function () {
  function fail(message) {
    return JSON.stringify({ ok: false, error: String(message) });
  }

  function failObject(message) {
    return { ok: false, error: String(message) };
  }

  function getTransformProp(layer, name) {
    var group = layer.property("ADBE Transform Group");
    if (!group) {
      return null;
    }
    var map = {
      "Position": "ADBE Position",
      "Scale": "ADBE Scale",
      "Rotation": layer.threeDLayer ? "ADBE Rotate Z" : "ADBE Rotate Z",
      "Opacity": "ADBE Opacity"
    };
    return group.property(map[name]) || group.property(name);
  }

  function setExpression(prop, expression) {
    if (!prop || !prop.canSetExpression) {
      return false;
    }
    prop.expression = expression;
    return true;
  }

  function addController(comp, target, name) {
    var controller = comp.layers.addNull();
    controller.name = name;
    controller.threeDLayer = target.threeDLayer;
    try {
      controller.moveBefore(target);
    } catch (_moveError) {
    }
    try {
      var targetPosition = getTransformProp(target, "Position");
      if (targetPosition) {
        getTransformProp(controller, "Position").setValue(targetPosition.value);
      }
    } catch (_positionError) {
    }
    return controller;
  }

  function expressionForController(controllerName, propertyName) {
    return 'thisComp.layer(' + JSON.stringify(controllerName) + ').transform.' + propertyName;
  }

  function createTransformController(comp, target, name, options) {
    var controller = addController(comp, target, name);
    var wired = [];
    var config = {
      Position: options.position !== false,
      Scale: options.scale === true,
      Rotation: options.rotation !== false,
      Opacity: options.opacity === true
    };
    var expressionNames = {
      Position: "position",
      Scale: "scale",
      Rotation: "rotation",
      Opacity: "opacity"
    };
    for (var key in config) {
      if (!config[key]) {
        continue;
      }
      if (setExpression(getTransformProp(target, key), expressionForController(controller.name, expressionNames[key]))) {
        wired.push("Transform/" + key);
      }
    }
    return {
      ok: true,
      rigType: "transform_controller",
      controllerLayerId: controller.index,
      targetLayerId: target.index,
      createdLayers: [controller.index],
      wiredProperties: wired
    };
  }

  function effectPropertyName(type) {
    if (type === "angle") {
      return "Angle";
    }
    if (type === "checkbox") {
      return "Checkbox";
    }
    if (type === "color") {
      return "Color";
    }
    return "Slider";
  }

  function effectMatchName(type) {
    if (type === "angle") {
      return "ADBE Angle Control";
    }
    if (type === "checkbox") {
      return "ADBE Checkbox Control";
    }
    if (type === "color") {
      return "ADBE Color Control";
    }
    return "ADBE Slider Control";
  }

  function targetPropertyFromPath(target, path) {
    if (path === "Transform/Position") {
      return getTransformProp(target, "Position");
    }
    if (path === "Transform/Scale") {
      return getTransformProp(target, "Scale");
    }
    if (path === "Transform/Rotation") {
      return getTransformProp(target, "Rotation");
    }
    if (path === "Transform/Opacity") {
      return getTransformProp(target, "Opacity");
    }
    return null;
  }

  function createEffectControls(comp, target, name, options) {
    var controller = addController(comp, target, name);
    var effects = controller.property("ADBE Effect Parade");
    var controls = options.controls || [
      { name: "Opacity", type: "slider", property: "Transform/Opacity" }
    ];
    var wired = [];
    for (var i = 0; i < controls.length; i += 1) {
      var spec = controls[i];
      var effect = effects.addProperty(effectMatchName(spec.type || "slider"));
      effect.name = spec.name || ("Control " + (i + 1));
      var targetProp = targetPropertyFromPath(target, spec.property || "Transform/Opacity");
      var childName = effectPropertyName(spec.type || "slider");
      var expr = 'thisComp.layer(' + JSON.stringify(controller.name) + ').effect(' +
        JSON.stringify(effect.name) + ')(' + JSON.stringify(childName) + ')';
      if (setExpression(targetProp, expr)) {
        wired.push(spec.property || "Transform/Opacity");
      }
    }
    return {
      ok: true,
      rigType: "effect_controls",
      controllerLayerId: controller.index,
      targetLayerId: target.index,
      createdLayers: [controller.index],
      wiredProperties: wired
    };
  }

  function createPuppetPinNulls(comp, target, name, options) {
    var effects = target.property("ADBE Effect Parade");
    var foundPuppet = false;
    if (effects) {
      for (var i = 1; i <= effects.numProperties; i += 1) {
        var effect = effects.property(i);
        if (effect && effect.matchName === "ADBE FreePin3") {
          foundPuppet = true;
        }
      }
    }
    if (!foundPuppet) {
      return {
        ok: true,
        rigType: "puppet_pin_nulls",
        targetLayerId: target.index,
        createdLayers: [],
        wiredProperties: [],
        skipped: true,
        reason: "no puppet pins found"
      };
    }
    return fail("puppet pin null wiring is not available for this Puppet structure yet");
  }

  function applyPreset(target, options) {
    var presetPath = options.preset_path || options.presetPath;
    if (!presetPath) {
      return failObject("preset_path is required for apply_preset");
    }
    var file = new File(presetPath);
    if (!file.exists) {
      return failObject("preset not found: " + presetPath);
    }
    target.selected = true;
    target.applyPreset(file);
    return {
      ok: true,
      rigType: "apply_preset",
      targetLayerId: target.index,
      createdLayers: [],
      wiredProperties: [],
      presetPath: file.fsName
    };
  }

  try {
    var comp = $comp_expr;
    if (!comp || !(comp instanceof CompItem)) {
      return fail("No active comp, or comp_id did not resolve to a CompItem.");
    }
    var target = AEMCP.layerById(comp, $target_layer_id);
    if (!target) {
      return fail("target layer not found: " + $target_layer_id);
    }

    var rigType = $rig_type;
    var name = $name;
    var options = $options || {};
    var result;
    if (rigType === "transform_controller") {
      result = createTransformController(comp, target, name, options);
    } else if (rigType === "effect_controls") {
      result = createEffectControls(comp, target, name, options);
    } else if (rigType === "puppet_pin_nulls") {
      result = createPuppetPinNulls(comp, target, name, options);
    } else if (rigType === "apply_preset") {
      result = applyPreset(target, options);
    } else {
      return fail("unknown rig_type: " + rigType);
    }
    return JSON.stringify(result);
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  }
}());

"""Live tests for the AEMCP runtime helper namespace (plugin/jsx/runtime.jsx).

These verify the helpers are actually loaded into the panel's persistent
ExtendScript engine and behave per the never-throw invariant. Regression
guard: compById once threw "{Item Not Found}" on an unknown id because AE
26.2's itemByID throws instead of returning null.
"""
from __future__ import annotations

import asyncio
import json

import pytest


pytestmark = pytest.mark.live


HELPERS_PROBE = r"""
(function(){
  var R = {};
  R.loaded = (typeof AEMCP !== 'undefined');
  if (!R.loaded) return JSON.stringify(R);
  var comp = app.project.items.addComp("HelperProbe", 320, 240, 1, 2.0, 24);
  try {
    var solid = comp.layers.addSolid([1,0,0], "Box", 100, 100, 1, 2.0);
    R.version              = AEMCP.version;
    R.compById_ok          = (AEMCP.compById(comp.id) === comp);
    R.compById_bad_null    = (AEMCP.compById(987654) === null);   // must NOT throw
    comp.openInViewer();   // make it the foreground item so activeItem is set
    R.activeComp_isComp    = (AEMCP.activeComp() === comp);
    R.layerById_ok         = (AEMCP.layerById(comp, 1) === solid);
    R.layerById_bad_null   = (AEMCP.layerById(comp, 99) === null);
    var pPath  = AEMCP.propByPath(solid, "Transform/Position");
    var pMatch = AEMCP.propByMatchPath(solid, "ADBE Transform Group#1/ADBE Position#1");
    R.propByPath_ok        = (pPath !== null && typeof pPath.value !== 'undefined');
    R.propByMatchPath_mn   = pMatch ? pMatch.matchName : null;
    // prove both refs target the same property via write-through-one/read-other
    pPath.setValue([123, 45]);
    R.same_target          = (pMatch.value[0] === 123 && pMatch.value[1] === 45);
    R.propByPath_bad_null  = (AEMCP.propByPath(solid, "Nope/Nope") === null);
    R.propByMatch_bad_null = (AEMCP.propByMatchPath(solid, "ADBE No#1/ADBE Nope#1") === null);
    R.ordinal_overflow     = (AEMCP.propByMatchPath(solid, "ADBE Transform Group#9") === null);
  } catch (e) { R.ERROR = String(e); }
  try { comp.remove(); } catch (e) {}
  return JSON.stringify(R);
})()
"""


@pytest.fixture
def helpers(clean_project):
    out = asyncio.run(clean_project.exec(code=HELPERS_PROBE, timeout_sec=20.0))
    return json.loads(out)


def test_aemcp_namespace_loaded(helpers):
    assert helpers.get("loaded") is True, "AEMCP namespace not in the engine — is runtime.jsx current?"
    assert helpers.get("version")


def test_aemcp_helpers_resolve_and_never_throw(helpers):
    assert "ERROR" not in helpers, f"helper threw: {helpers.get('ERROR')}"
    assert helpers["compById_ok"] is True
    assert helpers["compById_bad_null"] is True       # regression: itemByID throws on unknown id
    assert helpers["activeComp_isComp"] is True
    assert helpers["layerById_ok"] is True
    assert helpers["layerById_bad_null"] is True
    assert helpers["propByPath_ok"] is True
    assert helpers["propByMatchPath_mn"] == "ADBE Position"
    assert helpers["same_target"] is True
    assert helpers["propByPath_bad_null"] is True
    assert helpers["propByMatch_bad_null"] is True
    assert helpers["ordinal_overflow"] is True

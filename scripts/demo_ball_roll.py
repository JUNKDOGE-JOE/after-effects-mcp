"""End-to-end demo: build a rolling-ball MG comp in AE, render 3 frames.

Run:
    AE_MCP_BACKEND=ae-mcp AE_MCP_PLUGIN_URL=http://127.0.0.1:11488 \
        python scripts/demo_ball_roll.py
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ae_mcp.backends.discovery import select_backend
from ae_mcp import schemas
from ae_mcp.handlers.core import _run_preview_frame

DURATION = 5.0      # seconds
FPS = 30
W, H = 1920, 1080
BALL_RADIUS = 80
GROUND_Y = 850
START_X = 200
END_X = 1720
DISTANCE = END_X - START_X
# Roll without slipping: rotation = distance / circumference.
TOTAL_ROT_DEG = DISTANCE / (2 * 3.141592653589793 * BALL_RADIUS) * 360.0

SETUP_JSX = f"""
(function() {{
    try {{
    app.beginUndoGroup("Ball Roll MG");

    // 1) New comp
    var comp = app.project.items.addComp("BallRoll", {W}, {H}, 1.0, {DURATION}, {FPS});
    comp.openInViewer();

    // 2) Background — dark navy
    var bg = comp.layers.addSolid([0.10, 0.13, 0.20], "BG", {W}, {H}, 1.0, {DURATION});

    // 3) Ground bar — light blue, near bottom
    var ground = comp.layers.addShape();
    ground.name = "Ground";
    var gContents = ground.property("ADBE Root Vectors Group");
    var gGroup = gContents.addProperty("ADBE Vector Group");
    var gItems = gGroup.property("ADBE Vectors Group");
    var gRect = gItems.addProperty("ADBE Vector Shape - Rect");
    gRect.property("ADBE Vector Rect Size").setValue([{W}, 6]);
    gRect.property("ADBE Vector Rect Position").setValue([0, 0]);
    var gFill = gItems.addProperty("ADBE Vector Graphic - Fill");
    gFill.property("ADBE Vector Fill Color").setValue([0.6, 0.7, 0.85]);
    ground.property("Position").setValue([{W / 2}, {GROUND_Y}]);

    // 4) Ball — orange ellipse
    var ball = comp.layers.addShape();
    ball.name = "Ball";
    var bContents = ball.property("ADBE Root Vectors Group");
    var bGroup = bContents.addProperty("ADBE Vector Group");
    var bItems = bGroup.property("ADBE Vectors Group");
    var bEll = bItems.addProperty("ADBE Vector Shape - Ellipse");
    bEll.property("ADBE Vector Ellipse Size").setValue([{BALL_RADIUS * 2}, {BALL_RADIUS * 2}]);
    var bFill = bItems.addProperty("ADBE Vector Graphic - Fill");
    bFill.property("ADBE Vector Fill Color").setValue([1.0, 0.55, 0.10]);

    // Ball position keyframes (linear x, sits on ground)
    var ballGroundY = {GROUND_Y - BALL_RADIUS};
    var xform = ball.property("ADBE Transform Group");
    var pos = xform.property("ADBE Position");
    pos.setValueAtTime(0.0, [{START_X}, ballGroundY]);
    pos.setValueAtTime({DURATION - 1}, [{END_X}, ballGroundY]);

    // Ball rotation — roll matching distance (no slip)
    var rot = xform.property("ADBE Rotate Z");
    rot.setValueAtTime(0.0, 0);
    rot.setValueAtTime({DURATION - 1}, {TOTAL_ROT_DEG});

    // Add a small inner indicator stripe so rotation is visible
    var stripeGroup = bContents.addProperty("ADBE Vector Group");
    stripeGroup.name = "Stripe";
    var stripeItems = stripeGroup.property("ADBE Vectors Group");
    var stripeRect = stripeItems.addProperty("ADBE Vector Shape - Rect");
    stripeRect.property("ADBE Vector Rect Size").setValue([{BALL_RADIUS * 2 - 20}, 12]);
    stripeRect.property("ADBE Vector Rect Position").setValue([0, 0]);
    var stripeFill = stripeItems.addProperty("ADBE Vector Graphic - Fill");
    stripeFill.property("ADBE Vector Fill Color").setValue([1, 1, 1]);

    app.endUndoGroup();

    return JSON.stringify({{
        ok: true,
        compId: String(comp.id),
        compName: comp.name,
        layers: comp.numLayers,
        durationSec: comp.duration,
        totalRotationDeg: {TOTAL_ROT_DEG}
    }});
    }} catch (e) {{
        return JSON.stringify({{ok:false, error: String(e), line: e.line || 'n/a'}});
    }}
}})()
"""


async def main():
    backend = select_backend()
    print("backend:", backend.name, "@", backend.url)

    # 1) Build the scene
    print("\n[1/3] Creating BallRoll comp...")
    out = await backend.exec(code=SETUP_JSX, timeout_sec=30.0)
    info = json.loads(out)
    print("  →", json.dumps(info, indent=2, ensure_ascii=False))
    if not info.get("ok"):
        return
    comp_id = info["compId"]

    # 2) Render 3 sample frames via ae.previewFrame
    import tempfile
    out_dir = Path(tempfile.gettempdir()) / "ball_roll_frames"
    out_dir.mkdir(parents=True, exist_ok=True)

    times = [0.0, 2.0, 4.0]
    print(f"\n[2/3] Rendering {len(times)} frames -> {out_dir} ...")
    args = schemas.AePreviewFrameArgs(
        comp_id=comp_id,
        times=times,
        out_dir=str(out_dir),
        include_base64=False,
    )
    result = await _run_preview_frame(args, ctx=None)
    print("  →", json.dumps(result, indent=2, ensure_ascii=False)[:500])

    # 3) Done
    await backend.shutdown()
    print("\n[3/3] Done. Open the comp in AE viewer to scrub the timeline.")


if __name__ == "__main__":
    asyncio.run(main())

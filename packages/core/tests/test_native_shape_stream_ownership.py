from pathlib import Path


PLUGIN_ENTRY = Path("native/ae-plugin/src/aegp/plugin_entry.cpp")


def test_shape_child_lookup_retains_the_indexed_stream_reference() -> None:
    source = PLUGIN_ENTRY.read_text(encoding="utf-8")
    lookup = source.split("const auto unique_child =", 1)[1].split(
        "const auto path_data =", 1
    )[0]

    assert "AEGP_GetNewStreamRefByIndex" in lookup
    assert "std::optional<StreamRefOwner> found" in lookup
    assert "found.emplace(std::move(child))" in lookup
    assert "AEGP_GetNewStreamRefByMatchname" not in lookup

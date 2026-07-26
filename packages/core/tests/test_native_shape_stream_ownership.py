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


def test_shape_writer_normalizes_the_real_ae_empty_outline_sentinel() -> None:
    source = PLUGIN_ENTRY.read_text(encoding="utf-8")
    writer = source.split("const auto write_path =", 1)[1].split(
        "const auto set_leaf =", 1
    )[0]

    assert "if (segments < -1 || segments > 128)" in writer
    assert "A_long vertices = segments <= 0 ? 0" in writer
    assert 'mutation_stage = "path-segment-bound"' in writer


def test_shape_readback_reports_the_exact_failed_sdk_stage() -> None:
    source = PLUGIN_ENTRY.read_text(encoding="utf-8")
    reader = source.split("std::string read_group_stage =", 1)[1].split(
        "const auto group_count =", 1
    )[0]

    assert 'read_group_stage = "path-data"' in reader
    assert 'read_group_stage = std::string(label) + "-value"' in reader
    assert 'read_group_stage = "fill-flags"' in reader
    assert 'read_group_stage = "stroke-index"' in reader
    assert "read_group_error =" in reader
    assert "read-authored-group/" in source


def test_shape_group_identity_uses_the_collision_checked_authored_name() -> None:
    source = PLUGIN_ENTRY.read_text(encoding="utf-8")
    reader = source.split("const auto read_group =", 1)[1].split(
        "const auto group_count =", 1
    )[0]

    assert 'read_group_stage = "group-identity-token"' in reader
    assert "stream_id = stable_group_token(*name)" in reader
    assert "stream_suite->AEGP_GetUniqueStreamID" not in reader

    stack = source.split("const auto read_group_stack =", 1)[1].split(
        "if (command.operation == aemcp::native::kShapeGroupsListCapability)",
        1,
    )[0]
    assert "std::unordered_map<std::int32_t, std::string> identities" in stack
    assert "identities.emplace(snapshot->stream_id, snapshot->name)" in stack

    create_preflight = source.split("const auto before_stack =", 1)[1].split(
        "const auto paths_equal =", 1
    )[0]
    assert "requested_token = stable_group_token(command.name)" in create_preflight
    assert "group.name == command.name || group.stream_id == requested_token" in (
        create_preflight
    )


def test_shape_path_readback_uses_only_the_observed_ae_quantum() -> None:
    source = PLUGIN_ENTRY.read_text(encoding="utf-8")
    comparator = source.split("const auto paths_equal =", 1)[1].split(
        "\n      if (command.operation ==", 1
    )[0]

    assert comparator.count("path_decimal_values_equal(") == 6
    assert "!decimal_values_equal(" not in comparator

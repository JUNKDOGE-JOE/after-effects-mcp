from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


REPO_ROOT = Path(__file__).resolve().parents[3]
PROTOCOL_ROOT = REPO_ROOT / "native" / "ae-plugin" / "protocol"
SCHEMA_PATH = PROTOCOL_ROOT / "aegp-rpc.schema.json"
FIXTURE_ROOT = PROTOCOL_ROOT / "fixtures"


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _jcs_subset(value) -> bytes:
    """Independent JCS encoder for the fixture's integer/string JSON subset."""

    def encode(item) -> str:
        if item is None:
            return "null"
        if item is True:
            return "true"
        if item is False:
            return "false"
        if isinstance(item, int):
            return str(item)
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if isinstance(item, list):
            return "[" + ",".join(encode(member) for member in item) + "]"
        if isinstance(item, dict):
            members = sorted(
                item.items(),
                key=lambda member: member[0].encode("utf-16-be"),
            )
            return "{" + ",".join(
                f"{encode(key)}:{encode(member)}" for key, member in members
            ) + "}"
        raise TypeError(f"unsupported independent JCS fixture value: {type(item)!r}")

    return encode(value).encode("utf-8")


def test_native_rpc_schema_and_golden_vectors_are_draft_2020_12_valid():
    schema = _json(SCHEMA_PATH)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)

    for name in (
        "hello.json",
        "capabilities.json",
        "invoke-project-summary.json",
        "cancel.json",
    ):
        fixture = _json(FIXTURE_ROOT / name)
        validator.validate(fixture["request"])
        for event in fixture.get("events", []):
            validator.validate(event)
        validator.validate(fixture["response"])

    for response in _json(FIXTURE_ROOT / "errors.json")["responses"].values():
        validator.validate(response)

    for vector in _json(FIXTURE_ROOT / "version-negotiation.json")["vectors"]:
        validator.validate(vector["request"])
        validator.validate(vector["response"])

    for name in (
        "hello.json",
        "capabilities.json",
        "invoke-project-summary.json",
        "cancel.json",
        "errors.json",
        "negative-corpus.json",
        "framing-corpus.json",
        "version-negotiation.json",
    ):
        fixture = _json(FIXTURE_ROOT / name)
        assert fixture["_fixture"] == {
            "classification": "synthetic-contract-vector",
            "runtimeEvidence": False,
            "compatibilityEvidence": False,
        }

    descriptor = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"][
        "items"
    ][0]
    assert descriptor["requirements"] == [
        {
            "id": "aemcp.requirement.native.project-read",
            "contractVersion": 1,
        }
    ]
    assert {example["kind"] for example in descriptor["examples"]} == {
        "positive",
        "negative",
    }
    assert all("arguments" in example and "expected" in example for example in descriptor["examples"])

    input_schema = descriptor["inputSchema"]
    result_schema = descriptor["resultSchema"]
    Draft202012Validator.check_schema(input_schema)
    Draft202012Validator.check_schema(result_schema)
    Draft202012Validator(input_schema).validate({})
    with pytest.raises(ValidationError):
        Draft202012Validator(input_schema).validate({"jsx": "forbidden"})
    Draft202012Validator(result_schema).validate(
        {"projectOpen": True, "projectName": "😀" * 1024, "itemCount": 1}
    )
    with pytest.raises(ValidationError):
        Draft202012Validator(result_schema).validate(
            {"projectOpen": True, "projectName": "😀" * 1025, "itemCount": 1}
        )

    contract = {"inputSchema": input_schema, "resultSchema": result_schema}
    assert hashlib.sha256(_jcs_subset(contract)).hexdigest() == descriptor[
        "contractDigest"
    ]
    capabilities = _json(FIXTURE_ROOT / "capabilities.json")
    hello = _json(FIXTURE_ROOT / "hello.json")
    # This vector deliberately filters the returned page to project.summary.
    # capabilitiesDigest binds the complete negotiated registry, not the
    # filtered items page, and therefore must match hello's registry digest.
    assert capabilities["request"]["params"] == {
        "ids": ["ae.project.summary"],
        "detail": "full",
        "limit": 1,
    }
    assert capabilities["response"]["result"]["capabilitiesDigest"] == hello[
        "response"
    ]["result"]["capabilitiesDigest"]
    assert capabilities["response"]["result"]["capabilitiesDigest"] == (
        "33afff4311c76b6671101c9f2a15d2bbfe328c43dd7b539c0825b24ffa416be8"
    )
    assert _jcs_subset({"\ue000": 1, "😀": 2}).decode("utf-8") == (
        '{"😀":2,"\ue000":1}'
    )


def test_folder_mutation_success_can_never_be_a_transport_replay():
    schema = _json(SCHEMA_PATH)
    validator = Draft202012Validator(schema)
    response = {
        "wireVersion": 1,
        "kind": "response",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "requestId": "folder-create-1",
        "method": "invoke",
        "ok": True,
        "replayed": False,
        "result": {
            "capabilityId": "ae.project.folder.create",
            "capabilityVersion": 1,
            "engine": "native-aegp",
            "outcome": "succeeded",
            "value": {
                "created": True,
                "folderItemId": 17,
                "folderName": "AI Folder",
                "parentItemId": 0,
                "itemCountBefore": 4,
                "itemCountAfter": 5,
            },
            "evidence": {
                "engine": "native-aegp",
                "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                "sessionId": "11111111-1111-4111-8111-111111111111",
                "requestId": "folder-create-1",
                "capabilityId": "ae.project.folder.create",
                "capabilityVersion": 1,
                "startedAtUnixMs": 1_900_000_000_000,
                "completedAtUnixMs": 1_900_000_000_025,
                "effect": "committed",
                "requestDigest": "a" * 64,
                "postcondition": {
                    "verified": True,
                    "kind": "project-folder-created",
                    "algorithm": "sha256-rfc8785-jcs-v1",
                    "digest": "b" * 64,
                },
                "undo": {"available": True, "verified": False},
            },
        },
    }
    validator.validate(response)
    response["replayed"] = True
    with pytest.raises(ValidationError):
        validator.validate(response)


def test_native_rpc_negative_corpus_is_rejected_by_the_public_envelope():
    schema = _json(SCHEMA_PATH)
    validator = Draft202012Validator(schema)
    for seed in _json(FIXTURE_ROOT / "negative-corpus.json")["vectors"]:
        with pytest.raises(ValidationError):
            validator.validate(seed["message"])

    capabilities = _json(FIXTURE_ROOT / "capabilities.json")["request"]
    capabilities["params"]["cursor"] = "pagination-is-fail-closed-in-v1"
    with pytest.raises(ValidationError):
        validator.validate(capabilities)

    capabilities = _json(FIXTURE_ROOT / "capabilities.json")
    replayed_capabilities = deepcopy(capabilities["response"])
    replayed_capabilities["replayed"] = True
    with pytest.raises(ValidationError):
        validator.validate(replayed_capabilities)

    replayed_cancel = deepcopy(_json(FIXTURE_ROOT / "cancel.json")["response"])
    replayed_cancel["replayed"] = True
    with pytest.raises(ValidationError):
        validator.validate(replayed_cancel)

    reversed_range = deepcopy(_json(FIXTURE_ROOT / "hello.json")["request"])
    reversed_range["params"]["supportedWireVersions"] = {
        "minimum": 2,
        "maximum": 1,
    }
    validator.validate(reversed_range)
    assert (
        schema["$defs"]["wireRange"]["x-invariant"]
        == "minimum-must-not-exceed-maximum"
    )


def test_native_rpc_error_policy_rejects_unsafe_retry_combinations():
    schema = _json(SCHEMA_PATH)
    valid = _json(FIXTURE_ROOT / "errors.json")["responses"][
        "possiblySideEffecting"
    ]["error"]

    # Resolve local refs by validating through the root response schema.
    response = _json(FIXTURE_ROOT / "errors.json")["responses"][
        "possiblySideEffecting"
    ]
    Draft202012Validator(schema).validate(response)

    unsafe = deepcopy(response)
    unsafe["error"]["retryable"] = True
    unsafe["error"]["sideEffect"] = "not-started"
    unsafe["error"]["recovery"]["action"] = "retry"
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(unsafe)

    delayed_non_queue = deepcopy(response)
    delayed_non_queue["error"]["recovery"]["retryAfterMs"] = 250
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(delayed_non_queue)

    queue_full = deepcopy(
        _json(FIXTURE_ROOT / "errors.json")["responses"]["queueFull"]
    )
    del queue_full["error"]["recovery"]["retryAfterMs"]
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(queue_full)

    assert valid["retryable"] is False

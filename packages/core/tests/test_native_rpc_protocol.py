"""Contract checks for the single native-program RPC surface."""

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
SYNTHETIC_FIXTURE = {
    "classification": "synthetic-contract-vector",
    "runtimeEvidence": False,
    "compatibilityEvidence": False,
}


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _jcs_subset(value) -> bytes:
    """Independent JCS encoder for the registry's JSON subset."""

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
        raise TypeError(f"unsupported independent JCS value: {type(item)!r}")

    return encode(value).encode("utf-8")


def _program_request(*, write: bool) -> dict:
    arguments = {
        "operations": [
            {
                "op": "project.items.list",
                "args": {"offset": 0, "limit": 1},
                "returnAs": "items",
            }
        ]
    }
    if write:
        arguments = {
            "operationKey": "native-program-protocol-0001",
            "undoGroup": "Native protocol write",
            "operations": [
                {
                    "op": "composition.time.set",
                    "args": {
                        "composition": {"ref": "composition"},
                        "targetTime": {"value": 1, "scale": 24},
                    },
                    "returnAs": "time",
                }
            ],
        }
    return {
        "wireVersion": 1,
        "kind": "request",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "requestId": f"native-program-{'write' if write else 'read'}",
        "method": "invoke",
        "params": {
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "arguments": arguments,
        },
    }


def _program_response(request: dict, *, write: bool) -> dict:
    request_id = request["requestId"]
    operation = request["params"]["arguments"]["operations"][0]
    result = {
        "capabilityId": "ae.native.exec",
        "outputs": {
            operation["returnAs"]: (
                {"value": 1, "scale": 24}
                if write
                else {"items": [], "nextOffset": None}
            )
        },
        "operations": [
            {"index": 0, "op": operation["op"], "status": "completed"}
        ],
        "evidence": {
            "engine": "native-aegp",
            "hostInstanceId": "22222222-2222-4222-8222-222222222222",
            "sessionId": request["sessionId"],
            "requestId": request_id,
            "capabilityId": "ae.native.exec",
            "capabilityVersion": 1,
            "startedAtUnixMs": 1_900_000_000_000,
            "completedAtUnixMs": 1_900_000_000_001,
            "effect": "committed" if write else "none",
            "postcondition": {
                "verified": True,
                "kind": "native-program",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": "a" * 64,
            },
            "requestDigest": "b" * 64,
        },
        "undo": (
            {
                "available": True,
                "verified": False,
                "groupLabel": "Native protocol write",
            }
            if write
            else {"available": False, "verified": False}
        ),
    }
    if write:
        result["operationKey"] = request["params"]["arguments"]["operationKey"]
    return {
        "wireVersion": 1,
        "kind": "response",
        "sessionId": request["sessionId"],
        "requestId": request_id,
        "method": "invoke",
        "ok": True,
        "replayed": False,
        "result": result,
    }


def test_native_rpc_schema_and_current_fixtures_are_draft_2020_12_valid():
    schema = _json(SCHEMA_PATH)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)

    for name in ("hello.json", "capabilities.json", "invalidate-graph.json"):
        fixture = _json(FIXTURE_ROOT / name)
        assert fixture["_fixture"] == SYNTHETIC_FIXTURE
        validator.validate(fixture["request"])
        validator.validate(fixture["response"])

    errors = _json(FIXTURE_ROOT / "errors.json")
    assert errors["_fixture"] == SYNTHETIC_FIXTURE
    for name in ("duplicateRequest", "queueFull", "wireVersionMismatch"):
        validator.validate(errors["responses"][name])

    versions = _json(FIXTURE_ROOT / "version-negotiation.json")
    assert versions["_fixture"] == SYNTHETIC_FIXTURE
    for vector in versions["vectors"]:
        validator.validate(vector["request"])
        validator.validate(vector["response"])


def test_registry_has_one_native_exec_descriptor_with_generated_primitives():
    registry = _json(FIXTURE_ROOT / "capability-registry-full.json")
    assert registry["_fixture"] == SYNTHETIC_FIXTURE
    assert len(registry["items"]) == 1

    descriptor = registry["items"][0]
    assert descriptor["id"] == "ae.native.exec"
    assert descriptor["requiredSkill"] == "builtin:skill:ae-execution-guide"
    assert descriptor["primitiveCount"] == len(descriptor["primitives"]) == 23
    primitive_ids = [primitive["id"] for primitive in descriptor["primitives"]]
    assert len(primitive_ids) == len(set(primitive_ids))

    Draft202012Validator.check_schema(descriptor["inputSchema"])
    Draft202012Validator.check_schema(descriptor["resultSchema"])
    contract = {
        "inputSchema": descriptor["inputSchema"],
        "primitives": descriptor["primitives"],
        "requiredSkill": descriptor["requiredSkill"],
        "resultSchema": descriptor["resultSchema"],
    }
    assert hashlib.sha256(_jcs_subset(contract)).hexdigest() == descriptor[
        "contractDigest"
    ]


def test_capabilities_advertises_only_the_native_exec_root():
    capabilities = _json(FIXTURE_ROOT / "capabilities.json")["response"]["result"]
    registry = _json(FIXTURE_ROOT / "capability-registry-full.json")
    hello = _json(FIXTURE_ROOT / "hello.json")["response"]["result"]

    assert [item["id"] for item in capabilities["items"]] == ["ae.native.exec"]
    assert capabilities["items"][0]["primitiveCount"] == 23
    assert capabilities["capabilitiesDigest"] == registry["capabilitiesDigest"]
    assert capabilities["capabilitiesDigest"] == hello["capabilitiesDigest"]


@pytest.mark.parametrize("write", [False, True])
def test_common_native_program_request_and_result_validate(write):
    validator = Draft202012Validator(_json(SCHEMA_PATH))
    request = _program_request(write=write)
    response = _program_response(request, write=write)

    validator.validate(request)
    validator.validate(response)

    legacy = deepcopy(request)
    legacy["params"]["capabilityId"] = "ae.project.summary"
    with pytest.raises(ValidationError):
        validator.validate(legacy)


def test_native_program_write_replay_remains_bound_to_the_operation_key():
    validator = Draft202012Validator(_json(SCHEMA_PATH))
    request = _program_request(write=True)
    response = _program_response(request, write=True)
    validator.validate(response)

    response["replayed"] = True
    validator.validate(response)
    assert response["result"]["operationKey"] == request["params"]["arguments"][
        "operationKey"
    ]


def test_native_rpc_error_policy_rejects_unsafe_retry_combinations():
    schema = _json(SCHEMA_PATH)
    response = _json(FIXTURE_ROOT / "errors.json")["responses"][
        "queueFull"
    ]
    Draft202012Validator(schema).validate(response)

    unsafe = deepcopy(response)
    unsafe["error"]["retryable"] = False
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(unsafe)

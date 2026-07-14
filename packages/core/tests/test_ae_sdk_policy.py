import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
POLICY_PATH = REPOSITORY_ROOT / "packaging" / "ae-sdk-inputs.json"
SCHEMA_PATH = REPOSITORY_ROOT / "packaging" / "schemas" / "ae-sdk-inputs.schema.json"


def test_ae_sdk_policy_satisfies_the_complete_draft_2020_12_schema() -> None:
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    assert list(validator.iter_errors(policy)) == []

    weakened = copy.deepcopy(policy)
    weakened["sdk"]["licenseReview"]["scopes"][
        "rawSdkMaterialInPublicRepository"
    ] = "allowed"
    assert list(validator.iter_errors(weakened))

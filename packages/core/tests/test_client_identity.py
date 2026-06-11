from ae_mcp import client_identity


def test_client_identity_formats_name_and_version():
    client_identity.set_client("Claude Desktop", "1.2")
    assert client_identity.get_client() == "Claude Desktop/1.2"


def test_client_identity_falls_back_to_unknown():
    client_identity.set_client("  ", None)
    assert client_identity.get_client() == "unknown"


def test_client_identity_truncates_long_labels():
    client_identity.set_client("x" * 200, "1.0")
    label = client_identity.get_client()
    assert len(label) == 120
    assert label == ("x" * 200 + "/1.0")[:120]

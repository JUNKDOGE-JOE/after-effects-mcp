def test_aebm_backend_imports():
    from ae_mcp_backend_aebm import AEBMBackend
    assert AEBMBackend.name == "aebm"
    assert hasattr(AEBMBackend, "exec")

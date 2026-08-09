"""Unit tests for the real generated-tool capability surface.

These tests never launch applications or modify the host. They verify the SDK's
permission gate and deterministic, invalid-input behavior; the Forge sandbox
uses its own non-destructive SDK shim for generated-tool integration tests.
"""
from nova_tool_sdk import ToolCapabilityError, _ok, require, system_info, file_read


def test_success_shape():
    assert _ok(value=1) == {"success": True, "value": 1}


def test_capability_gate():
    try:
        require("APP_LAUNCH", {"_nova_capabilities": ["SYSTEM_READ"]})
    except ToolCapabilityError:
        return
    raise AssertionError("capability gate did not reject an undeclared capability")


def test_empty_file_path_fails_without_side_effect():
    result = file_read("")
    assert result["success"] is False


def test_system_info_has_real_runtime_shape():
    result = system_info({"_nova_capabilities": ["SYSTEM_READ"]})
    assert result["success"] is True
    assert "system" in result
    assert "python" in result


if __name__ == "__main__":
    test_success_shape()
    test_capability_gate()
    test_empty_file_path_fails_without_side_effect()
    test_system_info_has_real_runtime_shape()
    print("ALL_TESTS_PASSED")

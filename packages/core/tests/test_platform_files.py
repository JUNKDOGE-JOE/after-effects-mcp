from __future__ import annotations

import ctypes
import os
import stat
import types
from pathlib import Path

import pytest

import ae_mcp.platform_files as platform_files
from ae_mcp.platform_files import (
    atomic_replace_bytes,
    atomic_replace_file,
    fsync_parent,
    private_temp_dir,
)


def test_private_temp_dir_is_private_and_removed_on_return(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    with private_temp_dir(prefix="tool-import-") as directory:
        assert directory.parent == tmp_path
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        (directory / "data").write_text("ok", encoding="utf-8")
        (directory / "nested").mkdir()
        (directory / "nested" / "data").write_text("ok", encoding="utf-8")
    assert not directory.exists()


def test_private_temp_dir_is_removed_after_exception(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    with pytest.raises(RuntimeError):
        with private_temp_dir(prefix="tool-import-") as directory:
            raise RuntimeError("boom")
    assert not directory.exists()


def test_private_temp_dir_cleanup_never_follows_a_replaced_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    victim = tmp_path / "victim"
    victim.mkdir()
    marker = victim / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    with private_temp_dir(prefix="tool-import-") as directory:
        directory.rmdir()
        directory.symlink_to(victim, target_is_directory=True)
    assert marker.read_text(encoding="utf-8") == "keep"
    assert not directory.exists()


def test_private_temp_dir_cleanup_uses_an_open_directory_when_root_is_raced_to_a_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    victim = tmp_path / "victim-race"
    victim.mkdir()
    marker = victim / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    real_scandir = os.scandir
    state: dict[str, object] = {"root": None, "raced": False}

    def race_before_scandir(path: object):
        root = state["root"]
        if root is not None and not state["raced"]:
            state["raced"] = True
            root_path = Path(root)
            root_path.rmdir()
            root_path.symlink_to(victim, target_is_directory=True)
        return real_scandir(path)

    monkeypatch.setattr(os, "scandir", race_before_scandir)
    cleanup_error: Exception | None = None
    try:
        with private_temp_dir(prefix="tool-import-") as directory:
            state["root"] = directory
    except Exception as error:  # the old implementation raises after deleting the victim
        cleanup_error = error

    assert state["raced"] is True
    assert marker.read_text(encoding="utf-8") == "keep"
    assert cleanup_error is None
    assert not directory.exists()


def test_windows_cleanup_opens_reparse_points_and_never_scans_their_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    victim = tmp_path / "windows-victim"
    victim.mkdir()
    marker = victim / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    root = tmp_path / "windows-root"
    root.mkdir()
    observed_flags: list[int] = []

    class FakeHandle:
        def __init__(self, path: str) -> None:
            self.path = Path(path)

        def Close(self) -> None:  # noqa: N802 - mirrors PyHANDLE
            pass

    class FakeWin32Con:
        FILE_SHARE_READ = 0x1
        FILE_SHARE_WRITE = 0x2
        FILE_WRITE_ATTRIBUTES = 0x100
        OPEN_EXISTING = 3
        FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
        FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
        FILE_ATTRIBUTE_READONLY = 0x1
        FILE_ATTRIBUTE_NORMAL = 0x80
        FILE_ATTRIBUTE_DIRECTORY = 0x10
        FILE_ATTRIBUTE_REPARSE_POINT = 0x400

    class FakeWin32File:
        raced = False

        @classmethod
        def CreateFile(  # noqa: N802 - mirrors pywin32
            cls, path: str, _access: int, _share: int, _security: object,
            _creation: int, flags: int, _template: object,
        ) -> FakeHandle:
            observed_flags.append(flags)
            candidate = Path(path)
            if candidate == root and not cls.raced:
                cls.raced = True
                root.rmdir()
                root.symlink_to(victim, target_is_directory=True)
            return FakeHandle(path)

        @staticmethod
        def GetFileInformationByHandle(handle: FakeHandle) -> tuple[int]:  # noqa: N802
            info = os.lstat(handle.path)
            attributes = 0
            if stat.S_ISLNK(info.st_mode):
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_REPARSE_POINT
                if handle.path.is_dir():
                    attributes |= FakeWin32Con.FILE_ATTRIBUTE_DIRECTORY
            elif stat.S_ISDIR(info.st_mode):
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_DIRECTORY
            return (attributes,)

        @staticmethod
        def RemoveDirectory(path: str) -> None:  # noqa: N802
            candidate = Path(path)
            if candidate.is_symlink():
                candidate.unlink()
            else:
                candidate.rmdir()

        @staticmethod
        def DeleteFile(path: str) -> None:  # noqa: N802
            Path(path).unlink()

    monkeypatch.setattr(os, "scandir", lambda _path: (_ for _ in ()).throw(AssertionError("reparse target was scanned")))
    platform_files._remove_windows_tree_without_following_links(  # noqa: SLF001
        root,
        win32file_module=FakeWin32File,
        win32con_module=FakeWin32Con,
    )

    assert observed_flags
    assert observed_flags[0] & FakeWin32Con.FILE_FLAG_OPEN_REPARSE_POINT
    assert marker.read_text(encoding="utf-8") == "keep"
    assert not root.exists()


def test_windows_cleanup_clears_readonly_on_verified_regular_files(
    tmp_path: Path,
) -> None:
    root = tmp_path / "windows-readonly-root"
    root.mkdir()
    payload = root / "payload.bin"
    payload.write_bytes(b"payload")
    readonly_paths = {payload}
    observed_flags: list[int] = []
    observed_access: list[int] = []
    attribute_updates: list[tuple[Path, int]] = []

    class AccessDenied(OSError):
        winerror = 5

    class FakeHandle:
        def __init__(self, path: str) -> None:
            self.path = Path(path)

        def Close(self) -> None:  # noqa: N802 - mirrors PyHANDLE
            pass

    class FakeWin32Con:
        FILE_SHARE_READ = 0x1
        FILE_SHARE_WRITE = 0x2
        FILE_WRITE_ATTRIBUTES = 0x100
        OPEN_EXISTING = 3
        FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
        FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
        FILE_ATTRIBUTE_READONLY = 0x1
        FILE_ATTRIBUTE_NORMAL = 0x80
        FILE_ATTRIBUTE_DIRECTORY = 0x10
        FILE_ATTRIBUTE_REPARSE_POINT = 0x400

    class FakeWin32File:
        FileBasicInfo = 0

        @staticmethod
        def CreateFile(  # noqa: N802 - mirrors pywin32
            path: str, access: int, _share: int, _security: object,
            _creation: int, flags: int, _template: object,
        ) -> FakeHandle:
            observed_access.append(access)
            observed_flags.append(flags)
            return FakeHandle(path)

        @staticmethod
        def GetFileInformationByHandle(handle: FakeHandle) -> tuple[int]:  # noqa: N802
            attributes = FakeWin32Con.FILE_ATTRIBUTE_DIRECTORY if handle.path.is_dir() else 0
            if handle.path in readonly_paths:
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_READONLY
            return (attributes,)

        @staticmethod
        def GetFileInformationByHandleEx(handle: FakeHandle, info_class: int) -> dict[str, int]:  # noqa: N802
            assert info_class == FakeWin32File.FileBasicInfo
            attributes = FakeWin32Con.FILE_ATTRIBUTE_READONLY if handle.path in readonly_paths else 0
            return {
                "CreationTime": 1, "LastAccessTime": 2, "LastWriteTime": 3,
                "ChangeTime": 4, "FileAttributes": attributes,
            }

        @staticmethod
        def SetFileInformationByHandle(  # noqa: N802
            handle: FakeHandle, info_class: int, info: dict[str, int]
        ) -> None:
            assert info_class == FakeWin32File.FileBasicInfo
            attributes = info["FileAttributes"]
            attribute_updates.append((handle.path, attributes))
            if not attributes & FakeWin32Con.FILE_ATTRIBUTE_READONLY:
                readonly_paths.discard(handle.path)

        @staticmethod
        def RemoveDirectory(path: str) -> None:  # noqa: N802
            Path(path).rmdir()

        @staticmethod
        def DeleteFile(path: str) -> None:  # noqa: N802
            candidate = Path(path)
            if candidate in readonly_paths:
                raise AccessDenied("readonly")
            candidate.unlink()

    platform_files._remove_windows_tree_without_following_links(  # noqa: SLF001
        root,
        win32file_module=FakeWin32File,
        win32con_module=FakeWin32Con,
    )

    assert observed_flags
    assert observed_access and all(
        access & FakeWin32Con.FILE_WRITE_ATTRIBUTES for access in observed_access
    )
    assert all(flag & FakeWin32Con.FILE_FLAG_OPEN_REPARSE_POINT for flag in observed_flags)
    assert attribute_updates == [(payload, FakeWin32Con.FILE_ATTRIBUTE_NORMAL)]
    assert not root.exists()


def test_windows_cleanup_clears_readonly_file_reparse_by_handle_without_touching_target(
    tmp_path: Path,
) -> None:
    root = tmp_path / "windows-link-root"
    root.mkdir()
    target = tmp_path / "target.bin"
    target.write_bytes(b"keep")
    link = root / "payload-link"
    link.symlink_to(target)
    readonly_entries = {link}
    updated_handles: list[Path] = []

    class AccessDenied(OSError):
        winerror = 5

    class FakeHandle:
        def __init__(self, path: str) -> None:
            self.path = Path(path)

        def Close(self) -> None:  # noqa: N802
            pass

    class FakeWin32Con:
        FILE_SHARE_READ = 0x1
        FILE_SHARE_WRITE = 0x2
        FILE_WRITE_ATTRIBUTES = 0x100
        OPEN_EXISTING = 3
        FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
        FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
        FILE_ATTRIBUTE_READONLY = 0x1
        FILE_ATTRIBUTE_NORMAL = 0x80
        FILE_ATTRIBUTE_DIRECTORY = 0x10
        FILE_ATTRIBUTE_REPARSE_POINT = 0x400

    class FakeWin32File:
        FileBasicInfo = 0

        @staticmethod
        def CreateFile(  # noqa: N802
            path: str, access: int, _share: int, _security: object,
            _creation: int, flags: int, _template: object,
        ) -> FakeHandle:
            assert access & FakeWin32Con.FILE_WRITE_ATTRIBUTES
            assert flags & FakeWin32Con.FILE_FLAG_OPEN_REPARSE_POINT
            return FakeHandle(path)

        @staticmethod
        def GetFileInformationByHandle(handle: FakeHandle) -> tuple[int]:  # noqa: N802
            attributes = 0
            if handle.path.is_dir() and not handle.path.is_symlink():
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_DIRECTORY
            if handle.path.is_symlink():
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_REPARSE_POINT
            if handle.path in readonly_entries:
                attributes |= FakeWin32Con.FILE_ATTRIBUTE_READONLY
            return (attributes,)

        @staticmethod
        def GetFileInformationByHandleEx(handle: FakeHandle, info_class: int) -> dict[str, int]:  # noqa: N802
            assert info_class == FakeWin32File.FileBasicInfo
            return {
                "CreationTime": 1, "LastAccessTime": 2, "LastWriteTime": 3,
                "ChangeTime": 4,
                "FileAttributes": (
                    FakeWin32Con.FILE_ATTRIBUTE_READONLY
                    | FakeWin32Con.FILE_ATTRIBUTE_REPARSE_POINT
                ),
            }

        @staticmethod
        def SetFileInformationByHandle(  # noqa: N802
            handle: FakeHandle, info_class: int, info: dict[str, int]
        ) -> None:
            assert info_class == FakeWin32File.FileBasicInfo
            assert info["FileAttributes"] == FakeWin32Con.FILE_ATTRIBUTE_REPARSE_POINT
            updated_handles.append(handle.path)
            readonly_entries.discard(handle.path)

        @staticmethod
        def RemoveDirectory(path: str) -> None:  # noqa: N802
            Path(path).rmdir()

        @staticmethod
        def DeleteFile(path: str) -> None:  # noqa: N802
            candidate = Path(path)
            if candidate in readonly_entries:
                raise AccessDenied("readonly reparse")
            candidate.unlink()

    platform_files._remove_windows_tree_without_following_links(  # noqa: SLF001
        root,
        win32file_module=FakeWin32File,
        win32con_module=FakeWin32Con,
    )

    assert updated_handles == [link]
    assert target.read_bytes() == b"keep"
    assert not link.exists()
    assert not root.exists()


@pytest.mark.parametrize("prefix", ["bad/name", "bad\\name", "x" * 49, "界" * 17])
def test_private_temp_dir_rejects_unsafe_prefixes(prefix: str) -> None:
    with pytest.raises(ValueError):
        with private_temp_dir(prefix=prefix):
            pass


def test_atomic_replace_bytes_uses_a_sibling_and_preserves_old_file_on_replace_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "state.bin"
    destination.write_bytes(b"old")
    observed: list[Path] = []

    def fail_replace(source: str | bytes | os.PathLike[str] | os.PathLike[bytes], target: object) -> None:
        observed.append(Path(source))
        raise OSError("replace failed")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError, match="replace failed"):
        atomic_replace_bytes(destination, b"new")

    assert destination.read_bytes() == b"old"
    assert observed and observed[0].parent == destination.parent
    assert not observed[0].exists()


def test_atomic_replace_bytes_flushes_before_replacement_and_applies_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "state.bin"
    events: list[str] = []
    real_fsync = os.fsync
    real_replace = os.replace

    def record_fsync(fd: int) -> None:
        events.append("fsync")
        real_fsync(fd)

    def record_replace(source: object, target: object) -> None:
        events.append("replace")
        real_replace(source, target)

    monkeypatch.setattr(os, "fsync", record_fsync)
    monkeypatch.setattr(os, "replace", record_replace)
    atomic_replace_bytes(destination, b"new", mode=0o640)

    assert destination.read_bytes() == b"new"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o640
    assert events.index("fsync") < events.index("replace")


def test_atomic_replace_bytes_preserves_old_file_on_write_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    destination = tmp_path / "state.bin"
    destination.write_bytes(b"old")
    monkeypatch.setattr(os, "write", lambda _fd, _data: (_ for _ in ()).throw(OSError("write failed")))
    with pytest.raises(OSError, match="write failed"):
        atomic_replace_bytes(destination, b"new")
    assert destination.read_bytes() == b"old"
    assert list(tmp_path.iterdir()) == [destination]


def test_atomic_replace_file_copies_cross_volume_style_source_into_a_sibling(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    destination_root = tmp_path / "destination"
    source_root.mkdir()
    destination_root.mkdir()
    source = source_root / "payload"
    source.write_bytes(b"payload")
    destination = destination_root / "installed"

    atomic_replace_file(source, destination, mode=0o600)

    assert source.read_bytes() == b"payload"
    assert destination.read_bytes() == b"payload"
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert list(destination_root.iterdir()) == [destination]


def test_atomic_replace_file_opens_source_and_destination_in_binary_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(b"\x00\r\n\x1a\xff")
    destination = tmp_path / "destination.bin"
    binary_flag = 0x8000
    observed: list[tuple[Path, int]] = []
    real_open = os.open

    def record_open(path: object, flags: int, *args: object) -> int:
        observed.append((Path(path), flags))
        return real_open(path, flags & ~binary_flag, *args)

    monkeypatch.setattr(os, "O_BINARY", binary_flag, raising=False)
    monkeypatch.setattr(os, "open", record_open)
    atomic_replace_file(source, destination)

    source_flags = next(flags for path, flags in observed if path == source)
    destination_flags = next(
        flags for path, flags in observed if path.parent == tmp_path and ".destination.bin.tmp-" in path.name
    )
    assert source_flags & binary_flag
    assert destination_flags & binary_flag
    assert destination.read_bytes() == b"\x00\r\n\x1a\xff"


@pytest.mark.skipif(os.name != "nt", reason="Windows binary descriptor semantics")
@pytest.mark.parametrize("payload", [b"\r\n", b"\x1a", b"\x00\xff\r\n\x1a"])
def test_windows_atomic_replace_file_preserves_binary_byte_matrix(
    tmp_path: Path, payload: bytes
) -> None:
    source = tmp_path / "source.bin"
    source.write_bytes(payload)
    destination = tmp_path / "destination.bin"
    atomic_replace_file(source, destination)
    assert destination.read_bytes() == payload


def test_atomic_replace_file_rejects_a_symlink_source(tmp_path: Path) -> None:
    payload = tmp_path / "payload"
    payload.write_bytes(b"secret")
    link = tmp_path / "payload-link"
    link.symlink_to(payload)
    with pytest.raises(ValueError, match="regular file"):
        atomic_replace_file(link, tmp_path / "installed")


def test_atomic_replace_file_preserves_old_file_on_fsync_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"new")
    destination = tmp_path / "installed"
    destination.write_bytes(b"old")
    monkeypatch.setattr(os, "fsync", lambda _fd: (_ for _ in ()).throw(OSError("fsync failed")))
    with pytest.raises(OSError, match="fsync failed"):
        atomic_replace_file(source, destination)
    assert destination.read_bytes() == b"old"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["installed", "source"]


def test_windows_atomic_replace_requests_replace_existing_and_write_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, int]] = []

    class FakeMoveFileEx:
        argtypes: object = None
        restype: object = None

        def __call__(self, source: str, destination: str, flags: int) -> int:
            calls.append((source, destination, flags))
            return 1

    move_file_ex = FakeMoveFileEx()
    source = Path("source.tmp")
    destination = Path("destination.bin")
    with monkeypatch.context() as patch:
        patch.setattr(platform_files.os, "name", "nt")
        patch.setattr(
            ctypes,
            "windll",
            types.SimpleNamespace(kernel32=types.SimpleNamespace(MoveFileExW=move_file_ex)),
            raising=False,
        )
        platform_files._replace_write_through(source, destination)  # noqa: SLF001

    assert calls == [("source.tmp", "destination.bin", 0x1 | 0x8)]


@pytest.mark.skipif(os.name != "nt", reason="Windows DACL contract")
def test_private_temp_dir_windows_dacl_has_one_current_user_full_control_ace() -> None:
    import ntsecuritycon  # type: ignore[import-not-found]
    import win32api  # type: ignore[import-not-found]
    import win32con  # type: ignore[import-not-found]
    import win32security  # type: ignore[import-not-found]

    with private_temp_dir(prefix="tool-import-") as directory:
        (directory / "nested").mkdir()
        (directory / "nested" / "payload.bin").write_bytes(b"payload")
        descriptor = win32security.GetNamedSecurityInfo(
            str(directory), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION
        )
        control, _revision = descriptor.GetSecurityDescriptorControl()
        assert control & win32security.SE_DACL_PROTECTED
        dacl = descriptor.GetSecurityDescriptorDacl()
        assert dacl.GetAceCount() == 1
        ace = dacl.GetAce(0)
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        assert win32security.EqualSid(ace[2], sid)
        assert (ace[1] & ntsecuritycon.FILE_ALL_ACCESS) == ntsecuritycon.FILE_ALL_ACCESS


def test_fsync_parent_opens_the_directory_where_supported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[object] = []
    real_open = os.open

    def record_open(path: object, flags: int, *args: object) -> int:
        opened.append(path)
        return real_open(path, flags, *args)

    monkeypatch.setattr(os, "open", record_open)
    fsync_parent(tmp_path)
    assert Path(opened[0]) == tmp_path

"""Private temporary and crash-safe atomic filesystem operations.

This module is deliberately small: it is the only temporary/atomic persistence
boundary consumed by higher-level import workflows.  Temporary objects are
always created beside their destination before a replace.
"""

from __future__ import annotations

import contextlib
import errno
import os
import secrets
import stat
import tempfile
from collections.abc import Iterator
from pathlib import Path


_MAX_PREFIX_BYTES = 48
_MAX_REMOVE_RETRIES = 128


def _validate_prefix(prefix: str) -> None:
    if not isinstance(prefix, str) or not prefix:
        raise ValueError("prefix must be a non-empty string")
    if "/" in prefix or "\\" in prefix or "\x00" in prefix:
        raise ValueError("prefix must not contain path separators")
    if len(prefix.encode("utf-8")) > _MAX_PREFIX_BYTES:
        raise ValueError(f"prefix must be at most {_MAX_PREFIX_BYTES} UTF-8 bytes")


def _same_file(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _posix_directory_flags() -> int:
    return os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)


def _remove_posix_child(parent_fd: int, name: str) -> None:
    for _ in range(_MAX_REMOVE_RETRIES):
        try:
            before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
            try:
                os.unlink(name, dir_fd=parent_fd)
                return
            except FileNotFoundError:
                return
            except IsADirectoryError:
                continue

        try:
            child_fd = os.open(name, _posix_directory_flags(), dir_fd=parent_fd)
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                continue
            raise
        try:
            opened = os.fstat(child_fd)
            if not _same_file(before, opened) or not stat.S_ISDIR(opened.st_mode):
                continue
            _empty_posix_directory_fd(child_fd)
        finally:
            os.close(child_fd)

        try:
            current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not _same_file(opened, current) or not stat.S_ISDIR(current.st_mode):
            continue
        try:
            os.rmdir(name, dir_fd=parent_fd)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in {errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR}:
                continue
            raise
    raise OSError(f"directory entry kept changing during secure cleanup: {name}")


def _empty_posix_directory_fd(directory_fd: int) -> None:
    for _ in range(_MAX_REMOVE_RETRIES):
        names = [entry.name for entry in os.scandir(directory_fd)]
        if not names:
            return
        for name in names:
            _remove_posix_child(directory_fd, name)
    raise OSError("directory contents kept changing during secure cleanup")


def _remove_posix_tree_without_following_links(root: Path) -> None:
    for _ in range(_MAX_REMOVE_RETRIES):
        try:
            before = os.lstat(root)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
            try:
                root.unlink(missing_ok=True)
                return
            except IsADirectoryError:
                continue

        try:
            root_fd = os.open(root, _posix_directory_flags())
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in {errno.ELOOP, errno.ENOTDIR}:
                continue
            raise
        try:
            opened = os.fstat(root_fd)
            if not _same_file(before, opened) or not stat.S_ISDIR(opened.st_mode):
                continue
            _empty_posix_directory_fd(root_fd)
        finally:
            os.close(root_fd)

        try:
            current = os.lstat(root)
        except FileNotFoundError:
            return
        if not _same_file(opened, current) or not stat.S_ISDIR(current.st_mode):
            continue
        try:
            root.rmdir()
            return
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in {errno.ENOTEMPTY, errno.EEXIST, errno.ENOTDIR}:
                continue
            raise
    raise OSError(f"temporary root kept changing during secure cleanup: {root}")


def _windows_error_code(error: BaseException) -> int | None:
    return getattr(error, "winerror", None) or getattr(error, "errno", None)


def _windows_sids_equal(win32security: object, left: object, right: object) -> bool:
    equal_sid = getattr(win32security, "EqualSid", None)
    if callable(equal_sid):
        return bool(equal_sid(left, right))
    convert = getattr(win32security, "ConvertSidToStringSid")
    return str(convert(left)) == str(convert(right))


def _remove_windows_tree_without_following_links(
    root: Path,
    *,
    win32file_module: object | None = None,
    win32con_module: object | None = None,
) -> None:
    """Remove a Windows tree by binding traversal and deletion to opened handles."""
    if win32file_module is None:
        import win32file as win32file_module  # type: ignore[import-not-found,no-redef]
    if win32con_module is None:
        import win32con as win32con_module  # type: ignore[import-not-found,no-redef]

    win32file = win32file_module
    win32con = win32con_module
    missing_codes = {2, 3}
    retry_codes = {5, 32, 145, 267}
    write_attributes = getattr(win32con, "FILE_WRITE_ATTRIBUTES", 0x00000100)
    delete_access = getattr(win32con, "DELETE", 0x00010000)
    share_delete = getattr(win32con, "FILE_SHARE_DELETE", 0x00000004)
    open_reparse_point = getattr(
        win32con, "FILE_FLAG_OPEN_REPARSE_POINT", 0x00200000
    )
    disposition_info = getattr(win32file, "FileDispositionInfo", 4)

    class _WindowsPathChanged(OSError):
        pass

    def final_path(handle: object) -> str:
        value = str(win32file.GetFinalPathNameByHandle(handle, 0))
        if value.startswith("\\\\?\\UNC\\"):
            value = "\\\\" + value[8:]
        elif value.startswith("\\\\?\\"):
            value = value[4:]
        return os.path.normcase(os.path.normpath(value))

    def remove_entry(path: Path, *, expected_path: str | None = None) -> None:
        last_error: BaseException | None = None
        for _ in range(_MAX_REMOVE_RETRIES):
            try:
                handle = win32file.CreateFile(
                    str(path),
                    write_attributes | delete_access,
                    win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | share_delete,
                    None,
                    win32con.OPEN_EXISTING,
                    win32con.FILE_FLAG_BACKUP_SEMANTICS | open_reparse_point,
                    None,
                )
            except Exception as error:
                if _windows_error_code(error) in missing_codes:
                    return
                raise

            marked_for_delete = False
            try:
                opened_path = final_path(handle)
                if expected_path is not None and opened_path != expected_path:
                    raise _WindowsPathChanged(f"Windows path changed during cleanup: {path}")
                attributes = win32file.GetFileInformationByHandle(handle)[0]
                is_directory = bool(attributes & win32con.FILE_ATTRIBUTE_DIRECTORY)
                is_reparse = bool(attributes & win32con.FILE_ATTRIBUTE_REPARSE_POINT)
                is_readonly = bool(attributes & win32con.FILE_ATTRIBUTE_READONLY)
                if is_directory and not is_reparse:
                    restart = False
                    for _scan_attempt in range(_MAX_REMOVE_RETRIES):
                        entries = list(os.scandir(path))
                        if not entries:
                            break
                        try:
                            for entry in entries:
                                child_path = os.path.normcase(os.path.normpath(
                                    os.path.join(opened_path, entry.name)
                                ))
                                remove_entry(path / entry.name, expected_path=child_path)
                        except _WindowsPathChanged:
                            restart = True
                            break
                    else:
                        raise OSError(f"directory contents kept changing during secure cleanup: {path}")
                    if restart:
                        continue
                elif not is_directory and is_readonly:
                    basic_info = dict(
                        win32file.GetFileInformationByHandleEx(handle, win32file.FileBasicInfo)
                    )
                    remaining = int(basic_info["FileAttributes"]) & ~win32con.FILE_ATTRIBUTE_READONLY
                    basic_info["FileAttributes"] = remaining or win32con.FILE_ATTRIBUTE_NORMAL
                    win32file.SetFileInformationByHandle(
                        handle, win32file.FileBasicInfo, basic_info
                    )
                try:
                    win32file.SetFileInformationByHandle(handle, disposition_info, True)
                    marked_for_delete = True
                except Exception as error:
                    code = _windows_error_code(error)
                    if code in missing_codes:
                        return
                    if code in retry_codes:
                        last_error = error
                        continue
                    raise
            finally:
                handle.Close()

            if marked_for_delete and not os.path.lexists(path):
                return
            last_error = OSError(f"Windows path was replaced during cleanup: {path}")
        if last_error is not None:
            raise last_error
        raise OSError(f"Windows path kept changing during secure cleanup: {root}")

    remove_entry(Path(root))


def _remove_tree_without_following_links(root: Path) -> None:
    if os.name == "nt":
        _remove_windows_tree_without_following_links(root)
    else:
        _remove_posix_tree_without_following_links(root)


def _windows_private_mkdir(path: Path) -> None:
    """Create *path* with a protected DACL granting only this user full access."""
    import win32api  # type: ignore[import-not-found]
    import win32con  # type: ignore[import-not-found]
    import win32file  # type: ignore[import-not-found]
    import win32security  # type: ignore[import-not-found]
    import ntsecuritycon  # type: ignore[import-not-found]

    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    sid_text = win32security.ConvertSidToStringSid(sid)
    descriptor = win32security.ConvertStringSecurityDescriptorToSecurityDescriptor(
        f"D:P(A;;FA;;;{sid_text})", win32security.SDDL_REVISION_1
    )
    attributes = win32security.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = descriptor
    win32file.CreateDirectoryW(str(path), attributes)

    actual = win32security.GetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION,
    )
    control, _revision = actual.GetSecurityDescriptorControl()
    if not (control & win32security.SE_DACL_PROTECTED):
        raise PermissionError("private temporary directory DACL is not protected")
    actual_dacl = actual.GetSecurityDescriptorDacl()
    if actual_dacl is None or actual_dacl.GetAceCount() != 1:
        raise PermissionError("private temporary directory DACL is not exclusive")
    ace = actual_dacl.GetAce(0)
    if not _windows_sids_equal(win32security, ace[2], sid) or (
        ace[1] & ntsecuritycon.FILE_ALL_ACCESS
    ) != ntsecuritycon.FILE_ALL_ACCESS:
        raise PermissionError("private temporary directory DACL does not grant the current user full control")


@contextlib.contextmanager
def private_temp_dir(*, prefix: str) -> Iterator[Path]:
    """Yield a newly-created private temporary directory and always remove it."""
    _validate_prefix(prefix)
    if os.name == "nt":
        parent = Path(tempfile.gettempdir())
        for _ in range(128):
            directory = parent / f"{prefix}{secrets.token_hex(12)}"
            try:
                _windows_private_mkdir(directory)
                break
            except Exception as error:
                if directory.exists() or directory.is_symlink():
                    _remove_tree_without_following_links(directory)
                if isinstance(error, FileExistsError) or getattr(error, "winerror", None) == 183:
                    continue
                raise
        else:
            raise FileExistsError("unable to allocate a private temporary directory")
    else:
        directory = Path(tempfile.mkdtemp(prefix=prefix))
        if stat.S_IMODE(directory.stat().st_mode) != 0o700:
            _remove_tree_without_following_links(directory)
            raise PermissionError("private temporary directory mode is not 0700")
    try:
        yield directory
    finally:
        _remove_tree_without_following_links(directory)


def fsync_parent(directory: Path) -> None:
    """Flush a directory entry update where directory handles are supported."""
    if os.name == "nt":
        return
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    fd = os.open(directory, flags)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _replace_write_through(source: Path, destination: Path) -> None:
    if os.name != "nt":
        os.replace(source, destination)
        return
    import ctypes
    from ctypes import wintypes

    move_file_ex = ctypes.windll.kernel32.MoveFileExW
    move_file_ex.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
    move_file_ex.restype = wintypes.BOOL
    replace_existing = 0x1
    write_through = 0x8
    if not move_file_ex(str(source), str(destination), replace_existing | write_through):
        raise ctypes.WinError()


def _exclusive_sibling(destination: Path, mode: int) -> tuple[Path, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(128):
        candidate = destination.parent / f".{destination.name}.tmp-{secrets.token_hex(12)}"
        try:
            fd = os.open(
                candidate,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                mode,
            )
            return candidate, fd
        except FileExistsError:
            continue
    raise FileExistsError("unable to allocate an exclusive sibling temporary file")


def _flush_sibling(fd: int, *, mode: int) -> None:
    if os.name != "nt":
        os.fchmod(fd, mode)
    os.fsync(fd)


def atomic_replace_bytes(destination: Path, data: bytes, *, mode: int = 0o600) -> None:
    """Atomically replace *destination* with bytes flushed from a sibling file."""
    destination = Path(destination)
    temporary, fd = _exclusive_sibling(destination, mode)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write while staging atomic replacement")
            view = view[written:]
        _flush_sibling(fd, mode=mode)
        os.close(fd)
        fd = -1
        _replace_write_through(temporary, destination)
        fsync_parent(destination.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def atomic_replace_file(source: Path, destination: Path, *, mode: int | None = None) -> None:
    """Copy *source* into a sibling and atomically replace *destination*."""
    source = Path(source)
    destination = Path(destination)
    source_info = source.stat(follow_symlinks=False)
    if not stat.S_ISREG(source_info.st_mode):
        raise ValueError("source must be a regular file")
    source_mode = stat.S_IMODE(source_info.st_mode)
    install_mode = source_mode if mode is None else mode
    temporary, destination_fd = _exclusive_sibling(destination, install_mode)
    source_fd = -1
    try:
        source_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        source_fd = os.open(source, source_flags)
        opened_info = os.fstat(source_fd)
        if (
            not stat.S_ISREG(opened_info.st_mode)
            or (opened_info.st_dev, opened_info.st_ino) != (source_info.st_dev, source_info.st_ino)
        ):
            raise ValueError("source must remain the same regular file while it is copied")
        while True:
            chunk = os.read(source_fd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                if written <= 0:
                    raise OSError("short write while staging atomic replacement")
                view = view[written:]
        _flush_sibling(destination_fd, mode=install_mode)
        os.close(destination_fd)
        destination_fd = -1
        _replace_write_through(temporary, destination)
        fsync_parent(destination.parent)
    finally:
        if source_fd >= 0:
            os.close(source_fd)
        if destination_fd >= 0:
            os.close(destination_fd)
        temporary.unlink(missing_ok=True)

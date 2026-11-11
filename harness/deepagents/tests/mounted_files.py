from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from botcube_harness_deepagents.files_mount import FilesMount


def binding() -> dict[str, str]:
    return {
        'fileSystemId': 'fs-00000000000000001', 'accessPointId': 'fsap-00000000000000001',
        'mountTargetIp': '192.0.2.12', 'region': 'us-east-1', 'accessKeyId': 'key',
        'secretAccessKey': 'secret', 'sessionToken': 'token', 'expiration': '2099-01-01T00:00:00Z',
    }


class MountedFiles:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def mount(self, mount: FilesMount, root: Path, excluded: Any = ()) -> None:
        assert root.resolve() == self.root.resolve()

    def write(self, name: str, body: bytes) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    def read(self, name: str) -> bytes:
        return (self.root / name).read_bytes()


@dataclass(frozen=True)
class AccountFiles(FilesMount):
    """The account's one Files tree, which every chat of the account mounts at its own workspace."""

    account: Path = Path()

    @classmethod
    def at(cls, account: Path) -> AccountFiles:
        account.mkdir(parents=True, exist_ok=True)
        mount = FilesMount.from_binding(binding())
        return cls(mount.file_system_id, mount.access_point_id, mount.mount_target_ip, mount.region,
                   mount.credentials, account)

    def pull(self, root: Path, excluded: Iterable[str] = ()) -> None:
        if not root.exists():
            root.symlink_to(self.account, target_is_directory=True)

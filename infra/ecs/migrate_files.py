from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import boto3


def inventory(client: Any, bucket: str) -> dict[str, tuple[int, str]]:
    found = {}
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='accounts/'):
        for item in page.get('Contents', []):
            key = item['Key']
            parts = Path(key).parts
            if key != 'accounts/' and (len(parts) < 2 or not re.fullmatch('[0-9a-f]{32}', parts[1]) or '..' in parts or (len(parts) == 2 and not key.endswith('/'))):
                raise ValueError('Source object is outside an account directory')
            found[key] = (item['Size'], item['ETag'])
    return found


def digest(file: Path) -> str:
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def copy_object(client: Any, bucket: str, key: str, expected: tuple[int, str], destination: Path) -> tuple[int, str]:
    target = destination / key.removeprefix('accounts/')
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.resolve().is_relative_to(destination.resolve()) or target.is_symlink():
        raise ValueError('Migration destination escapes its account directory')
    if key.endswith('/'):
        return copy_directory_marker(client, bucket, key, expected, target)
    response = client.get_object(Bucket=bucket, Key=key, IfMatch=expected[1])
    body = response['Body']
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
                size = temporary.stat().st_size
                checksum = digest(temporary)
                if size != expected[0]:
                    raise ValueError('Source object size changed during migration')
                if target.exists():
                    if target.stat().st_size != size or digest(target) != checksum:
                        raise ValueError('Migration refuses to overwrite different destination bytes')
                else:
                    os.chmod(temporary, 0o640)
                    os.link(temporary, target)
            finally:
                temporary.unlink()
    finally:
        body.close()
    if digest(target) != checksum:
        raise ValueError('Destination sha256 differs from source')
    return size, checksum


def copy_directory_marker(client: Any, bucket: str, key: str, expected: tuple[int, str], target: Path) -> tuple[int, str]:
    if expected[0] != 0:
        raise ValueError('Source directory marker contains data')
    body = client.get_object(Bucket=bucket, Key=key, IfMatch=expected[1])['Body']
    try:
        content = body.read()
    finally:
        body.close()
    if content:
        raise ValueError('Source directory marker contains data')
    target.mkdir(parents=True, exist_ok=True)
    return 0, hashlib.sha256(content).hexdigest()


def account_receipts(files: Mapping[str, tuple[int, str]]) -> list[dict[str, Any]]:
    accounts: dict[str, list[tuple[str, int, str]]] = {}
    for key, (size, checksum) in sorted(files.items()):
        if key == 'accounts/':
            continue
        account, name = key.removeprefix('accounts/').split('/', 1)
        accounts.setdefault(account, []).append((name, size, checksum))
    return [
        {'account': account, 'count': len(entries), 'bytes': sum(size for _, size, _ in entries),
         'sha256': hashlib.sha256(json.dumps(entries, separators=(',', ':')).encode()).hexdigest()}
        for account, entries in sorted(accounts.items())
    ]


def destination_files(destination: Path, accounts: set[str]) -> dict[str, tuple[int, str]]:
    actual = {}
    for account in accounts:
        for file in (destination / account).rglob('*'):
            if file.is_symlink():
                raise ValueError('Destination contains a symlink')
            if file.is_file():
                actual[f'accounts/{file.relative_to(destination).as_posix()}'] = (file.stat().st_size, digest(file))
    return actual


def migrate(client: Any, bucket: str, destination: Path) -> dict[str, Any]:
    destination.mkdir(parents=True, exist_ok=True)
    before = inventory(client, bucket)
    copied = {key: copy_object(client, bucket, key, expected, destination) for key, expected in before.items()}
    after = inventory(client, bucket)
    if before != after:
        raise ValueError('Source inventory changed during migration; reconcile destination bytes before cutover')
    actual = destination_files(destination, {key.split('/')[1] for key in before if key != 'accounts/'})
    for key in before:
        if key.endswith('/'):
            directory = destination / key.removeprefix('accounts/')
            if not directory.is_dir() or directory.is_symlink():
                raise ValueError('Destination directory marker is missing')
            actual[key] = (0, hashlib.sha256(b'').hexdigest())
    if copied != actual:
        raise ValueError('Destination count or sha256 differs from the source manifest')
    return {'sourceCount': len(before), 'destinationCount': len(actual), 'files': sum(not key.endswith('/') for key in actual),
            'directories': sum(key.endswith('/') for key in actual), 'accounts': account_receipts(actual)}


def verify_accounts_mount(root: Path) -> None:
    if not root.is_mount():
        raise ValueError('Migration requires the mounted EFS accounts access point, not a local directory')
    owner = root.stat()
    if owner.st_uid != 1000 or owner.st_gid != 1000:
        raise ValueError('Migration requires the uid-1000 accounts access point owned by 1000:1000; root or root-squashed mounts are unsafe')


def main() -> None:
    parser = argparse.ArgumentParser(description='Copy S3 account prefixes to a mounted EFS accounts directory and verify count and sha256, including explicit directory markers. Source data and account records stay unchanged.')
    parser.add_argument('--bucket', required=True)
    parser.add_argument('--accounts-root', type=Path, required=True)
    args = parser.parse_args()
    verify_accounts_mount(args.accounts_root)
    print(json.dumps(migrate(boto3.client('s3'), args.bucket, args.accounts_root), sort_keys=True))


if __name__ == '__main__':
    main()

"""Run in the image as root to exercise git on a Files directory with another owner."""
import os
import subprocess
from pathlib import Path

root = Path('/mnt/workspace/files')
root.mkdir(parents=True)
assert not (root / '.git').exists()
assert subprocess.run(['git', '-C', str(root), 'status'], capture_output=True).returncode != 0
for repo in (root, root / 'project'):
    repo.mkdir(exist_ok=True)
    os.chown(repo, 12345, 12345)
    subprocess.run(['git', '-C', str(repo), 'init'], check=True)
    os.chown(repo / '.git', 12345, 12345)
    file = repo / 'notes.txt'
    file.write_text('original\n')
    subprocess.run(['git', '-C', str(repo), 'add', 'notes.txt'], check=True)
    subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'Save notes'], check=True)
    identity = subprocess.check_output(['git', '-C', str(repo), 'log', '-1', '--format=%an <%ae>'], text=True)
    assert identity.strip() == 'BotCube <botcube@noreply.invalid>'
    file.write_text('changed\n')
    diff = subprocess.check_output(['git', '-C', str(repo), 'diff'], text=True)
    assert '-original\n+changed' in diff
    subprocess.run(['git', '-C', str(repo), 'restore', '--source=HEAD', 'notes.txt'], check=True)
    assert file.read_text() == 'original\n'
    assert subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain']) == b''
    assert subprocess.check_output(['git', '-C', str(repo), 'remote']) == b''
    assert subprocess.run(['git', '-C', str(repo), 'restore', '--source=missing', 'notes.txt'], capture_output=True).returncode != 0
    assert file.read_text() == 'original\n'
print('PASS: on-demand init, identity, foreign ownership, diff, restore, invalid revision, root and nested repos')

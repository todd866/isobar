import importlib.util
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('stamp', ROOT / 'tools/stamp-native-source.py')
stamp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stamp)


class StampTests(unittest.TestCase):
    def test_checkout_dirty_and_git_archive_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'; root.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
            git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
            (root / '.gitattributes').write_bytes((ROOT / '.gitattributes').read_bytes())
            # This test also runs from an archive whose token is already expanded.
            (root / '.git-archive-revision').write_text('$Format:%H$\n')
            (root / 'source').write_text('clean')
            git('add', '.'); git('commit', '-qm', 'fixture')
            revision = git('rev-parse', 'HEAD')
            self.assertEqual(stamp.source_identity(root), (revision, False))
            (root / 'extra-source').write_text('untracked')
            self.assertEqual(stamp.source_identity(root), (revision, True))
            (root / 'extra-source').unlink()
            (root / 'source').write_text('dirty')
            self.assertEqual(stamp.source_identity(root), (revision, True))
            (root / '.git-archive-revision').write_text('a' * 40)
            self.assertEqual(stamp.source_identity(root), (revision, True))
            archive = subprocess.check_output(['git', '-C', str(root), 'archive', '--format=tar', 'HEAD'])
            exported = Path(directory) / 'export'; exported.mkdir()
            with tarfile.open(fileobj=io.BytesIO(archive)) as source:
                source.extractall(exported, filter='data')
            self.assertFalse((exported / '.git').exists())
            self.assertEqual(stamp.source_identity(exported), (revision, False))
            (exported / '.git-archive-revision').write_text('invalid')
            with self.assertRaises(ValueError):
                stamp.source_identity(exported)

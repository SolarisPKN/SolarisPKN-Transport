from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PROHIBITED_MOBILE_SUFFIXES = {".apk", ".xapk", ".apks", ".aab"}
PROHIBITED_SECRET_SUFFIXES = {".keystore", ".jks", ".p12", ".pfx"}


class RepositoryHygieneTests(unittest.TestCase):
    def test_git_does_not_track_mobile_packages_or_signing_stores(self) -> None:
        result = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
        )
        tracked = [
            Path(item.decode("utf-8"))
            for item in result.stdout.split(b"\0")
            if item
        ]
        prohibited = sorted(
            str(path)
            for path in tracked
            if path.suffix.casefold()
            in PROHIBITED_MOBILE_SUFFIXES | PROHIBITED_SECRET_SUFFIXES
        )
        self.assertEqual(
            prohibited,
            [],
            "Third-party mobile packages or signing stores must not be tracked",
        )


if __name__ == "__main__":
    unittest.main()

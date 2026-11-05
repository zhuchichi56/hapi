"""Run isolated current-turn regressions against an installed watchdog package."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package', type=Path, default=Path.home()/'.local/lib/codex-orchestra/orchestra')
args = parser.parse_args()
fixture = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='orchestra-current-turn-') as temporary:
    package = Path(temporary)/'orchestra'
    shutil.copytree(args.package, package, ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy2(fixture.parents[1]/'orchestra/collector.py', package/'collector.py')
    for name in ('test_current_turn_progress.py', 'test_watchdog.py'):
        shutil.copy2(fixture/name, package/name)
    env = dict(os.environ, PYTHONPATH=temporary, PYTHONDONTWRITEBYTECODE='1')
    result = subprocess.run([sys.executable, '-m', 'unittest', '-v',
        'orchestra.test_current_turn_progress', 'orchestra.test_watchdog'], cwd=temporary, env=env)
    raise SystemExit(result.returncode)

#!/usr/bin/env python3
"""Thin executable shim for the orchestra package.

Usage: python3 orchestra.py --state DIR COMMAND [options]
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from orchestra.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())

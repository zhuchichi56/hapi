"""Allow ``python3 -m orchestra --state DIR snapshot``."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())

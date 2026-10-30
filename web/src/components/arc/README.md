# Arc Library source in Urban Desktop

The segmented control is installed by copying and adapting its free MIT source
from [`kuratlielia/arc-library`](https://github.com/kuratlielia/arc-library),
commit `df3a600fd9ffca85ec8607438b599a4408ab8562`. See `LICENSE` here.

This copy keeps Arc's keyboard navigation, selection motion, and reduced-motion
behavior, and adds a disabled state for native mutations. The selection motion
uses CSS instead of Arc's Motion runtime: the unmodified component added about
40 KB of compressed JavaScript to the desktop route in a local build. Its
colors are mapped to HAPI's existing theme in `.nd-arc-tabs`; Arc's global
foundation stylesheet is not imported.

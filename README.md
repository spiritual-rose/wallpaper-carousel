# Wallpaper Carousel

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-48_–_50-4A86CF?logo=gnome&logoColor=white)](https://github.com/SpiritualRose/wallpaper-carousel)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/License-GPL--2.0--or--later-blue.svg)](LICENSE)

A GNOME Shell extension that cycles your desktop wallpaper through a folder of
images on a timer. Point it at a folder, pick an interval, and forget about it
— the preferences window handles the rest.

## Features

- Rotates wallpapers every 5 to 60 minutes
- Shuffle or alphabetical order
- Pauses automatically when another app changes your wallpaper
- Live preview of upcoming wallpapers in preferences
- Optional "Next wallpaper" entry in the desktop right-click menu
- Optional Quick Settings button to open preferences

## Install

```sh
make install
gnome-extensions enable wallpaper-carousel@rangol.se
```

On Wayland, log out and back in. On X11, `Alt+F2 → r → Enter` restarts the
shell in place.

Then open preferences and point it at a folder:

```sh
gnome-extensions prefs wallpaper-carousel@rangol.se
```

## Translations

Copy the template, fill in the `msgstr` lines, and reinstall:

```sh
cp po/wallpaper-carousel-rangol-se.pot po/<lang>.po
make install
```

`<lang>` is a POSIX locale code — `de`, `fr`, `nb`, and so on. Swedish is
already included.

## Uninstall

```sh
gnome-extensions disable wallpaper-carousel@rangol.se
make uninstall
```

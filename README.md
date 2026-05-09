# Wallpaper Carousel

A small GNOME Shell extension that cycles your desktop wallpaper through a
folder of images on a timer.

Point it at a folder, pick an interval (5 minutes up to an hour), and let it
go. The preferences window has prev/pause/next controls and a few toggles —
random vs. alphabetical order, whether to add a "Next wallpaper" entry to the
desktop right-click menu, and whether to drop a button next to the gear in
Quick Settings that opens these preferences.

Targets GNOME Shell 48–50. Ships with a Swedish translation.

## Install

```sh
make install
gnome-extensions enable wallpaper-carousel@rangol.se
```

On Wayland you'll need to log out and back in for the shell to pick up the new
code. On X11, `Alt+F2 → r → Enter` is enough.

Then open preferences and point it at a folder:

```sh
gnome-extensions prefs wallpaper-carousel@rangol.se
```

## Translations

Copy the template, fill in the `msgstr` lines, reinstall:

```sh
cp po/wallpaper-carousel-rangol-se.pot po/<lang>.po
make install
```

`<lang>` is a POSIX locale code — `de`, `fr`, `nb`, and so on.

## Uninstall

```sh
gnome-extensions disable wallpaper-carousel@rangol.se
make uninstall
```

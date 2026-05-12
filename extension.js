// SPDX-FileCopyrightText: 2026 Alexander Rangol <alexander@rangol.se>
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const BG_SCHEMA = 'org.gnome.desktop.background';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.avif'];
const REBUILD_DEBOUNCE_MS = 2000;
const MONITOR_RATE_LIMIT_MS = 5000;

// One-way IPC from prefs to shell via the change-trigger int key.
// Values must match prefs.js.
const TRIGGER_IDLE = 0;
const TRIGGER_PREV = 1;
const TRIGGER_NEXT = 2;

class Carousel {
    constructor(settings) {
        this._settings = settings;
        this._bgSettings = new Gio.Settings({schema_id: BG_SCHEMA});
        this._queue = [];
        this._timeoutId = 0;
        this._monitor = null;
        this._monitorChangedId = 0;
        this._rebuildPendingId = 0;
        // Echo-suppression token for our own picture-uri writes.
        this._lastSetUri = null;
        this._bgWatchId = 0;

        this._signalIds = [
            this._settings.connect('changed::directory', () => this._rebuildAndRestart()),
            this._settings.connect('changed::random', () => this._rebuildAndRestart()),
            this._settings.connect('changed::interval-seconds', () => this._restartTimer()),
            this._settings.connect('changed::paused', () => this._onPausedChanged()),
            this._settings.connect('changed::change-trigger', () => this._handleTrigger()),
        ];

        this._bgWatchId = this._bgSettings.connect('changed::picture-uri',
            () => this._onExternalWallpaperChange());
    }

    start() {
        this._rebuildAndRestart();
    }

    stop() {
        for (const id of this._signalIds)
            this._settings.disconnect(id);
        this._signalIds = [];

        if (this._bgWatchId) {
            this._bgSettings.disconnect(this._bgWatchId);
            this._bgWatchId = 0;
        }

        this._cancelTimer();
        this._cancelPendingRebuild();
        this._teardownMonitor();

        this._bgSettings = null;
        this._settings = null;
    }

    _handleTrigger() {
        const v = this._settings.get_int('change-trigger');
        if (v === TRIGGER_IDLE)
            return;
        if (v === TRIGGER_PREV)
            this._advance(-1);
        else if (v === TRIGGER_NEXT)
            this._advance(+1);
        this._settings.set_int('change-trigger', TRIGGER_IDLE);
        this._restartTimer();
    }

    _rebuildAndRestart() {
        this._buildQueue();
        this._setupMonitor();
        this._showCurrent();
        this._restartTimer();
    }

    _buildQueue() {
        this._queue = [];
        const dir = this._settings.get_string('directory');
        if (!dir)
            return;

        const folder = Gio.File.new_for_path(dir);
        if (!folder.query_exists(null))
            return;

        let enumerator;
        try {
            enumerator = folder.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (e) {
            console.warn(`Wallpaper Carousel: cannot enumerate ${dir}: ${e.message}`);
            return;
        }

        let info;
        while ((info = enumerator.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            const name = info.get_name();
            const lower = name.toLowerCase();
            if (!IMAGE_EXTS.some(ext => lower.endsWith(ext)))
                continue;
            this._queue.push(GLib.build_filenamev([dir, name]));
        }
        enumerator.close(null);

        if (this._settings.get_boolean('random'))
            this._shuffle();
        else
            this._queue.sort();

        // Prefer the wallpaper currently shown on screen if it's a member of
        // our queue. On enable this avoids forcing a transition back to the
        // last-tracked index when the user is already viewing a wallpaper from
        // our folder. Consistent with _onExternalWallpaperChange's policy of
        // not fighting external picks.
        if (this._adoptDisplayedIndex())
            return;

        const idx = this._settings.get_int('current-index');
        if (idx < 0 || idx >= this._queue.length)
            this._settings.set_int('current-index', 0);
    }

    // If the currently displayed wallpaper is a member of our queue, point
    // current-index at it and return true. Otherwise leave current-index
    // alone and return false.
    _adoptDisplayedIndex() {
        const displayedUri = this._bgSettings.get_string('picture-uri');
        const displayedPath = displayedUri
            ? Gio.File.new_for_uri(displayedUri).get_path()
            : null;
        if (!displayedPath)
            return false;
        const idx = this._queue.indexOf(displayedPath);
        if (idx < 0)
            return false;
        this._settings.set_int('current-index', idx);
        return true;
    }

    _shuffle() {
        for (let i = this._queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this._queue[i], this._queue[j]] = [this._queue[j], this._queue[i]];
        }
    }

    _setupMonitor() {
        this._teardownMonitor();
        const dir = this._settings.get_string('directory');
        if (!dir)
            return;

        const folder = Gio.File.new_for_path(dir);
        if (!folder.query_exists(null))
            return;

        try {
            this._monitor = folder.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.set_rate_limit(MONITOR_RATE_LIMIT_MS);
            this._monitorChangedId = this._monitor.connect('changed', () => this._scheduleRebuild());
        } catch (e) {
            console.warn(`Wallpaper Carousel: cannot monitor ${dir}: ${e.message}`);
        }
    }

    _teardownMonitor() {
        if (this._monitor) {
            if (this._monitorChangedId) {
                this._monitor.disconnect(this._monitorChangedId);
                this._monitorChangedId = 0;
            }
            this._monitor.cancel();
            this._monitor = null;
        }
    }

    _scheduleRebuild() {
        if (this._rebuildPendingId)
            return;
        this._rebuildPendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DEBOUNCE_MS, () => {
            this._rebuildPendingId = 0;
            this._buildQueue();
            this._showCurrent();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPendingRebuild() {
        if (this._rebuildPendingId) {
            GLib.source_remove(this._rebuildPendingId);
            this._rebuildPendingId = 0;
        }
    }

    _showCurrent() {
        if (!this._queue.length) {
            this._settings.set_strv('upcoming-uris', []);
            this._settings.set_string('current-uri', '');
            return;
        }
        let idx = this._settings.get_int('current-index');
        if (idx < 0 || idx >= this._queue.length) {
            idx = 0;
            this._settings.set_int('current-index', 0);
        }
        const rotated = this._queue.slice(idx).concat(this._queue.slice(0, idx));
        const uris = rotated.slice(0, 4).map(p => Gio.File.new_for_path(p).get_uri());
        this._lastSetUri = uris[0];
        this._bgSettings.set_string('picture-uri', uris[0]);
        this._bgSettings.set_string('picture-uri-dark', uris[0]);
        // Write upcoming-uris before current-uri so prefs subscribers (which
        // listen only on current-uri) see fresh data on a single refresh.
        this._settings.set_strv('upcoming-uris', uris.slice(1));
        this._settings.set_string('current-uri', uris[0]);
    }

    _onPausedChanged() {
        // Snap to our current on resume so an external pick (which
        // auto-paused us) doesn't linger until the next tick.
        if (!this._settings.get_boolean('paused'))
            this._showCurrent();
        this._restartTimer();
    }

    // Auto-pause when something else changes the wallpaper, ignoring
    // our own writes (matched via _lastSetUri).
    _onExternalWallpaperChange() {
        if (!this._bgSettings)
            return;
        const current = this._bgSettings.get_string('picture-uri');
        if (current === this._lastSetUri)
            return;
        if (this._settings.get_boolean('paused'))
            return;
        this._settings.set_boolean('paused', true);
    }

    _advance(delta) {
        if (!this._queue.length)
            return;
        let idx = this._settings.get_int('current-index') + delta;
        if (idx >= this._queue.length)
            idx = 0;
        else if (idx < 0)
            idx = this._queue.length - 1;
        this._settings.set_int('current-index', idx);
        this._showCurrent();
    }

    next() {
        // Clicking "Next wallpaper" from the desktop menu is an implicit
        // resume. If we're paused (typically because the user picked something
        // else and _onExternalWallpaperChange auto-paused us), adopt that
        // displayed wallpaper as our position first so "next" advances to the
        // file after it — otherwise we'd briefly flash back to the last
        // carousel-tracked wallpaper before moving on. The prev/next buttons
        // in the prefs window deliberately do NOT resume; the user can see
        // the paused state and press play if they want it.
        const wasPaused = this._settings.get_boolean('paused');
        if (wasPaused)
            this._adoptDisplayedIndex();

        this._advance(+1);

        if (wasPaused)
            this._settings.set_boolean('paused', false);
        else
            this._restartTimer();
    }

    pauseForMenu() {
        this._cancelTimer();
    }

    resumeFromMenu() {
        this._restartTimer();
    }

    _restartTimer() {
        this._cancelTimer();
        if (this._settings.get_boolean('paused'))
            return;
        if (!this._queue.length)
            return;
        const interval = this._settings.get_int('interval-seconds');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._advance(+1);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cancelTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}

export default class CarouselExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._carousel = new Carousel(this._settings);
        this._carousel.start();
        this._menuOpenCount = 0;
        this._touchedMenus = new Map();
        this._bgManagerHandlers = new Map();
        this._injectionManager = null;

        this._extSignals = [
            this._settings.connect('changed::show-context-menu-item',
                () => this._refreshContextMenuItem()),
            this._settings.connect('changed::show-quick-settings-button',
                () => this._refreshQuickSettingsButton()),
        ];

        if (Main.layoutManager._startingUp) {
            this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => {
                this._refreshContextMenuItem();
                this._refreshQuickSettingsButton();
            });
        } else {
            this._refreshContextMenuItem();
            this._refreshQuickSettingsButton();
        }
    }

    disable() {
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = 0;
        }

        for (const id of this._extSignals)
            this._settings.disconnect(id);
        this._extSignals = [];

        this._teardownContextMenuItem();
        this._teardownQuickSettingsButton();

        this._carousel.stop();
        this._carousel = null;
        this._settings = null;
    }

    _onBackgroundMenuStateChanged(isOpen) {
        if (isOpen) {
            this._menuOpenCount += 1;
            if (this._menuOpenCount === 1)
                this._carousel?.pauseForMenu();
        } else {
            this._menuOpenCount = Math.max(0, this._menuOpenCount - 1);
            if (this._menuOpenCount === 0)
                this._carousel?.resumeFromMenu();
        }
    }

    _refreshContextMenuItem() {
        this._teardownContextMenuItem();
        if (!this._settings.get_boolean('show-context-menu-item'))
            return;

        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(Main.layoutManager, '_addBackgroundMenu', originalMethod => {
            const ext = this;
            return function (bgManager) {
                originalMethod.call(this, bgManager);
                ext._attachItemToMenu(bgManager.backgroundActor?._backgroundMenu);
            };
        });

        // Attach to already-created background menus in place rather than
        // calling Main.layoutManager._updateBackgrounds(): that would destroy
        // and recreate every background actor, cutting any in-flight wallpaper
        // crossfade and briefly exposing the stage clear color (a jarring cut
        // plus a blue flash) every time the extension enables or disables.
        //
        // For each pre-existing bgManager we also need our own 'changed'
        // handler: gnome-shell's _createBackgroundManager does
        //   bgManager.connect('changed', this._addBackgroundMenu.bind(this))
        // at shell startup, and .bind() eagerly captures a reference to the
        // ORIGINAL _addBackgroundMenu. Our InjectionManager override replaces
        // the method on the prototype, but the already-bound signal handler
        // still points at the original — so on every wallpaper change the
        // pre-existing bgManagers rebuild their menu via the unwrapped method
        // and our item silently disappears. New bgManagers created after
        // enable bind to the wrapped method and are covered by the override
        // alone.
        for (const bgManager of Main.layoutManager._bgManagers ?? []) {
            this._attachItemToMenu(bgManager.backgroundActor?._backgroundMenu);
            const handlerId = bgManager.connect('changed', () => {
                this._attachItemToMenu(bgManager.backgroundActor?._backgroundMenu);
            });
            this._bgManagerHandlers.set(bgManager, handlerId);
        }
    }

    _attachItemToMenu(menu) {
        if (!menu || this._touchedMenus.has(menu))
            return;

        const item = new PopupMenu.PopupMenuItem(_('Next wallpaper'));
        item.connectObject('activate', () => this._carousel?.next(), this);
        menu.addMenuItem(item);

        // While any background menu is open, suspend the auto-rotate timer so
        // a transition doesn't destroy the actor and close the menu out from
        // under the user. Also drop the entry on menu destruction (e.g. a
        // monitor reconfigure rebuilding backgrounds) to avoid stale refs.
        menu.connectObject(
            'open-state-changed', (_m, isOpen) => this._onBackgroundMenuStateChanged(isOpen),
            'destroy', () => this._touchedMenus.delete(menu),
            this);

        this._touchedMenus.set(menu, item);
    }

    _teardownContextMenuItem() {
        if (!this._injectionManager)
            return;

        // Remove our items in place; no _updateBackgrounds() — see
        // _refreshContextMenuItem for why.
        for (const [menu, item] of this._touchedMenus) {
            try {
                menu.disconnectObject(this);
                item.destroy();
            } catch (_e) {
                // Menu may have been destroyed already.
            }
        }
        this._touchedMenus.clear();

        for (const [bgManager, id] of this._bgManagerHandlers) {
            try {
                bgManager.disconnect(id);
            } catch (_e) {
                // bgManager may have been destroyed already.
            }
        }
        this._bgManagerHandlers.clear();

        this._injectionManager.clear();
        this._injectionManager = null;
        this._menuOpenCount = 0;
    }

    _refreshQuickSettingsButton() {
        this._teardownQuickSettingsButton();
        if (!this._settings.get_boolean('show-quick-settings-button'))
            return;

        const qs = Main.panel.statusArea.quickSettings;
        const systemItem = qs?._system?._systemItem ?? qs?._system?.quickSettingsItems?.[0];
        if (!systemItem?.child) {
            console.warn('Wallpaper Carousel: could not locate quick-settings system item; skipping button.');
            return;
        }

        this._qsButton = new St.Button({
            style_class: 'icon-button',
            can_focus: true,
            icon_name: 'image-x-generic-symbolic',
            accessible_name: _('Open Wallpaper Carousel settings'),
        });
        this._qsButton.connectObject('clicked', () => {
            Main.panel.closeQuickSettings();
            this._openOrFocusPrefs();
        }, this);

        // Insert immediately after the first existing child (typically the
        // Settings gear), filling the gap between Settings and the
        // right-hand Lock/Power cluster. GNOME has no slot system for the
        // system actions row — children are positioned in insertion order.
        const children = systemItem.child.get_children();
        if (children.length === 0)
            systemItem.child.add_child(this._qsButton);
        else
            systemItem.child.insert_child_at_index(this._qsButton, 1);
    }

    _teardownQuickSettingsButton() {
        if (this._qsButton) {
            this._qsButton.disconnectObject(this);
            this._qsButton.destroy();
            this._qsButton = null;
        }
    }

    _openOrFocusPrefs() {
        // openPreferences() spawns/activates the extensions-prefs process,
        // but on Wayland that doesn't always raise an existing window — so
        // first try to locate our prefs window directly and activate it.
        const wantedTitle = _(this.metadata.name);
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (w.get_wm_class() !== 'org.gnome.Shell.Extensions')
                continue;
            if (w.get_title() !== wantedTitle)
                continue;
            Main.activateWindow(w);
            return;
        }
        this.openPreferences();
    }
}

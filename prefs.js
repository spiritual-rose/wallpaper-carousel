// SPDX-FileCopyrightText: 2026 Alexander Rangol <alexander@rangol.se>
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const N_ = s => s;

// One-way IPC from prefs to shell via the change-trigger int key.
// Values must match extension.js.
const TRIGGER_PREV = 1;
const TRIGGER_NEXT = 2;

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 150;
const THUMB_WIDTH = PREVIEW_WIDTH / 2;
const THUMB_HEIGHT = PREVIEW_HEIGHT / 2;

const INTERVAL_PRESETS = [
    {seconds:  300, label: N_('5 minutes')},
    {seconds:  600, label: N_('10 minutes')},
    {seconds:  900, label: N_('15 minutes')},
    {seconds: 1800, label: N_('30 minutes')},
    {seconds: 2700, label: N_('45 minutes')},
    {seconds: 3600, label: N_('1 hour')},
];

let _previewCssLoaded = false;

function ensurePreviewCss() {
    if (_previewCssLoaded)
        return;
    // Adwaita's .circular class is scoped to buttons; on a Box it's a no-op.
    // This rule rounds the .osd backdrop on the playback-mode pill.
    const provider = new Gtk.CssProvider();
    provider.load_from_string('.wpc-mode-pill { border-radius: 9999px; }');
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );
    _previewCssLoaded = true;
}

function findClosestPresetIndex(seconds) {
    let bestIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < INTERVAL_PRESETS.length; i++) {
        const delta = Math.abs(INTERVAL_PRESETS[i].seconds - seconds);
        if (delta < bestDelta) {
            bestDelta = delta;
            bestIdx = i;
        }
    }
    return bestIdx;
}

export default class CarouselPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signalIds = [];

        // Set an explicit title so the shell-side QS button can locate this
        // window by title and re-focus it instead of doing nothing when
        // clicked again.
        window.set_title(_(this.metadata.name));

        const page = new Adw.PreferencesPage();
        window.add(page);

        page.add(this._buildPreviewGroup(settings, signalIds));
        page.add(this._buildPlaybackGroup(settings, signalIds));
        page.add(this._buildSourceGroup(window, settings, signalIds));
        page.add(this._buildIntegrationGroup(settings));

        window.connect('close-request', () => {
            for (const id of signalIds)
                settings.disconnect(id);
        });
    }

    _buildPreviewGroup(settings, signalIds) {
        const group = new Adw.PreferencesGroup();

        const frame = new Gtk.Frame({
            css_classes: ['card'],
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            width_request: PREVIEW_WIDTH,
            height_request: PREVIEW_HEIGHT,
            overflow: Gtk.Overflow.HIDDEN,
            margin_top: 6,
            margin_bottom: 6,
        });
        group.add(frame);

        const overlay = new Gtk.Overlay();
        frame.set_child(overlay);

        ensurePreviewCss();

        const iconBackdrop = new Gtk.Box({
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['osd', 'wpc-mode-pill'],
        });
        const modeIcon = new Gtk.Image({
            pixel_size: 24,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
        });
        iconBackdrop.append(modeIcon);
        overlay.add_overlay(iconBackdrop);

        const refreshModeIcon = () => {
            if (settings.get_boolean('paused'))
                modeIcon.icon_name = 'media-playback-pause-symbolic';
            else if (settings.get_boolean('random'))
                modeIcon.icon_name = 'media-playlist-shuffle-symbolic';
            else
                modeIcon.icon_name = 'media-playlist-repeat-symbolic';
        };
        refreshModeIcon();

        const refresh = () => {
            const paths = this._collectQueuePaths(
                settings.get_string('current-uri'),
                settings.get_strv('upcoming-uris')
            );
            if (!paths.length) {
                overlay.set_child(new Gtk.Label({
                    label: _('No images in folder'),
                    halign: Gtk.Align.CENTER,
                    valign: Gtk.Align.CENTER,
                }));
                return;
            }
            const grid = new Gtk.Grid({
                row_homogeneous: true,
                column_homogeneous: true,
            });
            for (let i = 0; i < 4; i++) {
                const col = i % 2;
                const row = Math.floor(i / 2);
                grid.attach(this._makeThumbnail(paths[i % paths.length], THUMB_WIDTH, THUMB_HEIGHT), col, row, 1, 1);
            }
            overlay.set_child(grid);
        };
        refresh();

        // Subscribe only to current-uri: extension.js writes upcoming-uris
        // first, so by the time this fires both keys are fresh.
        signalIds.push(settings.connect('changed::current-uri', refresh));
        signalIds.push(settings.connect('changed::paused', refreshModeIcon));
        signalIds.push(settings.connect('changed::random', refreshModeIcon));

        return group;
    }

    _collectQueuePaths(currentUri, upcomingUris) {
        return [currentUri, ...upcomingUris]
            .filter(u => u)
            .map(u => Gio.File.new_for_uri(u).get_path())
            .filter(p => p);
    }

    _makeFlatBtn({icon, tooltip, onClick}) {
        const btn = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        if (icon)
            btn.icon_name = icon;
        if (tooltip)
            btn.tooltip_text = tooltip;
        if (onClick)
            btn.connect('clicked', onClick);
        return btn;
    }

    _makeThumbnail(path, width, height) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, width, height, true);
            return new Gtk.Picture({
                paintable: Gdk.Texture.new_for_pixbuf(pixbuf),
                content_fit: Gtk.ContentFit.COVER,
                hexpand: true,
                vexpand: true,
            });
        } catch (_e) {
            return new Gtk.Image({
                icon_name: 'image-missing-symbolic',
                hexpand: true,
                vexpand: true,
            });
        }
    }

    _buildPlaybackGroup(settings, signalIds) {
        const group = new Adw.PreferencesGroup({title: _('Playback')});

        const currentRow = new Adw.ActionRow({title: _('Current wallpaper')});
        const refreshCurrentRow = () => {
            const uri = settings.get_string('current-uri');
            currentRow.subtitle = uri
                ? Gio.File.new_for_uri(uri).get_basename() || '—'
                : '—';
        };
        refreshCurrentRow();
        signalIds.push(settings.connect('changed::current-uri', refreshCurrentRow));

        currentRow.add_suffix(this._makeFlatBtn({
            icon: 'media-skip-backward-symbolic',
            tooltip: _('Previous wallpaper'),
            onClick: () => settings.set_int('change-trigger', TRIGGER_PREV),
        }));

        const pauseBtn = this._makeFlatBtn({
            onClick: () =>
                settings.set_boolean('paused', !settings.get_boolean('paused')),
        });
        const refreshPauseBtn = () => {
            const paused = settings.get_boolean('paused');
            pauseBtn.icon_name = paused
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
            pauseBtn.tooltip_text = paused ? _('Resume') : _('Pause');
        };
        refreshPauseBtn();
        signalIds.push(settings.connect('changed::paused', refreshPauseBtn));
        currentRow.add_suffix(pauseBtn);

        currentRow.add_suffix(this._makeFlatBtn({
            icon: 'media-skip-forward-symbolic',
            tooltip: _('Next wallpaper'),
            onClick: () => settings.set_int('change-trigger', TRIGGER_NEXT),
        }));

        group.add(currentRow);

        const stringList = new Gtk.StringList();
        for (const p of INTERVAL_PRESETS)
            stringList.append(_(p.label));

        const intervalRow = new Adw.ComboRow({
            title: _('Interval'),
            model: stringList,
        });

        const initialSeconds = settings.get_int('interval-seconds');
        const initialIdx = findClosestPresetIndex(initialSeconds);
        intervalRow.selected = initialIdx;
        if (INTERVAL_PRESETS[initialIdx].seconds !== initialSeconds)
            settings.set_int('interval-seconds', INTERVAL_PRESETS[initialIdx].seconds);

        intervalRow.connect('notify::selected', () => {
            settings.set_int('interval-seconds', INTERVAL_PRESETS[intervalRow.selected].seconds);
        });
        signalIds.push(settings.connect('changed::interval-seconds', () => {
            const idx = findClosestPresetIndex(settings.get_int('interval-seconds'));
            if (intervalRow.selected !== idx)
                intervalRow.selected = idx;
        }));
        group.add(intervalRow);

        const shuffleRow = new Adw.SwitchRow({title: _('Shuffle')});
        settings.bind('random', shuffleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(shuffleRow);

        return group;
    }

    _buildSourceGroup(window, settings, signalIds) {
        const group = new Adw.PreferencesGroup({title: _('Source')});

        const folderRow = new Adw.ActionRow({title: _('Wallpaper folder')});
        const refreshFolderRow = () => {
            const path = settings.get_string('directory');
            folderRow.subtitle = path || _('Not set');
        };
        refreshFolderRow();
        signalIds.push(settings.connect('changed::directory', refreshFolderRow));

        const browseBtn = new Gtk.Button({
            label: _('Browse…'),
            valign: Gtk.Align.CENTER,
        });
        browseBtn.connect('clicked', () => this._pickFolder(window, settings));
        folderRow.add_suffix(browseBtn);
        folderRow.activatable_widget = browseBtn;
        group.add(folderRow);

        return group;
    }

    _buildIntegrationGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Shell integration')});

        const menuRow = new Adw.SwitchRow({title: _('Next wallpaper in desktop menu')});
        settings.bind('show-context-menu-item', menuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(menuRow);

        const qsRow = new Adw.SwitchRow({title: _('Shortcut in Quick Settings')});
        settings.bind('show-quick-settings-button', qsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(qsRow);

        return group;
    }

    _pickFolder(parent, settings) {
        const dialog = new Gtk.FileDialog({
            title: _('Select wallpaper folder'),
            modal: true,
        });

        const current = settings.get_string('directory');
        if (current)
            dialog.set_initial_folder(Gio.File.new_for_path(current));

        dialog.select_folder(parent, null, (dlg, res) => {
            try {
                const folder = dlg.select_folder_finish(res);
                if (folder)
                    settings.set_string('directory', folder.get_path());
            } catch (_e) {
                // User cancelled or dismissed the dialog.
            }
        });
    }
}

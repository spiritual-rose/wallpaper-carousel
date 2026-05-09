// SPDX-FileCopyrightText: 2026 Alexander Rangol <alexander@rangol.se>
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// N_ marks strings for xgettext extraction without translating at module-load
// time; we translate via _() at the point of display.
const N_ = s => s;

const INTERVAL_PRESETS = [
    {seconds:  300, label: N_('5 minutes')},
    {seconds:  600, label: N_('10 minutes')},
    {seconds:  900, label: N_('15 minutes')},
    {seconds: 1800, label: N_('30 minutes')},
    {seconds: 2700, label: N_('45 minutes')},
    {seconds: 3600, label: N_('1 hour')},
];

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

        page.add(this._buildPlaybackGroup(settings, signalIds));
        page.add(this._buildFolderGroup(window, settings, signalIds));
        page.add(this._buildShortcutsGroup(settings));
        const aboutGroup = this._buildAboutGroup();
        if (aboutGroup)
            page.add(aboutGroup);

        window.connect('close-request', () => {
            for (const id of signalIds)
                settings.disconnect(id);
        });
    }

    _buildShortcutsGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Shortcuts')});

        const menuRow = new Adw.SwitchRow({title: _('Show in desktop menu')});
        settings.bind('show-context-menu-item', menuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(menuRow);

        const qsRow = new Adw.SwitchRow({title: _('Show in Quick Settings')});
        settings.bind('show-quick-settings-button', qsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(qsRow);

        return group;
    }

    _buildFolderGroup(window, settings, signalIds) {
        const group = new Adw.PreferencesGroup({title: _('Folder & timing')});

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

        const randomRow = new Adw.SwitchRow({title: _('Random order')});
        settings.bind('random', randomRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(randomRow);

        return group;
    }

    _buildPlaybackGroup(settings, signalIds) {
        const group = new Adw.PreferencesGroup({title: _('Playback')});

        const currentRow = new Adw.ActionRow({title: _('Current wallpaper')});
        const refreshCurrentRow = () => {
            const uri = settings.get_string('current-uri');
            if (!uri) {
                currentRow.subtitle = '—';
                return;
            }
            try {
                const path = Gio.File.new_for_uri(uri).get_path();
                currentRow.subtitle = path ? GLib.path_get_basename(path) : '—';
            } catch (_e) {
                currentRow.subtitle = '—';
            }
        };
        refreshCurrentRow();
        signalIds.push(settings.connect('changed::current-uri', refreshCurrentRow));

        const prevBtn = new Gtk.Button({
            icon_name: 'media-skip-backward-symbolic',
            tooltip_text: _('Previous wallpaper'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        prevBtn.connect('clicked', () => settings.set_int('change-trigger', 1));
        currentRow.add_suffix(prevBtn);

        const pauseBtn = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
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
        pauseBtn.connect('clicked', () =>
            settings.set_boolean('paused', !settings.get_boolean('paused')));
        currentRow.add_suffix(pauseBtn);

        const nextBtn = new Gtk.Button({
            icon_name: 'media-skip-forward-symbolic',
            tooltip_text: _('Next wallpaper'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        nextBtn.connect('clicked', () => settings.set_int('change-trigger', 2));
        currentRow.add_suffix(nextBtn);

        group.add(currentRow);
        return group;
    }

    _buildAboutGroup() {
        const url = this.metadata.url;
        if (!url)
            return null;

        const group = new Adw.PreferencesGroup({title: _('About')});

        const row = new Adw.ActionRow({
            title: _('Source code'),
            subtitle: url,
            activatable: true,
        });

        const openIcon = new Gtk.Image({
            icon_name: 'web-browser-symbolic',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(openIcon);

        row.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri(url, null);
        });

        group.add(row);
        return group;
    }

    _pickFolder(parent, settings) {
        const dialog = new Gtk.FileDialog({
            title: _('Select wallpaper folder'),
            modal: true,
        });

        const current = settings.get_string('directory');
        if (current) {
            const initial = Gio.File.new_for_path(current);
            if (initial.query_exists(null))
                dialog.set_initial_folder(initial);
        }

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

// Copyright (C) 2026 Jeff Shee <jeffshee8969@gmail.com> and contributors
// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {feedsDir, thumbnailPath} from './paths.js';

interface PrefsWindow extends Adw.PreferencesWindow {
    settings: Gio.Settings;
}

// 16:9 to match the source previews exactly, so nothing is letterboxed.
// Sized so three tiles plus spacing fit inside the ~576px preferences clamp.
const LIBRARY_THUMB_WIDTH = 152;
const LIBRARY_THUMB_HEIGHT = 86;
const LIBRARY_COLUMNS = 3;
// Keeps a long clip title from widening its tile past the thumbnail.
const LIBRARY_TITLE_CHARS = 14;

// Gtk.Picture reports the image's own resolution as its natural size, and a
// homogeneous FlowBox sizes every cell to the widest natural width, so a 320px
// preview would force one tile per line. Pin the size instead.
const LibraryThumbnail = GObject.registerClass(
    {GTypeName: 'AerialLibraryThumbnail'},
    class LibraryThumbnail extends Gtk.Picture {
        vfunc_measure(orientation: Gtk.Orientation, _forSize: number): [number, number, number, number] {
            const size = orientation === Gtk.Orientation.HORIZONTAL
                ? LIBRARY_THUMB_WIDTH
                : LIBRARY_THUMB_HEIGHT;
            return [size, size, -1, -1];
        }
    }
);

export default class AerialExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const win = window as PrefsWindow;
        win.settings = this.getSettings();
        win.set_default_size(720, 640);

        window.add(this.buildPlaybackPage(win));
        window.add(this.buildSourcesPage(win));
        window.add(this.buildLibraryPage(win));
        window.add(this.buildBehaviorPage(win));
        window.add(this.buildAdvancedPage(win));
        return Promise.resolve();
    }

    private buildPlaybackPage(win: PrefsWindow): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Playback'),
            icon_name: 'media-playback-start-symbolic',
        });
        const group = new Adw.PreferencesGroup({title: _('Playback')});
        page.add(group);

        prefsRowBoolean(win, group, _('Enabled'), 'enabled',
            _('Stream aerials as the live wallpaper'));
        prefsRowQuality(win, group);
        prefsRowInt(win, group, _('Max seconds on screen'), 'max-play-seconds',
            _('0 = play each clip to the end'), 0, 600, 15, 30);
        prefsRowInt(win, group, _('Crossfade (ms)'), 'crossfade-ms',
            _('Opacity blend between clips'), 50, 5000, 50, 100);
        prefsRowInt(win, group, _('Prefetch lead (seconds)'), 'prefetch-lead-seconds',
            _('Start buffering the next clip this many seconds early'), 2, 60, 1, 5);
        prefsRowBoolean(win, group, _('Mute Audio'), 'mute', '');
        prefsRowInt(win, group, _('Volume Level'), 'volume', '', 0, 100, 1, 10);
        prefsRowFitMode(win, group);
        return page;
    }

    private buildSourcesPage(win: PrefsWindow): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Sources'),
            icon_name: 'folder-download-symbolic',
        });
        const catalogs = new Adw.PreferencesGroup({title: _('Catalogs')});
        page.add(catalogs);

        for (const id of ['apple', 'jetson', 'robin']) {
            const row = new Adw.SwitchRow({
                title: id.charAt(0).toUpperCase() + id.slice(1),
            });
            row.set_active(win.settings.get_strv('catalogs').includes(id));
            row.connect('notify::active', () => {
                const list = new Set(win.settings.get_strv('catalogs'));
                if (row.active)
                    list.add(id);
                else
                    list.delete(id);
                win.settings.set_strv('catalogs', [...list]);
            });
            catalogs.add(row);
        }

        const customGroup = new Adw.PreferencesGroup({title: _('Custom feeds')});
        page.add(customGroup);
        prefsRowCustomFeeds(win, customGroup);

        const refreshGroup = new Adw.PreferencesGroup();
        page.add(refreshGroup);
        prefsRowInt(win, refreshGroup, _('Refresh interval (hours)'), 'feed-refresh-hours',
            '', 1, 168, 1, 6);
        const refreshBtn = new Adw.ActionRow({title: _('Refresh manifests now')});
        const btn = new Gtk.Button({label: _('Refresh'), valign: Gtk.Align.CENTER});
        btn.connect('clicked', () => {
            try {
                Gio.DBus.session.call(
                    'com.michaeldmurray.AerialWallpapers',
                    '/com/michaeldmurray/AerialWallpapers',
                    'com.michaeldmurray.AerialWallpapers',
                    'refreshFeeds',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null
                );
            } catch (e) {
                console.warn(e);
            }
        });
        refreshBtn.add_suffix(btn);
        refreshGroup.add(refreshBtn);
        return page;
    }

    private buildLibraryPage(win: PrefsWindow): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Library'),
            icon_name: 'view-grid-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Clips'),
            description: _('Click a thumbnail to blacklist / restore a clip'),
        });
        page.add(group);

        const flow = new Gtk.FlowBox({
            // Drops to two columns rather than squeezing tiles on narrow windows.
            min_children_per_line: LIBRARY_COLUMNS - 1,
            max_children_per_line: LIBRARY_COLUMNS,
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            column_spacing: 12,
            row_spacing: 12,
            margin_top: 8,
            margin_bottom: 8,
        });
        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 360,
            vexpand: true,
            child: flow,
        });
        const row = new Adw.PreferencesRow();
        row.set_child(scroll);
        group.add(row);

        populateLibraryGrid(win, flow);
        return page;
    }

    private buildBehaviorPage(win: PrefsWindow): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Behavior'),
            icon_name: 'preferences-system-symbolic',
        });
        const autoPause = new Adw.PreferencesGroup({title: _('Auto Pause')});
        page.add(autoPause);
        prefsRowPauseOnMaximizeOrFullscreen(win, autoPause);
        prefsRowBoolean(win, autoPause, _('Pause on Window Focus'), 'pause-on-focus', '');
        prefsRowPauseOnBattery(win, autoPause);
        prefsRowInt(win, autoPause, _('Low Battery Threshold'), 'low-battery-threshold',
            '', 0, 100, 5, 10);
        prefsRowBoolean(win, autoPause, _('Pause on Media Player Playing'), 'pause-on-mpris-playing', '');

        const shell = new Adw.PreferencesGroup({title: _('Shell')});
        page.add(shell);
        prefsRowBoolean(win, shell, _('Show Panel Menu'), 'show-panel-menu', '');
        prefsRowBoolean(win, shell, _('Show on Lock Screen'), 'show-on-lock-screen', '');
        prefsRowInt(win, shell, _('Corner Radius'), 'corner-radius', '', 0, 100, 1, 5);
        prefsRowShortcut(win, shell);
        return page;
    }

    private buildAdvancedPage(win: PrefsWindow): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({
            title: _('Advanced'),
            icon_name: 'applications-engineering-symbolic',
        });
        const experimental = new Adw.PreferencesGroup({title: _('Decoders')});
        page.add(experimental);
        prefsRowBoolean(win, experimental, _('Experimental VA Plugin'), 'enable-va',
            _('Requires renderer restart'));
        prefsRowBoolean(win, experimental, _('NVIDIA Stateless Decoders'), 'enable-nvsl',
            _('Requires renderer restart'));

        const tls = new Adw.PreferencesGroup({
            title: _('TLS'),
            description: _('Apple CDN (sylvan.apple.com) omits an intermediate certificate. Video fetches for listed hosts disable strict TLS checks. Manifests and thumbnails always use strict verification.'),
        });
        page.add(tls);
        const hostsRow = new Adw.EntryRow({title: _('Insecure hosts (comma-separated)')});
        hostsRow.set_text(win.settings.get_strv('tls-insecure-hosts').join(', '));
        hostsRow.connect('apply', () => {
            const hosts = hostsRow.get_text()
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
            win.settings.set_strv('tls-insecure-hosts', hosts);
        });
        tls.add(hostsRow);

        const developer = new Adw.PreferencesGroup({title: _('Developer')});
        page.add(developer);
        prefsRowBoolean(win, developer, _('Debug Mode'), 'debug-mode', '');
        prefsRowBoolean(win, developer, _('Prefer clappersink'), 'prefer-clappersink',
            _('Requires renderer restart'));
        prefsRowBoolean(win, developer, _('Force GtkMediaFile'), 'force-mediafile',
            _('Not supported for dual-pipeline crossfade'));
        prefsRowBoolean(win, developer, _('Enable Graphics Offload'), 'enable-graphics-offload',
            _('Requires renderer restart'));
        prefsRowInt(win, developer, _('Startup Delay'), 'startup-delay', '', 0, 10000, 100, 500);
        prefsRowInt(win, developer, _('Border Stroke'), 'border-stroke', '', 0, 20, 1, 1);
        return page;
    }
}

function prefsRowBoolean(
    win: PrefsWindow,
    group: Adw.PreferencesGroup,
    title: string,
    key: string,
    subtitle: string
): void {
    const row = new Adw.SwitchRow({title, subtitle});
    win.settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function prefsRowInt(
    win: PrefsWindow,
    group: Adw.PreferencesGroup,
    title: string,
    key: string,
    subtitle: string,
    lower: number,
    upper: number,
    step: number,
    page: number
): void {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: page,
        }),
    });
    win.settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function prefsRowQuality(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const values = ['url-4K-SDR', 'url-1080-SDR', 'url-1080-H264'];
    const labels = [_('4K SDR'), _('1080p SDR'), _('1080p H.264')];
    const row = new Adw.ComboRow({
        title: _('Resolution'),
        model: new Gtk.StringList({strings: labels}),
    });
    const current = win.settings.get_string('quality');
    row.selected = Math.max(0, values.indexOf(current));
    row.connect('notify::selected', () => {
        win.settings.set_string('quality', values[row.selected] ?? values[0]);
    });
    group.add(row);
}

function prefsRowFitMode(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const labels = [_('Fill'), _('Contain'), _('Cover'), _('Scale Down')];
    const row = new Adw.ComboRow({
        title: _('Content Fit'),
        model: new Gtk.StringList({strings: labels}),
    });
    row.selected = win.settings.get_int('content-fit');
    row.connect('notify::selected', () => {
        win.settings.set_int('content-fit', row.selected);
    });
    group.add(row);
}

function prefsRowPauseOnMaximizeOrFullscreen(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const labels = [_('Never'), _('Maximize or fullscreen'), _('Fullscreen only')];
    const row = new Adw.ComboRow({
        title: _('Pause on Maximize or Fullscreen'),
        model: new Gtk.StringList({strings: labels}),
    });
    row.selected = win.settings.get_int('pause-on-maximize-or-fullscreen');
    row.connect('notify::selected', () => {
        win.settings.set_int('pause-on-maximize-or-fullscreen', row.selected);
    });
    group.add(row);
}

function prefsRowPauseOnBattery(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const labels = [_('Never'), _('On battery'), _('Low battery')];
    const row = new Adw.ComboRow({
        title: _('Pause on Battery'),
        model: new Gtk.StringList({strings: labels}),
    });
    row.selected = win.settings.get_int('pause-on-battery');
    row.connect('notify::selected', () => {
        win.settings.set_int('pause-on-battery', row.selected);
    });
    group.add(row);
}

function prefsRowShortcut(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const row = new Adw.ActionRow({
        title: _('Open Picker Shortcut'),
        subtitle: _('Click to set a new shortcut'),
        activatable: true,
    });

    const label = new Gtk.ShortcutLabel({
        disabled_text: _('Disabled'),
        valign: Gtk.Align.CENTER,
        accelerator: win.settings.get_strv('open-picker')[0] ?? '',
    });
    row.add_suffix(label);

    const clear = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Clear shortcut'),
        css_classes: ['flat'],
    });
    clear.connect('clicked', () => win.settings.set_strv('open-picker', []));
    row.add_suffix(clear);

    win.settings.connect('changed::open-picker', () => {
        label.accelerator = win.settings.get_strv('open-picker')[0] ?? '';
    });

    row.connect('activated', () => captureShortcut(win));
    group.add(row);
}

/**
 * Grab the keyboard and store the next valid accelerator pressed.
 *
 * @param {PrefsWindow} win - preferences window to attach the dialog to
 */
function captureShortcut(win: PrefsWindow): void {
    const dialog = new Adw.Window({
        modal: true,
        transient_for: win,
        default_width: 450,
        title: _('Set Shortcut'),
        resizable: false,
    });

    // Adw.StatusPage wants far more room than a small dialog gives it, so lay
    // the prompt out directly instead of having its icon crowd out the text.
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 24,
        margin_end: 24,
        valign: Gtk.Align.CENTER,
    });
    const heading = new Gtk.Label({
        label: _('Press a key combination'),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ['title-2'],
    });
    const hint = new Gtk.Label({
        label: _('Esc to cancel, Backspace to clear'),
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ['dim-label'],
    });
    content.append(heading);
    content.append(hint);

    const toolbar = new Adw.ToolbarView({content});
    toolbar.add_top_bar(new Adw.HeaderBar({show_end_title_buttons: true}));
    dialog.set_content(toolbar);

    const controller = new Gtk.EventControllerKey();
    controller.connect('key-pressed', (_c, keyval: number, _code: number, state: number) => {
        const mask = state & Gtk.accelerator_get_default_mod_mask();

        if (keyval === Gdk.KEY_Escape && mask === 0) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_BackSpace && mask === 0) {
            win.settings.set_strv('open-picker', []);
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        // A bare key would swallow normal typing, so require a modifier.
        if (mask === 0 || !Gtk.accelerator_valid(keyval, mask))
            return Gdk.EVENT_STOP;

        win.settings.set_strv('open-picker', [
            Gtk.accelerator_name(keyval, mask),
        ]);
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(controller);
    dialog.present();
}

function prefsRowCustomFeeds(win: PrefsWindow, group: Adw.PreferencesGroup): void {
    const nameRow = new Adw.EntryRow({title: _('Name')});
    const urlRow = new Adw.EntryRow({title: _('Manifest URL')});
    const addRow = new Adw.ActionRow({title: _('Add custom feed')});
    const addBtn = new Gtk.Button({label: _('Add'), valign: Gtk.Align.CENTER});
    addBtn.connect('clicked', () => {
        const name = nameRow.get_text().trim() || 'Custom';
        const url = urlRow.get_text().trim();
        if (!url.startsWith('http'))
            return;
        let feeds: {id: string; name: string; url: string; file: string; enabled: boolean}[] = [];
        try {
            feeds = JSON.parse(win.settings.get_string('custom-feeds') || '[]');
        } catch {
            feeds = [];
        }
        const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Math.random().toString(16).slice(2, 8)}`;
        const file = `custom-${id}.json`;
        feeds.push({id, name, url, file, enabled: true});
        win.settings.set_string('custom-feeds', JSON.stringify(feeds));
        const catalogs = win.settings.get_strv('catalogs');
        if (!catalogs.includes(id))
            win.settings.set_strv('catalogs', [...catalogs, id]);
        nameRow.set_text('');
        urlRow.set_text('');
    });
    addRow.add_suffix(addBtn);
    group.add(nameRow);
    group.add(urlRow);
    group.add(addRow);

    try {
        const feeds = JSON.parse(win.settings.get_string('custom-feeds') || '[]') as {
            id: string;
            name: string;
            url: string;
            file: string;
        }[];
        for (const feed of feeds) {
            const row = new Adw.ActionRow({title: feed.name, subtitle: feed.url});
            const remove = new Gtk.Button({
                label: _('Remove'),
                valign: Gtk.Align.CENTER,
            });
            remove.connect('clicked', () => {
                const next = feeds.filter(f => f.id !== feed.id);
                win.settings.set_string('custom-feeds', JSON.stringify(next));
                win.settings.set_strv(
                    'catalogs',
                    win.settings.get_strv('catalogs').filter(c => c !== feed.id)
                );
                group.remove(row);
            });
            row.add_suffix(remove);
            group.add(row);
        }
    } catch {
        /* ignore */
    }
}

function populateLibraryGrid(win: PrefsWindow, flow: Gtk.FlowBox): void {
    const feeds = feedsDir();
    const blacklist = new Set(win.settings.get_strv('blacklist'));
    const catalogs = new Set(win.settings.get_strv('catalogs'));
    const dir = Gio.File.new_for_path(feeds);
    if (!dir.query_exists(null)) {
        flow.append(new Gtk.Label({
            label: _('No feeds cached yet — enable the extension to download manifests.'),
            wrap: true,
        }));
        return;
    }

    const items: {id: string; title: string; catalog: string}[] = [];
    const seen = new Set<string>();
    const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info: Gio.FileInfo | null;
    while ((info = enumerator.next_file(null))) {
        const name = info.get_name();
        if (!name?.endsWith('.json'))
            continue;
        const catalog = name.replace(/\.json$/, '');
        if (!catalogs.has(catalog) && !['apple', 'jetson', 'robin'].includes(catalog))
            continue;
        if (['apple', 'jetson', 'robin'].includes(catalog) && !catalogs.has(catalog))
            continue;
        try {
            const [, bytes] = Gio.File.new_for_path(
                GLib.build_filenamev([feeds, name])
            ).load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            const assets = Array.isArray(data) ? data : data.assets || [];
            for (const a of assets) {
                const id = String(a.id || '');
                if (!id || seen.has(id) || a.includeInShuffle === false)
                    continue;
                seen.add(id);
                items.push({
                    id,
                    title: String(a.accessibilityLabel || a.title || id),
                    catalog,
                });
            }
        } catch {
            /* ignore */
        }
    }
    items.sort((a, b) => a.title.localeCompare(b.title));

    for (const item of items) {
        const btn = new Gtk.Button({tooltip_text: item.title});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            // Evens out the button's own padding against the title's trailing
            // line spacing, so a tile looks equally inset top and bottom.
            margin_top: 4,
            margin_bottom: 2,
        });
        const thumb = thumbnailPath(item.id);
        const picture = new LibraryThumbnail();
        if (Gio.File.new_for_path(thumb).query_exists(null))
            picture.set_filename(thumb);
        picture.content_fit = Gtk.ContentFit.CONTAIN;
        picture.halign = Gtk.Align.CENTER;
        picture.valign = Gtk.Align.CENTER;
        picture.add_css_class('card');
        // A single line keeps every tile the same height, which is what keeps the
        // thumbnails aligned across a row. The tooltip carries the full title.
        const label = new Gtk.Label({
            label: item.title,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: LIBRARY_TITLE_CHARS,
        });
        box.append(picture);
        box.append(label);
        btn.set_child(box);
        if (blacklist.has(item.id))
            btn.add_css_class('dim-label');

        btn.connect('clicked', () => {
            const list = win.settings.get_strv('blacklist');
            const idx = list.indexOf(item.id);
            if (idx >= 0) {
                list.splice(idx, 1);
                btn.remove_css_class('dim-label');
            } else {
                list.push(item.id);
                btn.add_css_class('dim-label');
            }
            win.settings.set_strv('blacklist', list);
        });
        flow.append(btn);
    }
}

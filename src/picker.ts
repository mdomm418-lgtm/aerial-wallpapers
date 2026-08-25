// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {RendererWrapper} from './dbus.js';
import {feedsDir} from './paths.js';
import {makeThumbnailBin, setThumbnail} from './thumbnail.js';

const MAX_RESULTS = 300;
const THUMB_WIDTH = 144;
const THUMB_HEIGHT = 81;
const ROW_STYLE = 'padding: 6px; border-radius: 8px;';
const ROW_STYLE_SELECTED =
    'padding: 6px; border-radius: 8px; background-color: rgba(255,255,255,0.16);';

interface ClipItem {
    id: string;
    title: string;
    catalog: string;
    blacklisted: boolean;
}

interface Row {
    button: St.Button;
    item: ClipItem;
}

/**
 * Searchable clip picker. Type to filter, arrow keys to move, Enter to play.
 */
export class AerialPicker {
    private settings: Gio.Settings;
    private renderer = new RendererWrapper();
    private dialog: ModalDialog.ModalDialog | null = null;
    private rows: Row[] = [];
    private selected = 0;
    private scroll: St.ScrollView | null = null;

    constructor(settings: Gio.Settings) {
        this.settings = settings;
    }

    open(): void {
        this.close();

        const items = this.loadLibrary();
        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'aerial-picker-dialog',
        });
        this.dialog = dialog;

        const box = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 10px; padding: 10px; width: 720px;',
        });

        const entry = new St.Entry({
            hint_text: _('Search aerials…'),
            can_focus: true,
        });
        box.add_child(entry);

        const count = new St.Label({
            style: 'font-size: 0.85em; padding-left: 4px;',
            opacity: 160,
        });
        box.add_child(count);

        const scroll = new St.ScrollView({
            style: 'max-height: 520px;',
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        });
        this.scroll = scroll;
        const list = new St.BoxLayout({vertical: true, style: 'spacing: 2px;'});
        scroll.set_child(list);
        box.add_child(scroll);

        const activate = (item: ClipItem) => {
            this.renderer.playClip(item.id);
            this.close();
        };

        const rebuild = () => {
            list.destroy_all_children();
            this.rows = [];

            const query = (entry.get_text() || '').trim().toLowerCase();
            const filtered = items
                .filter(item => !item.blacklisted)
                .filter(item => {
                    if (!query)
                        return true;
                    return (
                        item.title.toLowerCase().includes(query) ||
                        item.catalog.toLowerCase().includes(query)
                    );
                })
                .slice(0, MAX_RESULTS);

            count.text =
                filtered.length === 1
                    ? _('1 clip')
                    : `${filtered.length} ${_('clips')}`;

            for (const item of filtered) {
                const button = new St.Button({
                    style: ROW_STYLE,
                    x_expand: true,
                    can_focus: false,
                });
                button.set_child(this.buildRow(item));
                button.connect('clicked', () => activate(item));
                button.connect('notify::hover', () => {
                    if (button.hover)
                        this.select(this.rows.findIndex(r => r.button === button));
                });
                list.add_child(button);
                this.rows.push({button, item});
            }

            if (!filtered.length) {
                list.add_child(
                    new St.Label({
                        text: _('No clips match'),
                        style: 'padding: 12px;',
                    })
                );
            }

            // New result set: start at the top, since the rows are not laid out
            // yet and scrollTo() cannot correct the old offset.
            const adjustment = scroll.get_vadjustment?.();
            if (adjustment)
                adjustment.value = adjustment.lower;
            this.select(0);
        };

        entry.clutter_text.connect('text-changed', () => rebuild());
        entry.clutter_text.connect(
            'key-press-event',
            (_actor: Clutter.Actor, event: Clutter.Event) => {
                const symbol = event.get_key_symbol();
                switch (symbol) {
                case Clutter.KEY_Down:
                    this.select(this.selected + 1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Up:
                    this.select(this.selected - 1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Page_Down:
                    this.select(this.selected + 8);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Page_Up:
                    this.select(this.selected - 8);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Home:
                    this.select(0);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_End:
                    this.select(this.rows.length - 1);
                    return Clutter.EVENT_STOP;
                case Clutter.KEY_Return:
                case Clutter.KEY_KP_Enter:
                case Clutter.KEY_ISO_Enter: {
                    const row = this.rows[this.selected];
                    if (row)
                        activate(row.item);
                    return Clutter.EVENT_STOP;
                }
                default:
                    return Clutter.EVENT_PROPAGATE;
                }
            }
        );

        rebuild();

        dialog.contentLayout.add_child(box);
        dialog.setButtons([
            {
                label: _('Close'),
                action: () => this.close(),
                key: Clutter.KEY_Escape,
            },
        ]);
        dialog.open();
        global.stage.set_key_focus(entry.clutter_text);
    }

    close(): void {
        this.rows = [];
        this.scroll = null;
        if (this.dialog) {
            this.dialog.close();
            this.dialog = null;
        }
    }

    private buildRow(item: ClipItem): St.BoxLayout {
        // The box must fill the button, otherwise St centres it and every
        // thumbnail sits at a different x depending on the title's length.
        const row = new St.BoxLayout({
            style: 'spacing: 12px;',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const thumb = makeThumbnailBin(THUMB_WIDTH, THUMB_HEIGHT);
        setThumbnail(thumb, item.id, THUMB_WIDTH, THUMB_HEIGHT);
        row.add_child(thumb);

        const text = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            style: 'spacing: 2px;',
        });
        text.add_child(
            new St.Label({
                text: item.title,
                x_align: Clutter.ActorAlign.START,
            })
        );
        text.add_child(
            new St.Label({
                text: item.catalog,
                style: 'font-size: 0.8em;',
                opacity: 140,
                x_align: Clutter.ActorAlign.START,
            })
        );
        row.add_child(text);
        return row;
    }

    private select(index: number): void {
        if (!this.rows.length) {
            this.selected = 0;
            return;
        }
        const next = Math.max(0, Math.min(this.rows.length - 1, index));
        this.rows.forEach((row, i) =>
            row.button.set_style(i === next ? ROW_STYLE_SELECTED : ROW_STYLE)
        );
        this.selected = next;
        this.scrollTo(this.rows[next].button);
    }

    private scrollTo(button: St.Button): void {
        const adjustment = this.scroll?.get_vadjustment?.();
        if (!adjustment)
            return;

        // The allocation is relative to the list, so it is already in content
        // coordinates. Transformed positions lag a scroll by one layout cycle,
        // which made each scroll compound the previous one.
        const box = button.get_allocation_box();
        const top = box.y1;
        const height = box.y2 - box.y1;
        const page = adjustment.page_size;
        if (height <= 0 || page <= 0)
            return;

        let value = adjustment.value;
        if (top < value)
            value = top;
        else if (top + height > value + page)
            value = top + height - page;

        const max = Math.max(adjustment.lower, adjustment.upper - page);
        adjustment.value = Math.min(max, Math.max(adjustment.lower, value));
    }

    private loadLibrary(): ClipItem[] {
        const dir = feedsDir();
        const blacklist = new Set(this.settings.get_strv('blacklist'));
        const catalogs = new Set(this.settings.get_strv('catalogs'));
        const customIds = this.customFileToId();
        const items: ClipItem[] = [];
        const seen = new Set<string>();

        const feeds = Gio.File.new_for_path(dir);
        if (!feeds.query_exists(null))
            return items;

        const enumerator = feeds.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        let info: Gio.FileInfo | null;
        while ((info = enumerator.next_file(null))) {
            const name = info.get_name();
            if (!name?.endsWith('.json'))
                continue;
            const catalog = customIds.get(name) ?? name.replace(/\.json$/, '');
            if (!catalogs.has(catalog))
                continue;

            try {
                const [, bytes] = Gio.File.new_for_path(
                    GLib.build_filenamev([dir, name])
                ).load_contents(null);
                const data = JSON.parse(new TextDecoder().decode(bytes));
                const assets = Array.isArray(data) ? data : data.assets || [];
                for (const asset of assets) {
                    const id = String(asset.id || '');
                    if (!id || seen.has(id) || asset.includeInShuffle === false)
                        continue;
                    seen.add(id);
                    items.push({
                        id,
                        title: String(
                            asset.accessibilityLabel || asset.title || id
                        ),
                        catalog,
                        blacklisted: blacklist.has(id),
                    });
                }
            } catch (e) {
                console.debug(`picker load ${name}: ${e}`);
            }
        }

        items.sort((a, b) => a.title.localeCompare(b.title));
        return items;
    }

    private customFileToId(): Map<string, string> {
        const map = new Map<string, string>();
        try {
            const custom = JSON.parse(
                this.settings.get_string('custom-feeds') || '[]'
            ) as {id: string; file: string; enabled?: boolean}[];
            for (const feed of custom) {
                if (feed.enabled !== false)
                    map.set(feed.file, feed.id);
            }
        } catch {
            /* malformed setting */
        }
        return map;
    }
}

// Copyright (C) 2026 Jeff Shee <jeffshee8969@gmail.com> and contributors
// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {RendererWrapper} from './dbus.js';
import {makeThumbnailBin, setThumbnail} from './thumbnail.js';
import type {PlaybackState} from './playbackState.js';
import type AerialExtension from './extension.js';

const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 135;

export class AerialPanelMenu {
    isEnabled = false;
    private extension: AerialExtension;
    private settings: Gio.Settings;
    private playbackState: PlaybackState;
    private isPlaying = false;
    private renderer = new RendererWrapper();
    private isPlayingChangedSubId: number | null = null;
    private currentClipChangedSubId: number | null = null;
    private muteChangedId: number | null = null;
    private enabledChangedId: number | null = null;
    private currentTitle: St.Label | null = null;
    private currentThumb: St.Bin | null = null;
    private currentJson = '';
    indicator!: PanelMenu.Button;

    constructor(extension: AerialExtension) {
        this.extension = extension;
        this.settings = extension.getSettings();
        this.playbackState = extension.getPlaybackState();
    }

    enable(): void {
        if (this.isEnabled)
            return;

        const indicatorName = `${this.extension.metadata.name} Indicator`;
        this.indicator = new PanelMenu.Button(0.0, indicatorName, false);
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([this.extension.path, 'aerial-symbolic.svg'])
            ),
            style_class: 'system-status-icon',
        });
        this.indicator.add_child(icon);

        const menu = new PopupMenu.PopupMenu(
            this.indicator,
            0.5,
            St.Side.BOTTOM
        );
        this.indicator.setMenu(menu);
        Main.panel.addToStatusArea(indicatorName, this.indicator);

        menu.addMenuItem(this.buildCurrentClipItem());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.refreshCurrentClip();

        // Previews are converted in the background, so re-check on open. The
        // signal stays authoritative for the clip itself.
        menu.connect('open-state-changed', (_menu: PopupMenu.PopupMenu, open: boolean) => {
            if (open)
                this.setCurrentClipFromJson(this.currentJson || this.renderer.getCurrentClipJson());
            return Clutter.EVENT_PROPAGATE;
        });

        const playPause = new PopupMenu.PopupMenuItem(
            this.settings.get_boolean('enabled') ? _('Pause Aerials') : _('Play Aerials')
        );
        playPause.connect('activate', () => {
            const enabled = this.settings.get_boolean('enabled');
            this.settings.set_boolean('enabled', !enabled);
        });
        this.enabledChangedId = this.settings.connect('changed::enabled', () => {
            playPause.label.set_text(
                this.settings.get_boolean('enabled') ? _('Pause Aerials') : _('Play Aerials')
            );
        });
        menu.addMenuItem(playPause);

        this.isPlayingChangedSubId = this.renderer.proxy.connectSignal(
            'isPlayingChanged',
            (_proxy: Gio.DBusProxy, _sender: string, [isPlaying]: [boolean]) => {
                this.isPlaying = isPlaying;
            }
        );

        this.currentClipChangedSubId = this.renderer.proxy.connectSignal(
            'currentClipChanged',
            (_proxy: Gio.DBusProxy, _sender: string, [json]: [string]) => {
                this.setCurrentClipFromJson(json);
            }
        );

        const muteAudio = new PopupMenu.PopupMenuItem(
            this.getMute() ? _('Unmute Audio') : _('Mute Audio')
        );
        muteAudio.connect('activate', () => this.setMute(!this.getMute()));
        this.muteChangedId = this.settings.connect('changed::mute', () => {
            muteAudio.label.set_text(
                this.getMute() ? _('Unmute Audio') : _('Mute Audio')
            );
        });
        menu.addMenuItem(muteAudio);

        menu.addAction(_('Next Clip'), () => {
            this.renderer.nextClip();
        });

        menu.addAction(_('Block This Clip'), () => {
            const id = this.currentId();
            if (id)
                this.renderer.blockClip(id);
        });

        menu.addAction(_('Pick Clip…'), () => {
            this.extension.openPicker();
        });

        menu.addAction(_('Preferences'), () => {
            this.extension.openPreferences();
        });

        this.isEnabled = true;
    }

    /** Preview of the playing clip with its title underneath. */
    private buildCurrentClipItem(): PopupMenu.PopupBaseMenuItem {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 8px;',
        });

        this.currentThumb = makeThumbnailBin(PREVIEW_WIDTH, PREVIEW_HEIGHT);
        this.currentThumb.visible = false;
        box.add_child(this.currentThumb);

        this.currentTitle = new St.Label({
            text: _('Loading…'),
            style: `font-weight: bold; max-width: ${PREVIEW_WIDTH}px;`,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.currentTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this.currentTitle);

        item.add_child(box);
        return item;
    }

    private refreshCurrentClip(): void {
        this.setCurrentClipFromJson(this.renderer.getCurrentClipJson());
    }

    private setCurrentClipFromJson(json: string): void {
        if (!this.currentTitle)
            return;
        this.currentJson = json;

        let title = _('Aerial');
        let id = '';
        if (!json) {
            title = _('No clip');
        } else {
            try {
                const clip = JSON.parse(json) as {title?: string; id?: string};
                title = clip.title || title;
                id = clip.id ?? '';
            } catch {
                /* keep the generic title */
            }
        }

        this.currentTitle.set_text(title);
        this.setPreview(id);
    }

    /**
     * @param {string} id - asset id, or empty when nothing is playing
     */
    private setPreview(id: string): void {
        if (!this.currentThumb)
            return;
        this.currentThumb.visible = setThumbnail(
            this.currentThumb,
            id,
            PREVIEW_WIDTH,
            PREVIEW_HEIGHT
        );
    }

    private currentId(): string | null {
        try {
            const json = this.renderer.getCurrentClipJson();
            if (!json)
                return null;
            const clip = JSON.parse(json) as {id?: string};
            return clip.id || null;
        } catch {
            return null;
        }
    }

    private getMute(): boolean {
        return this.settings.get_boolean('mute');
    }

    private setMute(mute: boolean): boolean {
        return this.settings.set_boolean('mute', mute);
    }

    disable(): void {
        if (!this.isEnabled)
            return;

        if (this.isPlayingChangedSubId !== null) {
            this.renderer.proxy.disconnectSignal(this.isPlayingChangedSubId);
            this.isPlayingChangedSubId = null;
        }
        if (this.currentClipChangedSubId !== null) {
            this.renderer.proxy.disconnectSignal(this.currentClipChangedSubId);
            this.currentClipChangedSubId = null;
        }
        if (this.muteChangedId !== null) {
            this.settings.disconnect(this.muteChangedId);
            this.muteChangedId = null;
        }
        if (this.enabledChangedId !== null) {
            this.settings.disconnect(this.enabledChangedId);
            this.enabledChangedId = null;
        }

        this.indicator.destroy();
        this.isEnabled = false;
    }
}

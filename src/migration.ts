// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * One-shot import of ~/.local/share/aerial-wallpaper/config.json into GSettings.
 *
 * @param {Gio.Settings} settings - extension settings to populate
 */
export function migrateFromProxyConfig(settings: Gio.Settings): void {
    if (settings.get_boolean('migrated-from-proxy'))
        return;

    const path = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'aerial-wallpaper',
        'config.json',
    ]);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null)) {
        settings.set_boolean('migrated-from-proxy', true);
        return;
    }

    try {
        const [, bytes] = file.load_contents(null);
        const cfg = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

        if (typeof cfg.enabled === 'boolean')
            settings.set_boolean('enabled', cfg.enabled);
        if (typeof cfg.quality === 'string')
            settings.set_string('quality', cfg.quality);
        if (typeof cfg.mute === 'boolean')
            settings.set_boolean('mute', cfg.mute);
        if (typeof cfg.max_play_seconds === 'number')
            settings.set_int('max-play-seconds', Math.max(0, cfg.max_play_seconds));
        if (typeof cfg.fade_out_ms === 'number' && typeof cfg.fade_in_ms === 'number') {
            const ms = Math.round((Number(cfg.fade_out_ms) + Number(cfg.fade_in_ms)) / 2);
            settings.set_int('crossfade-ms', Math.min(5000, Math.max(50, ms)));
        } else if (typeof cfg.fade_out_ms === 'number') {
            settings.set_int('crossfade-ms', Math.min(5000, Math.max(50, Number(cfg.fade_out_ms))));
        }

        if (cfg.catalogs && typeof cfg.catalogs === 'object') {
            const enabled = Object.entries(cfg.catalogs as Record<string, unknown>)
                .filter(([, v]) => Boolean(v))
                .map(([k]) => k);
            if (enabled.length)
                settings.set_strv('catalogs', enabled);
        }

        if (Array.isArray(cfg.blacklist))
            settings.set_strv('blacklist', cfg.blacklist.map(String));

        if (Array.isArray(cfg.custom_feeds))
            settings.set_string('custom-feeds', JSON.stringify(cfg.custom_feeds));

        console.log('Aerial: migrated settings from aerial-wallpaper/config.json');
    } catch (e) {
        console.warn(`Aerial: migration failed: ${e}`);
    }

    settings.set_boolean('migrated-from-proxy', true);
}

// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {thumbnailPath} from './paths.js';

/**
 * Fixed-size holder for a clip preview. The placeholder background stays
 * visible until (or unless) an image loads, so rows never collapse.
 *
 * @param {number} width - box width in logical pixels
 * @param {number} height - box height in logical pixels
 * @returns {St.Bin} the holder to pass to setThumbnail()
 */
export function makeThumbnailBin(width: number, height: number): St.Bin {
    return new St.Bin({
        style: `width: ${width}px; height: ${height}px; border-radius: 6px; background-color: rgba(255,255,255,0.08);`,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
}

/**
 * Show a clip's cached preview in a holder, or clear it when unavailable.
 *
 * @param {St.Bin} bin - holder from makeThumbnailBin()
 * @param {string} id - asset id, or empty to clear
 * @param {number} width - box width in logical pixels
 * @param {number} height - box height in logical pixels
 * @returns {boolean} whether a preview was loaded
 */
export function setThumbnail(
    bin: St.Bin,
    id: string,
    width: number,
    height: number
): boolean {
    bin.get_child()?.destroy();

    if (!id)
        return false;
    const file = Gio.File.new_for_path(thumbnailPath(id));
    if (!file.query_exists(null))
        return false;

    const scale =
        St.ThemeContext.get_for_stage(global.stage as Clutter.Stage)
            .scale_factor || 1;
    try {
        const actor = St.TextureCache.get_default().load_file_async(
            file,
            width,
            height,
            scale,
            1.0
        );
        bin.set_child(actor);
        return true;
    } catch (e) {
        console.warn(`Aerial: texture cache rejected ${id}: ${e}`);
    }

    // Older/newer St may disagree on load_file_async; a file-backed gicon is
    // handled by the same texture cache and is good enough as a fallback.
    try {
        bin.set_child(
            new St.Icon({
                gicon: Gio.FileIcon.new(file),
                icon_size: width,
            })
        );
        return true;
    } catch (e) {
        console.warn(`Aerial: cannot render thumbnail ${id}: ${e}`);
        return false;
    }
}

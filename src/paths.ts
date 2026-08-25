// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {EXTENSION_UUID} from './constants.js';

/** Cached feed manifests, written by the renderer. */
export function feedsDir(): string {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        EXTENSION_UUID,
        'feeds',
    ]);
}

/** PNG previews converted from the published WebP thumbnails. */
export function thumbnailsDir(): string {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        EXTENSION_UUID,
        'thumbnails',
    ]);
}

/**
 * @param {string} id - asset id
 * @returns {string} where that asset's cached preview lives
 */
export function thumbnailPath(id: string): string {
    return GLib.build_filenamev([thumbnailsDir(), `${id}.png`]);
}

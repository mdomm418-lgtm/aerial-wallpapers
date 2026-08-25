// Copyright (C) 2026 Jeff Shee <jeffshee8969@gmail.com> and contributors
// Copyright (C) 2026 Michael D. Murray and contributors
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The renderer's application id, D-Bus bus name, and D-Bus interface name.
// The extension matches renderer windows by checking the window title against
// this value, so the renderer and extension sides must use the exact same id.
export const APPLICATION_ID = 'com.michaeldmurray.AerialWallpapers';

// The renderer's D-Bus object path, derived from APPLICATION_ID.
export const RENDERER_OBJECT_PATH = `/${APPLICATION_ID.replaceAll('.', '/')}`;

export const SETTINGS_SCHEMA = 'com.michael-d-murray.aerial-wallpapers';

export const EXTENSION_UUID = 'aerial-wallpapers@michael-d-murray.com';

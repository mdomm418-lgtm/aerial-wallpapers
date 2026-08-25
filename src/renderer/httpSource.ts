// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gst from 'gi://Gst';

/**
 * GJS cannot handle playbin3 `source-setup` (streaming thread). Poll the
 * pipeline from the main loop and harden souphttpsrc instead.
 *
 * @param {Gst.Element} root - pipeline to search for HTTP sources
 * @param {string[]} insecureHosts - hosts allowed to skip TLS verification
 * @param {string} currentUri - URI currently being played
 * @returns {number} how many sources were configured
 */
export function configureHttpSources(
    root: Gst.Element,
    insecureHosts: string[],
    currentUri: string
): number {
    let configured = 0;
    const it = (root as Gst.Bin).iterate_recurse();
    if (!it)
        return 0;

    let host = '';
    try {
        host = GLib.Uri.parse(currentUri, GLib.UriFlags.NONE)?.get_host() ?? '';
    } catch {
        host = '';
    }
    const relaxTls = Boolean(host && insecureHosts.includes(host));

    for (;;) {
        const [ok, elUnknown] = it.next();
        if (ok !== Gst.IteratorResult.OK)
            break;
        const el = elUnknown as Gst.Element;
        const name = el.get_factory?.()?.get_name?.() ?? '';
        if (!String(name).includes('souphttp'))
            continue;
        try {
            if (relaxTls)
                el.set_property('ssl-strict', false);
            el.set_property('user-agent', 'AerialWallpapers/1.0');
            el.set_property('timeout', 30);
            el.set_property('retries', 3);
            el.set_property('keep-alive', true);
            configured++;
        } catch (e) {
            console.debug(`http source configure: ${e}`);
        }
    }
    return configured;
}

export function startHttpSourcePoll(
    getPipeline: () => Gst.Element | null,
    getUri: () => string,
    getHosts: () => string[],
    intervalMs = 15
): number {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
        const pipe = getPipeline();
        if (pipe)
            configureHttpSources(pipe, getHosts(), getUri());
        return GLib.SOURCE_CONTINUE;
    });
}

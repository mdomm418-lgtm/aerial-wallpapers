// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import Soup from 'gi://Soup?version=3.0';

import {AerialAsset, previewOf} from './types.js';
import {thumbnailPath, thumbnailsDir} from '../paths.js';

/**
 * The published thumbnails are WebP, which gdk-pixbuf usually cannot read, so
 * the renderer (which already links GStreamer) transcodes them to PNG once and
 * caches them for the Shell and the preferences window to load.
 */
export class ThumbnailCache {
    private session = new Soup.Session({timeout: 20});
    private warming = false;

    constructor() {
        GLib.mkdir_with_parents(thumbnailsDir(), 0o755);
    }

    /**
     * Fetch and convert any missing thumbnails, one at a time, in the background.
     *
     * @param {AerialAsset[]} assets - library entries to cache previews for
     * @returns {Promise<void>} resolves when the pass finishes
     */
    async warm(assets: AerialAsset[]): Promise<void> {
        if (this.warming)
            return;
        this.warming = true;
        let added = 0;
        try {
            for (const asset of assets) {
                const dest = thumbnailPath(asset.id);
                if (Gio.File.new_for_path(dest).query_exists(null))
                    continue;
                const url = previewOf(asset);
                if (!url)
                    continue;
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await this.fetchOne(url, dest);
                    added++;
                } catch (e) {
                    console.debug(`thumbnail ${asset.id}: ${e}`);
                }
            }
        } finally {
            this.warming = false;
        }
        if (added)
            console.log(`Thumbnails: cached ${added} new preview image(s)`);
    }

    private async fetchOne(url: string, dest: string): Promise<void> {
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error(`bad url ${url}`);

        const bytes = await new Promise<GLib.Bytes>((resolve, reject) => {
            this.session.send_and_read_async(
                message,
                GLib.PRIORITY_LOW,
                null,
                (_session, result) => {
                    try {
                        resolve(this.session.send_and_read_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()}`);
        const data = bytes?.get_data();
        if (!data?.length)
            throw new Error('empty body');

        const tmp = `${dest}.src`;
        Gio.File.new_for_path(tmp).replace_contents(
            data,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        try {
            await transcodeToPng(tmp, dest);
        } finally {
            try {
                Gio.File.new_for_path(tmp).delete(null);
            } catch {
                /* already gone */
            }
        }
    }
}

/**
 * Decode a still image with GStreamer and re-encode it as PNG.
 *
 * @param {string} src - path of the downloaded image
 * @param {string} dest - path to write the PNG to
 * @returns {Promise<void>} resolves once the file is written
 */
function transcodeToPng(src: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const tmpDest = `${dest}.part`;
        let pipeline: Gst.Element | null = null;
        try {
            pipeline = Gst.parse_launch(
                `filesrc location="${src}" ! decodebin ! videoconvert ! pngenc snapshot=true ! filesink location="${tmpDest}"`
            );
        } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
            return;
        }

        const bus = pipeline.get_bus();
        if (!bus) {
            reject(new Error('no bus'));
            return;
        }

        let timeoutId = 0;
        const finish = (error: Error | null) => {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            bus.set_flushing(true);
            pipeline?.set_state(Gst.State.NULL);
            if (error) {
                try {
                    Gio.File.new_for_path(tmpDest).delete(null);
                } catch {
                    /* nothing to clean */
                }
                reject(error);
                return;
            }
            try {
                Gio.File.new_for_path(tmpDest).move(
                    Gio.File.new_for_path(dest),
                    Gio.FileCopyFlags.OVERWRITE,
                    null,
                    null
                );
                resolve();
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        };

        // Polling the bus keeps everything on the main loop; a signal watch
        // would deliver messages from a streaming thread.
        timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, 20, () => {
            const msg = bus.pop_filtered(
                Gst.MessageType.EOS | Gst.MessageType.ERROR
            );
            if (!msg)
                return GLib.SOURCE_CONTINUE;
            timeoutId = 0;
            if (msg.type === Gst.MessageType.EOS)
                finish(null);
            else
                finish(new Error(msg.parse_error()[0]?.message ?? 'decode failed'));
            return GLib.SOURCE_REMOVE;
        });

        if (pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE)
            finish(new Error('pipeline failed to start'));
    });
}

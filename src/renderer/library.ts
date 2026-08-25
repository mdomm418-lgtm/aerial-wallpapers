// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {EXTENSION_UUID} from '../constants.js';
import {
    AerialAsset,
    BUILTIN_CATALOGS,
    CustomFeed,
    FEED_URLS,
    QualityKey,
    clipPublic,
} from './types.js';

function dataDir(): string {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        EXTENSION_UUID,
    ]);
}

function feedsDir(): string {
    return GLib.build_filenamev([dataDir(), 'feeds']);
}

function ensureDir(path: string): void {
    GLib.mkdir_with_parents(path, 0o755);
}

function readText(path: string): string | null {
    try {
        const file = Gio.File.new_for_path(path);
        const [, bytes] = file.load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function writeText(path: string, text: string): void {
    const file = Gio.File.new_for_path(path);
    const parent = file.get_parent();
    if (parent && !parent.query_exists(null))
        parent.make_directory_with_parents(null);
    const tmp = Gio.File.new_for_path(`${path}.tmp`);
    tmp.replace_contents(text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    tmp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
}

function parseAssets(raw: string, catalog: string): AerialAsset[] {
    const data = JSON.parse(raw) as unknown;
    let list: unknown[] = [];
    if (Array.isArray(data))
        list = data;
    else if (data && typeof data === 'object' && Array.isArray((data as {assets?: unknown}).assets))
        list = (data as {assets: unknown[]}).assets;
    else
        throw new Error(`Unrecognized feed shape for ${catalog}`);

    const out: AerialAsset[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object')
            continue;
        const a = item as Record<string, unknown>;
        const id = String(a.id || '');
        if (!id)
            continue;
        out.push({
            ...(a as AerialAsset),
            id,
            catalog,
        });
    }
    return out;
}

export class LibraryManager {
    private session: Soup.Session;
    private assets: AerialAsset[] = [];
    private lastFetch = 0;

    constructor() {
        this.session = new Soup.Session({timeout: 60});
        ensureDir(feedsDir());
    }

    getAssets(): AerialAsset[] {
        return this.assets;
    }

    getDataDir(): string {
        return dataDir();
    }

    getFeedsDir(): string {
        return feedsDir();
    }

    async refreshIfNeeded(
        refreshHours: number,
        catalogs: string[],
        customFeeds: CustomFeed[],
        force = false
    ): Promise<void> {
        const ageH = (GLib.get_real_time() / 1e6 - this.lastFetch) / 3600;
        const need =
            force ||
            this.assets.length === 0 ||
            this.lastFetch === 0 ||
            ageH >= refreshHours;
        if (need)
            await this.refresh(catalogs, customFeeds);
        else
            this.reloadFromDisk(catalogs, customFeeds);
    }

    async refresh(catalogs: string[], customFeeds: CustomFeed[]): Promise<void> {
        ensureDir(feedsDir());

        const jobs: Promise<void>[] = [];
        for (const name of BUILTIN_CATALOGS) {
            if (!catalogs.includes(name))
                continue;
            const dest = GLib.build_filenamev([feedsDir(), `${name}.json`]);
            jobs.push(
                this.fetchToFile(FEED_URLS[name], dest).catch(e =>
                    console.warn(`feed refresh ${name}: ${e}`)
                )
            );
        }
        for (const feed of customFeeds) {
            if (!feed.enabled || !catalogs.includes(feed.id))
                continue;
            const dest = GLib.build_filenamev([feedsDir(), feed.file]);
            jobs.push(
                this.fetchToFile(feed.url, dest).catch(e =>
                    console.warn(`custom feed refresh ${feed.id}: ${e}`)
                )
            );
        }

        await Promise.all(jobs);
        this.lastFetch = GLib.get_real_time() / 1e6;
        this.reloadFromDisk(catalogs, customFeeds);
    }

    reloadFromDisk(catalogs: string[], customFeeds: CustomFeed[]): void {
        const assets: AerialAsset[] = [];
        const seen = new Set<string>();

        const addFile = (path: string, catalog: string) => {
            if (!catalogs.includes(catalog))
                return;
            const text = readText(path);
            if (!text)
                return;
            try {
                for (const a of parseAssets(text, catalog)) {
                    if (a.includeInShuffle === false)
                        continue;
                    const key = a.id;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    assets.push(a);
                }
            } catch (e) {
                console.warn(`load ${path}: ${e}`);
            }
        };

        for (const name of BUILTIN_CATALOGS)
            addFile(GLib.build_filenamev([feedsDir(), `${name}.json`]), name);

        for (const feed of customFeeds) {
            if (!feed.enabled)
                continue;
            addFile(GLib.build_filenamev([feedsDir(), feed.file]), feed.id);
        }

        this.assets = assets;
        console.log(`Library: ${assets.length} assets`);
    }

    collectPlayable(
        quality: QualityKey,
        catalogs: string[],
        blacklist: string[]
    ): AerialAsset[] {
        const blocked = new Set(blacklist);
        return this.assets.filter(a => {
            if (!catalogs.includes(a.catalog))
                return false;
            if (blocked.has(a.id))
                return false;
            if (!a[quality])
                return false;
            return true;
        });
    }

    libraryItems(blacklist: string[]): ReturnType<typeof clipPublic>[] {
        const blocked = new Set(blacklist);
        return this.assets
            .map(a => {
                const item = clipPublic(a);
                item.blacklisted = blocked.has(a.id);
                return item;
            })
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    private async fetchToFile(url: string, dest: string): Promise<void> {
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error(`bad url ${url}`);

        const etagPath = `${dest}.etag`;
        const etag = readText(etagPath)?.trim();
        if (etag && Gio.File.new_for_path(dest).query_exists(null))
            message.request_headers.append('If-None-Match', etag);

        const bytes = await new Promise<GLib.Bytes>((resolve, reject) => {
            this.session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
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
        console.debug(`fetched ${url} status=${message.get_status()}`);
        const status = message.get_status();
        if (status === Soup.Status.NOT_MODIFIED)
            return;
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status} for ${url}`);

        const data = bytes?.get_data();
        if (!data)
            throw new Error(`empty body ${url}`);
        const text = new TextDecoder().decode(data);
        JSON.parse(text); // validate
        writeText(dest, text);
        const newEtag = message.response_headers.get_one('ETag');
        if (newEtag)
            writeText(etagPath, newEtag);
    }
}

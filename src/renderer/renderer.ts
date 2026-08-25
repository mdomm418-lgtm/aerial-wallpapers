// Copyright (C) 2026 Jeff Shee <jeffshee8969@gmail.com> and contributors
// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gst from 'gi://Gst';

import {APPLICATION_ID, RENDERER_OBJECT_PATH, SETTINGS_SCHEMA} from '../constants.js';
import {LibraryManager} from './library.js';
import {Playlist} from './playlist.js';
import {PlayerSlot, haveVideoSink} from './playerSlot.js';
import {ThumbnailCache} from './thumbnails.js';
import {
    CustomFeed,
    QualityKey,
    QUALITY_CHOICES,
    clipPublic,
    labelOf,
} from './types.js';

Gst.init([]);

const extSettings = (() => {
    let source = Gio.SettingsSchemaSource.get_default();
    try {
        // Installed layout is <extension>/renderer/renderer.js, and an
        // extensions.gnome.org install has no schema in the data dirs.
        const schemaDir = Gio.File.new_for_uri(import.meta.url)
            .get_parent()
            ?.get_parent()
            ?.get_child('schemas');
        if (schemaDir?.query_exists(null)) {
            source = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir.get_path()!,
                source,
                false
            );
        }
    } catch (e) {
        console.debug(`schema source: ${e}`);
    }
    const schema = source?.lookup(SETTINGS_SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
})();

let codePath = 'src';
let contentFit = extSettings?.get_int('content-fit') ?? Gtk.ContentFit.CONTAIN;
let mute = extSettings?.get_boolean('mute') ?? true;
let volume = (extSettings?.get_int('volume') ?? 50) / 100.0;
let nohide = false;
let windowed = false;
let windowDimension = {width: 1920, height: 1080};
let isDebugMode = extSettings?.get_boolean('debug-mode') ?? false;

const preferClappersink = extSettings?.get_boolean('prefer-clappersink') ?? false;
const forceMediaFile = extSettings?.get_boolean('force-mediafile') ?? false;
const isEnableVADecoders = extSettings?.get_boolean('enable-va') ?? true;
const isEnableNvSl = extSettings?.get_boolean('enable-nvsl') ?? false;
const isEnableGraphicsOffload =
    extSettings?.get_boolean('enable-graphics-offload') ?? false;

function parseCustomFeeds(raw: string): CustomFeed[] {
    try {
        const data = JSON.parse(raw || '[]');
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function qualityFromSettings(): QualityKey {
    const q = extSettings?.get_string('quality') ?? 'url-4K-SDR';
    return (QUALITY_CHOICES.includes(q as QualityKey) ? q : 'url-4K-SDR') as QualityKey;
}

const AerialRendererWindow = GObject.registerClass(
    {GTypeName: 'AerialRendererWindow'},
    class AerialRendererWindow extends Gtk.ApplicationWindow {
        declare _fadeVeil: Gtk.Box | null;
        declare _overlay: Gtk.Overlay | null;

        _setup(primary: Gtk.Widget, secondary: Gtk.Widget, gdkMonitor: Gdk.Monitor): void {
            const cssProvider = new Gtk.CssProvider();
            cssProvider.load_from_file(
                Gio.File.new_for_path(
                    GLib.build_filenamev([codePath, 'renderer', 'stylesheet.css'])
                )
            );
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default()!,
                cssProvider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            );

            const overlay = new Gtk.Overlay();
            overlay.set_child(primary);
            secondary.opacity = 0;
            overlay.add_overlay(secondary);

            const veil = new Gtk.Box({
                hexpand: true,
                vexpand: true,
                can_target: false,
            });
            veil.add_css_class('media-fade-veil');
            veil.opacity = 0;
            overlay.add_overlay(veil);

            this._overlay = overlay;
            this._fadeVeil = veil;
            this.set_child(overlay);

            if (!windowed) {
                const geometry = gdkMonitor.get_geometry();
                this.set_size_request(geometry.width, geometry.height);
                this.set_resizable(false);
            }
        }
    }
);

type AerialRendererWindow = InstanceType<typeof AerialRendererWindow>;

const AerialRenderer = GObject.registerClass(
    {GTypeName: 'AerialRenderer'},
    class AerialRenderer extends Gtk.Application {
        private aerialWindows: AerialRendererWindow[] = [];
        private dbus: any = null;
        private display: Gdk.Display | null = null;
        private monitors: Gdk.Monitor[] = [];

        private library = new LibraryManager();
        private thumbnails = new ThumbnailCache();
        private playlist: Playlist | null = null;
        private slotA: PlayerSlot | null = null;
        private slotB: PlayerSlot | null = null;
        private activeIsA = true;
        private swapInProgress = false;
        private prefetchArmed = false;
        private desktopFallbackActive = false;
        private positionPollId = 0;
        private paused = false;
        private crossfadeId = 0;
        private emptyRetryId = 0;
        private emptyRetryDelay = 15;
        private picturePairs: {a: Gtk.Picture; b: Gtk.Picture}[] = [];
        private recoverId = 0;
        private recoverAttempts = 0;
        private settingsIds: number[] = [];
        private playing = false;

        constructor() {
            super({
                application_id: APPLICATION_ID,
                flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
            });
            GLib.log_set_debug_enabled(isDebugMode);
            this.exportDbus();
            this.setupGst();

            this.connect('activate', () => {
                this.display = Gdk.Display.get_default();
                this.monitors = this.display
                    ? Array.from(
                        {length: this.display.get_monitors().get_n_items()},
                        (_, i) => this.display!.get_monitors().get_item(i) as Gdk.Monitor
                    )
                    : [];
                if (this.active_window)
                    return;
                // Windows must exist before activate() returns, so the UI is
                // built synchronously and content loading follows.
                if (!this.buildUI())
                    return;
                console.debug(
                    `${this.aerialWindows.length} window(s) on ${this.monitors.length} monitor(s)`
                );
                this.startContent().catch(e => console.error(`startContent: ${e}`));
            });

            this.connect('command-line', (_app, commandLine: Gio.ApplicationCommandLine) => {
                if (this.parseArgs(commandLine.get_arguments())) {
                    this.activate();
                    commandLine.set_exit_status(0);
                } else {
                    commandLine.set_exit_status(1);
                }
            });

            if (extSettings)
                this.bindSettings(extSettings);
        }

        private bindSettings(settings: Gio.Settings): void {
            const keys = [
                'enabled',
                'quality',
                'catalogs',
                'blacklist',
                'custom-feeds',
                'max-play-seconds',
                'crossfade-ms',
                'prefetch-lead-seconds',
                'mute',
                'volume',
                'content-fit',
                'debug-mode',
                'tls-insecure-hosts',
            ];
            for (const key of keys) {
                const id = settings.connect(`changed::${key}`, () => {
                    this.onSettingChanged(key).catch(e => console.error(e));
                });
                this.settingsIds.push(id);
            }
        }

        private async onSettingChanged(key: string): Promise<void> {
            if (!extSettings)
                return;
            switch (key) {
            case 'mute':
                mute = extSettings.get_boolean('mute');
                this.applyAudio();
                break;
            case 'volume':
                volume = extSettings.get_int('volume') / 100.0;
                this.applyAudio();
                break;
            case 'content-fit':
                contentFit = extSettings.get_int('content-fit');
                this.applyContentFit();
                break;
            case 'debug-mode':
                isDebugMode = extSettings.get_boolean('debug-mode');
                GLib.log_set_debug_enabled(isDebugMode);
                break;
            case 'enabled':
                this.applyEnabled(extSettings.get_boolean('enabled'));
                break;
            case 'quality':
            case 'catalogs':
            case 'blacklist':
            case 'custom-feeds':
                await this.rebuildPlaylist(true);
                break;
            default:
                break;
            }
        }

        private parseArgs(argv: string[]): boolean {
            let last: string | null = null;
            for (const arg of argv) {
                if (!last) {
                    if (arg === '-M' || arg === '--mute') {
                        mute = true;
                    } else if (arg === '-N' || arg === '--nohide') {
                        nohide = true;
                    } else if (
                        arg === '-W' ||
                        arg === '--windowed' ||
                        arg === '-P' ||
                        arg === '--codepath' ||
                        arg === '-V' ||
                        arg === '--volume'
                    ) {
                        last = arg;
                    } else if (arg === '-F' || arg === '--filepath') {
                        last = arg; // ignored — playlist owns URIs
                    } else {
                        console.error(`Argument ${arg} not recognized`);
                        return false;
                    }
                    continue;
                }
                if (last === '-W' || last === '--windowed') {
                    windowed = true;
                    const [w, h] = arg.split(':');
                    windowDimension = {width: parseInt(w), height: parseInt(h)};
                } else if (last === '-P' || last === '--codepath') {
                    codePath = arg;
                } else if (last === '-V' || last === '--volume') {
                    volume = Math.max(0, Math.min(1, parseFloat(arg)));
                }
                last = null;
            }
            return true;
        }

        private setupGst(): void {
            this.setPluginDecodersRank('nvcodec', Gst.Rank.PRIMARY + 1, isEnableNvSl);
            if (isEnableVADecoders)
                this.setPluginDecodersRank('va', Gst.Rank.PRIMARY + 3);
        }

        private setPluginDecodersRank(
            pluginName: string,
            rank: number,
            useStateless = false
        ): void {
            const registry = Gst.Registry.get();
            for (const feature of registry.get_feature_list_by_plugin(pluginName)) {
                const name = feature.get_name();
                if (!name?.endsWith('dec') && !name?.endsWith('postproc'))
                    continue;
                const isStateless = name.includes('sl');
                if (isStateless !== useStateless)
                    continue;
                if (feature.get_rank() !== rank)
                    feature.set_rank(rank);
            }
        }

        private async startContent(): Promise<void> {
            if (!extSettings)
                console.error(`settings schema ${SETTINGS_SCHEMA} not found`);
            await this.rebuildPlaylist(false);

            if (!extSettings?.get_boolean('enabled')) {
                this.applyEnabled(false);
                return;
            }

            if (!this.playlist?.assets.length) {
                console.error('no playable clips — check catalogs and network');
                this.setDesktopFallback(true);
                this.retryStartLater();
                return;
            }
            if (this.emptyRetryId) {
                GLib.source_remove(this.emptyRetryId);
                this.emptyRetryId = 0;
            }
            const first = this.playlist.ensureCurrent();
            const url = this.playlist.urlOf(first);
            console.debug(`initial uri=${url}`);
            this.activeSlot().setUri(url);
            this.applyAudio();
            this.startPositionPoll();
            this.emitCurrentClip();
        }

        /** Offline start: keep retrying the feed fetch with a capped backoff. */
        private retryStartLater(): void {
            if (this.emptyRetryId)
                return;
            this.emptyRetryDelay = Math.min(this.emptyRetryDelay * 2, 300);
            console.warn(`retrying library load in ${this.emptyRetryDelay}s`);
            this.emptyRetryId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this.emptyRetryDelay,
                () => {
                    this.emptyRetryId = 0;
                    this.startContent().catch(e => console.error(e));
                    return GLib.SOURCE_REMOVE;
                }
            );
        }

        private async rebuildPlaylist(advance: boolean): Promise<void> {
            if (!extSettings)
                return;
            const catalogs = extSettings.get_strv('catalogs');
            const custom = parseCustomFeeds(extSettings.get_string('custom-feeds'));
            const hours = extSettings.get_int('feed-refresh-hours');
            await this.library.refreshIfNeeded(hours, catalogs, custom, false);
            const quality = qualityFromSettings();
            const blacklist = extSettings.get_strv('blacklist');
            const playable = this.library.collectPlayable(quality, catalogs, blacklist);
            if (!this.playlist)
                this.playlist = new Playlist(playable, quality);
            else
                this.playlist.replaceAssets(playable, quality);

            if (advance && playable.length) {
                this.playlist.forceNext();
                this.transitionTo(this.playlist.next()).catch(e => console.error(e));
            }

            // Previews for the picker and the preferences grid; harmless to
            // let this run long after playback has started.
            this.thumbnails
                .warm(this.library.getAssets())
                .catch(e => console.debug(`thumbnail warm: ${e}`));
        }

        private buildUI(): boolean {
            if (forceMediaFile || !haveVideoSink()) {
                console.error('gtk4paintablesink is required (install gstreamer1-plugins-rs)');
                return false;
            }
            try {
                this.slotA = this.makeSlot('A');
                this.slotB = this.makeSlot('B');
            } catch (e) {
                console.error(`cannot create pipelines: ${e}`);
                return false;
            }

            this.monitors.forEach((gdkMonitor, index) => {
                // Every monitor shows both paintables so a crossfade is visible
                // on all of them, not just the primary.
                const a = this.makePicture(this.slotA!);
                const b = this.makePicture(this.slotB!);
                this.picturePairs.push({a: a.picture, b: b.picture});
                const primary = a.widget;
                const secondary = b.widget;

                const geometry = gdkMonitor.get_geometry();
                const state = {
                    position: [geometry.x, geometry.y],
                    keepAtBottom: true,
                    keepMinimized: true,
                    keepPosition: true,
                };
                const title = nohide
                    ? `Aerial Renderer #${index}`
                    : `@${APPLICATION_ID}!${JSON.stringify(state)}|${index}`;

                const window = new AerialRendererWindow({
                    application: this,
                    decorated: !!nohide,
                    default_height: windowed ? windowDimension.height : geometry.height,
                    default_width: windowed ? windowDimension.width : geometry.width,
                    title,
                });
                window._setup(primary, secondary, gdkMonitor);
                this.aerialWindows.push(window);
            });

            this.aerialWindows.forEach(w => w.present());
            return this.aerialWindows.length > 0;
        }

        private makePicture(slot: PlayerSlot): {widget: Gtk.Widget; picture: Gtk.Picture} {
            const picture = new Gtk.Picture({
                paintable: slot.paintable,
                hexpand: true,
                vexpand: true,
            });
            picture.set_content_fit(contentFit);

            let widget: Gtk.Widget = picture;
            if (isEnableGraphicsOffload && (Gtk as any).GraphicsOffload) {
                const offload = new (Gtk as any).GraphicsOffload({child: picture});
                offload.set_enabled?.((Gtk as any).GraphicsOffloadEnabled?.ENABLED);
                widget = offload as Gtk.Widget;
            }
            return {widget, picture};
        }

        private applyContentFit(): void {
            for (const pair of this.picturePairs) {
                pair.a.set_content_fit(contentFit);
                pair.b.set_content_fit(contentFit);
            }
        }

        private makeSlot(label: string): PlayerSlot {
            return new PlayerSlot({
                label,
                preferClappersink,
                getInsecureHosts: () => extSettings?.get_strv('tls-insecure-hosts') ?? ['sylvan.apple.com'],
                onPlayingChanged: playing => {
                    console.debug(`slot ${label}: playing=${playing}`);
                    this.playing = this.activeSlot().isPlaying();
                    this.dbus?.emit_signal(
                        'isPlayingChanged',
                        new GLib.Variant('(b)', [this.playing])
                    );
                },
                onError: msg => {
                    console.error(`slot ${label}: ${msg}`);
                    this.scheduleRecover(msg);
                },
                onEndOfStream: () => {
                    if (this.swapInProgress)
                        return;
                    this.goNext().catch((e: unknown) => console.error(e));
                },
            });
        }

        private activeSlot(): PlayerSlot {
            return this.activeIsA ? this.slotA! : this.slotB!;
        }

        private idleSlot(): PlayerSlot {
            return this.activeIsA ? this.slotB! : this.slotA!;
        }

        private startPositionPoll(): void {
            if (this.positionPollId)
                GLib.source_remove(this.positionPollId);
            this.positionPollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this.tick();
                return GLib.SOURCE_CONTINUE;
            });
        }

        /**
         * Prefetch and clip changes are driven by playback position rather than
         * wall-clock time, so a paused wallpaper holds its clip instead of
         * shuffling on behind a maximized window.
         */
        private tick(): void {
            if (this.paused || this.swapInProgress || !this.playlist)
                return;
            if (!extSettings?.get_boolean('enabled'))
                return;

            const active = this.activeSlot();
            // Buffering or prerolling: position isn't advancing yet.
            if (!active.isPlaying())
                return;

            const lead = extSettings.get_int('prefetch-lead-seconds');
            const maxPlay = extSettings.get_int('max-play-seconds');
            const pos = active.getPositionSeconds();
            const dur = active.getDurationSeconds();

            let remaining = Infinity;
            if (maxPlay > 0)
                remaining = Math.min(remaining, maxPlay - pos);
            if (dur > 0)
                remaining = Math.min(remaining, dur - pos);

            if (remaining <= 0) {
                this.goNext().catch((e: unknown) => console.error(e));
                return;
            }

            if (remaining > lead || this.prefetchArmed)
                return;

            const next = this.playlist.peekNext();
            if (!next)
                return;
            const url = this.playlist.urlOf(next);
            if (!url)
                return;
            console.debug(`prefetch ${labelOf(next)} (remaining≈${remaining.toFixed(1)}s)`);
            this.idleSlot().setUri(url, {preroll: true});
            this.prefetchArmed = true;
        }

        private async transitionTo(asset: import('./types.js').AerialAsset): Promise<void> {
            if (this.swapInProgress)
                return;
            const url = this.playlist!.urlOf(asset);
            if (!url)
                return;

            this.swapInProgress = true;
            this.setDesktopFallback(false);
            this.recoverAttempts = 0;

            const from = this.activeSlot();
            const to = this.idleSlot();
            const duration = extSettings?.get_int('crossfade-ms') ?? 700;

            if (!this.prefetchArmed || to.getUri() !== url)
                to.setUri(url, {preroll: true});

            // Wait briefly for preroll
            await this.sleep(280);
            to.playMedia();
            this.applyAudio();

            await this.animateCrossfade(duration);
            from.stopMedia();
            this.activeIsA = !this.activeIsA;
            this.prefetchArmed = false;
            this.swapInProgress = false;
            // An explicit pick while auto-paused should not resume playback.
            if (this.paused)
                this.activeSlot().pauseMedia();
            this.emitCurrentClip();
        }

        /**
         * Fade the idle slot's pictures in and the active slot's out, on every
         * monitor.
         *
         * @param {number} durationMs - crossfade length
         * @returns {Promise<void>} resolves when the fade completes
         */
        private animateCrossfade(durationMs: number): Promise<void> {
            return new Promise(resolve => {
                if (this.crossfadeId) {
                    GLib.source_remove(this.crossfadeId);
                    this.crossfadeId = 0;
                }
                const incoming = this.activeIsA ? 'b' : 'a';
                const outgoing = this.activeIsA ? 'a' : 'b';
                const setOpacity = (inTo: number, outTo: number) => {
                    for (const pair of this.picturePairs) {
                        pair[incoming].opacity = inTo;
                        pair[outgoing].opacity = outTo;
                    }
                };

                const steps = Math.max(1, Math.round(durationMs / 16));
                let step = 0;
                setOpacity(0, 1);
                this.crossfadeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                    step++;
                    const t = Math.min(1, step / steps);
                    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
                    setOpacity(eased, 1 - eased);
                    if (step >= steps) {
                        setOpacity(1, 0);
                        this.crossfadeId = 0;
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                });
            });
        }

        private sleep(ms: number): Promise<void> {
            return new Promise(resolve => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }

        private applyAudio(): void {
            this.slotA?.setVolume(volume, mute);
            this.slotB?.setVolume(volume, mute);
        }

        private applyEnabled(enabled: boolean): void {
            if (!enabled) {
                this.activeSlot()?.pauseMedia();
                this.idleSlot()?.stopMedia();
                this.setDesktopFallback(true);
                return;
            }
            this.setDesktopFallback(false);
            if (this.playlist?.assets.length) {
                const cur = this.playlist.ensureCurrent();
                this.activeSlot().setUri(this.playlist.urlOf(cur));
                this.applyAudio();
            }
        }

        private setDesktopFallback(enabled: boolean): void {
            if (this.desktopFallbackActive === enabled)
                return;
            this.desktopFallbackActive = enabled;
            for (const window of this.aerialWindows)
                window.opacity = enabled ? 0 : 1;
            try {
                this.dbus?.emit_signal(
                    'desktopFallbackChanged',
                    new GLib.Variant('(b)', [enabled])
                );
            } catch (e) {
                console.warn(e);
            }
        }

        private scheduleRecover(reason: string): void {
            if (!extSettings?.get_boolean('enabled')) {
                this.setDesktopFallback(true);
                return;
            }
            if (this.recoverId)
                return;
            if (this.recoverAttempts >= 4) {
                this.setDesktopFallback(true);
                this.recoverAttempts = 0;
                this.recoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
                    this.recoverId = 0;
                    this.goNext().catch((e: unknown) => console.error(e));
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this.recoverAttempts++;
            const delay = 600 * this.recoverAttempts;
            console.warn(`recover #${this.recoverAttempts} in ${delay}ms (${reason})`);
            this.recoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this.recoverId = 0;
                this.goNext().catch((e: unknown) => console.error(e));
                return GLib.SOURCE_REMOVE;
            });
        }

        private emitCurrentClip(): void {
            const cur = this.playlist?.getCurrent();
            const payload = cur
                ? JSON.stringify(clipPublic(cur, this.playlist!.quality))
                : '';
            try {
                this.dbus?.emit_signal(
                    'currentClipChanged',
                    new GLib.Variant('(s)', [payload])
                );
            } catch (e) {
                console.debug(e);
            }
            try {
                // Without this the proxy's property cache keeps whatever it read
                // before the first clip started, i.e. nothing.
                this.dbus?.emit_property_changed(
                    'currentClip',
                    new GLib.Variant('s', payload)
                );
                this.dbus?.flush();
            } catch (e) {
                console.warn(`emit_property_changed(currentClip): ${e}`);
            }
        }

        private exportDbus(): void {
            const dbusXml = `
            <node>
                <interface name="${APPLICATION_ID}">
                    <method name="setPlay"/>
                    <method name="setPause"/>
                    <method name="nextClip"/>
                    <method name="playClip">
                        <arg type="s" name="id" direction="in"/>
                    </method>
                    <method name="blockClip">
                        <arg type="s" name="id" direction="in"/>
                    </method>
                    <method name="refreshFeeds"/>
                    <property name="isPlaying" type="b" access="read"/>
                    <property name="desktopFallback" type="b" access="read"/>
                    <property name="currentClip" type="s" access="read"/>
                    <signal name="isPlayingChanged">
                        <arg name="isPlaying" type="b"/>
                    </signal>
                    <signal name="desktopFallbackChanged">
                        <arg name="active" type="b"/>
                    </signal>
                    <signal name="currentClipChanged">
                        <arg name="json" type="s"/>
                    </signal>
                </interface>
            </node>`;
            this.dbus = Gio.DBusExportedObject.wrapJSObject(dbusXml, this);
            this.dbus.export(Gio.DBus.session, RENDERER_OBJECT_PATH);
        }

        setPlay(): void {
            this.paused = false;
            if (!extSettings?.get_boolean('enabled'))
                return;
            this.activeSlot()?.playMedia();
        }

        setPause(): void {
            this.paused = true;
            this.activeSlot()?.pauseMedia();
            this.idleSlot()?.pauseMedia();
        }

        /** D-Bus: advance shuffle. */
        nextClip(): void {
            this.goNext().catch((e: unknown) => console.error(e));
        }

        /**
         * D-Bus: pin-once and play.
         *
         * @param {string} id - asset id to play next
         */
        playClip(id: string): void {
            this.goPlayClip(id).catch((e: unknown) => console.error(e));
        }

        blockClip(id: string): void {
            if (!extSettings || !id)
                return;
            const list = extSettings.get_strv('blacklist');
            if (!list.includes(id)) {
                list.push(id);
                extSettings.set_strv('blacklist', list);
            }
            this.goNext().catch((e: unknown) => console.error(e));
        }

        refreshFeeds(): void {
            this.goRefreshFeeds().catch((e: unknown) => console.error(e));
        }

        private async goNext(): Promise<void> {
            await this.nextClipInternal();
        }

        private async goPlayClip(id: string): Promise<void> {
            await this.playClipInternal(id);
        }

        private async goRefreshFeeds(): Promise<void> {
            if (!extSettings)
                return;
            const catalogs = extSettings.get_strv('catalogs');
            const custom = parseCustomFeeds(extSettings.get_string('custom-feeds'));
            await this.library.refresh(catalogs, custom);
            await this.rebuildPlaylist(false);
        }

        private async nextClipInternal(): Promise<void> {
            if (!this.playlist?.assets.length) {
                this.setDesktopFallback(true);
                return;
            }
            this.playlist.forceNext();
            await this.transitionTo(this.playlist.next());
        }

        private async playClipInternal(id: string): Promise<void> {
            if (!this.playlist)
                return;
            const result = this.playlist.pinOnce(id);
            if (!result.ok)
                return;
            await this.transitionTo(this.playlist.next());
        }

        get isPlaying(): boolean {
            return this.playing;
        }

        get desktopFallback(): boolean {
            return this.desktopFallbackActive;
        }

        get currentClip(): string {
            const cur = this.playlist?.getCurrent();
            return cur ? JSON.stringify(clipPublic(cur, this.playlist!.quality)) : '';
        }
    }
);

const renderer = new AerialRenderer();
renderer.run(ARGV);

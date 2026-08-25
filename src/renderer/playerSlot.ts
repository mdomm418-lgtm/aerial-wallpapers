// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import Gdk from 'gi://Gdk?version=4.0';
// Both ship with gstreamer1-plugins-base and are imported statically on
// purpose: a top-level await here would run the whole renderer inside a
// promise job, which blocks GJS from ever dispatching another one.
import GstPlay from 'gi://GstPlay';
import GstAudio from 'gi://GstAudio';

import {startHttpSourcePoll} from './httpSource.js';

const gstVersion = Gst.version();
const useGstGL =
    gstVersion[0] > 1 || (gstVersion[0] === 1 && gstVersion[1] >= 24);

export type PlayerSlotOptions = {
    label: string;
    preferClappersink: boolean;
    getInsecureHosts: () => string[];
    onPlayingChanged: (playing: boolean) => void;
    onError: (message: string) => void;
    onEndOfStream: () => void;
};

/**
 * One decode pipeline plus its paintable. Widgets are owned by the renderer so
 * every monitor can show (and crossfade) the same paintable.
 */
export class PlayerSlot {
    readonly label: string;
    readonly paintable: Gdk.Paintable;
    private play: any = null;
    private adapter: any = null;
    private pollId = 0;
    private uri = '';
    private playing = false;
    private opts: PlayerSlotOptions;

    constructor(opts: PlayerSlotOptions) {
        this.opts = opts;
        this.label = opts.label;

        let sink: any = null;
        if (opts.preferClappersink)
            sink = Gst.ElementFactory.make('clappersink', `clapper-${opts.label}`);
        if (!sink)
            sink = Gst.ElementFactory.make('gtk4paintablesink', `sink-${opts.label}`);
        if (!sink)
            throw new Error('no usable video sink (need gtk4paintablesink)');

        const paintable = (sink.paintable ?? sink.widget?.paintable) as Gdk.Paintable;
        if (!paintable)
            throw new Error('sink exposed no paintable');
        this.paintable = paintable;

        let videoSink = sink;
        if (useGstGL) {
            const glsink = Gst.ElementFactory.make('glsinkbin', `gl-${opts.label}`);
            if (glsink) {
                glsink.set_property('sink', sink);
                videoSink = glsink;
            }
        }

        this.play = GstPlay.Play.new(
            GstPlay.PlayVideoOverlayVideoRenderer.new_with_sink(null, videoSink)
        );
        this.adapter = GstPlay.PlaySignalAdapter.new(this.play);

        this.adapter.connect('state-changed', (_a: any, state: number) => {
            this.playing = state === GstPlay.PlayState.PLAYING;
            this.opts.onPlayingChanged(this.playing);
        });
        this.adapter.connect('error', (_a: any, err: GLib.Error) => {
            this.opts.onError(err.message);
        });
        this.adapter.connect('warning', (_a: any, err: GLib.Error) => {
            console.debug(`slot ${this.label} warning: ${err.message}`);
        });
        this.adapter.connect('end-of-stream', () => {
            this.opts.onEndOfStream();
        });

        // GJS cannot service playbin3's source-setup (streaming thread), so the
        // HTTP source is hardened by polling the pipeline on the main loop.
        this.pollId = startHttpSourcePoll(
            () => this.play?.get_pipeline?.() ?? null,
            () => this.uri,
            () => this.opts.getInsecureHosts()
        );
    }

    isPlaying(): boolean {
        return this.playing;
    }

    getUri(): string {
        return this.uri;
    }

    getDurationSeconds(): number {
        const dur = Number(this.play?.get_duration?.() ?? 0);
        if (!dur)
            return 0;
        return dur / Number(Gst.SECOND ?? 1_000_000_000);
    }

    getPositionSeconds(): number {
        const pos = Number(this.play?.get_position?.() ?? 0);
        if (!pos)
            return 0;
        return pos / Number(Gst.SECOND ?? 1_000_000_000);
    }

    setVolume(volume: number, mute: boolean): void {
        if (!this.play)
            return;
        const v = GstAudio.StreamVolume.convert_volume(
            GstAudio.StreamVolumeFormat.CUBIC,
            GstAudio.StreamVolumeFormat.LINEAR,
            volume
        );
        if (this.play.volume === v)
            this.play.volume = null;
        this.play.volume = v;
        if (this.play.mute === mute)
            this.play.mute = !mute;
        this.play.mute = mute;
    }

    setUri(uri: string, {preroll = false}: {preroll?: boolean} = {}): void {
        this.uri = uri;
        this.play.set_uri(uri);
        if (preroll)
            this.play.pause();
        else
            this.play.play();
    }

    playMedia(): void {
        this.play?.play();
    }

    pauseMedia(): void {
        this.play?.pause();
    }

    stopMedia(): void {
        this.play?.stop();
        this.uri = '';
    }

    dispose(): void {
        if (this.pollId) {
            GLib.source_remove(this.pollId);
            this.pollId = 0;
        }
        try {
            this.play?.stop();
        } catch {
            /* ignore */
        }
        this.play = null;
        this.adapter = null;
    }
}

export function haveVideoSink(): boolean {
    return Gst.ElementFactory.find('gtk4paintablesink') !== null;
}

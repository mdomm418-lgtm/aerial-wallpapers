// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import {AerialAsset, QualityKey, clipPublic} from './types.js';

function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

export class Playlist {
    quality: QualityKey;
    assets: AerialAsset[] = [];
    private byId = new Map<string, AerialAsset>();
    private deck: AerialAsset[] = [];
    private current: AerialAsset | null = null;
    private pin: AerialAsset | null = null;

    constructor(assets: AerialAsset[], quality: QualityKey) {
        this.quality = quality;
        this.replaceAssets(assets, quality);
    }

    replaceAssets(assets: AerialAsset[], quality: QualityKey): void {
        this.quality = quality;
        this.assets = assets.filter(a => a[quality]);
        this.byId = new Map(this.assets.map(a => [a.id, a]));
        const curId = this.current?.id;
        const pinId = this.pin?.id;
        this.current = curId ? this.byId.get(curId) ?? null : null;
        this.pin = pinId ? this.byId.get(pinId) ?? null : null;
        this.reshuffle();
    }

    private reshuffle(): void {
        this.deck = [...this.assets];
        shuffleInPlace(this.deck);
    }

    private draw(): AerialAsset {
        if (!this.deck.length)
            this.reshuffle();
        if (!this.deck.length)
            throw new Error('No clips available');
        return this.deck.pop()!;
    }

    getCurrent(): AerialAsset | null {
        return this.current;
    }

    peekNext(): AerialAsset | null {
        if (this.pin)
            return this.pin;
        if (!this.deck.length)
            this.reshuffle();
        return this.deck.length ? this.deck[this.deck.length - 1] : null;
    }

    /** Advance to the next clip (consumes pin if set). */
    next(): AerialAsset {
        if (this.pin) {
            this.current = this.pin;
            this.pin = null;
        } else {
            this.current = this.draw();
        }
        console.log(
            `Now playing: ${this.current.accessibilityLabel || this.current.title || this.current.id}`
        );
        return this.current;
    }

    /** Ensure there is a current clip without reshuffling if one exists. */
    ensureCurrent(): AerialAsset {
        if (this.current)
            return this.current;
        return this.next();
    }

    pinOnce(assetId: string | null): {ok: boolean; pinned: ReturnType<typeof clipPublic> | null; error?: string} {
        if (!assetId) {
            this.pin = null;
            return {ok: true, pinned: null};
        }
        const asset = this.byId.get(assetId);
        if (!asset)
            return {ok: false, pinned: null, error: `unknown id: ${assetId}`};
        this.pin = asset;
        return {ok: true, pinned: clipPublic(asset, this.quality)};
    }

    forceNext(): void {
        this.pin = null;
    }

    urlOf(asset: AerialAsset): string {
        return String(asset[this.quality] || '');
    }

    status() {
        return {
            quality: this.quality,
            count: this.assets.length,
            remaining_in_shuffle: this.deck.length,
            pinned: this.pin ? clipPublic(this.pin, this.quality) : null,
            current: this.current ? clipPublic(this.current, this.quality) : null,
        };
    }
}

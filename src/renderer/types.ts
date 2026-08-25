// Copyright (C) 2026 Michael D. Murray and contributors
// SPDX-License-Identifier: GPL-3.0-or-later

export type QualityKey = 'url-4K-SDR' | 'url-1080-SDR' | 'url-1080-H264';

export const QUALITY_CHOICES: QualityKey[] = [
    'url-4K-SDR',
    'url-1080-SDR',
    'url-1080-H264',
];

export const BUILTIN_CATALOGS = ['apple', 'jetson', 'robin'] as const;

export const FEED_URLS: Record<(typeof BUILTIN_CATALOGS)[number], string> = {
    apple: 'https://raw.githubusercontent.com/theothernt/AerialVideos/master/src/lib/tvos26.json',
    jetson: 'https://raw.githubusercontent.com/theothernt/AerialVideos/master/src/lib/comm1.json',
    robin: 'https://raw.githubusercontent.com/theothernt/AerialVideos/master/src/lib/comm2.json',
};

export const THUMB_BASE = 'https://aerial-videos.netlify.app/thumbnails';

export interface AerialAsset {
    id: string;
    title?: string;
    accessibilityLabel?: string;
    catalog: string;
    includeInShuffle?: boolean;
    previewImage?: string;
    'url-4K-SDR'?: string;
    'url-1080-SDR'?: string;
    'url-1080-H264'?: string;
    [key: string]: unknown;
}

export interface CustomFeed {
    id: string;
    name: string;
    url: string;
    file: string;
    enabled: boolean;
}

export interface ClipPublic {
    id: string;
    title: string;
    accessibilityLabel?: string;
    catalog: string;
    previewImage: string;
    url?: string;
    blacklisted?: boolean;
}

export function labelOf(asset: {accessibilityLabel?: string; title?: string; id?: string}): string {
    return String(asset.accessibilityLabel || asset.title || asset.id || '');
}

export function previewOf(asset: AerialAsset): string {
    const id = asset.id;
    // Prefer netlify thumbs — Apple's previewImage host fails strict TLS.
    if (id)
        return `${THUMB_BASE}/${id}.webp`;
    return String(asset.previewImage || '');
}

export function clipPublic(asset: AerialAsset, quality?: QualityKey): ClipPublic {
    const out: ClipPublic = {
        id: asset.id,
        title: labelOf(asset),
        accessibilityLabel: asset.accessibilityLabel,
        catalog: asset.catalog,
        previewImage: previewOf(asset),
    };
    if (quality && asset[quality])
        out.url = String(asset[quality]);
    return out;
}

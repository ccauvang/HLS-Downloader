import { fetchViaPage } from './bridge.js';
import { formatDuration } from './format.js';

export function parseMediaPlaylist(text) {
    const lines = text.split('\n');
    let duration = 0, segments = 0;
    for (const l of lines) {
        if (l.trimStart().startsWith('#EXTINF:')) {
            duration += parseFloat(l.trim().slice(8).split(',')[0]) || 0;
            segments++;
        }
    }
    return { duration, segments };
}

export async function detectStreamInfo(url) {
    const text = await fetchViaPage(url);
    if (!text.trimStart().startsWith('#EXTM3U')) return null;

    const lines = text.split('\n').map(l => l.trim());
    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    if (isMaster) {
        let bestBw = -1, bestUrl = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                const vLine = lines[i + 1]?.trim();
                if (vLine && !vLine.startsWith('#') && bw > bestBw) {
                    bestBw = bw; bestUrl = vLine;
                }
            }
        }
        if (bestUrl) {
            const base = url.substring(0, url.lastIndexOf('/') + 1);
            const variantUrl = bestUrl.startsWith('http') ? bestUrl : base + bestUrl;
            try {
                const variantText = await fetchViaPage(variantUrl);
                const info = parseMediaPlaylist(variantText);
                return {
                    url, isMaster: true,
                    label: `${formatDuration(Math.ceil(info.duration))} | ${info.segments} segs | master`,
                    cachedText: text,
                    variantUrl,
                    cachedVariantText: variantText
                };
            } catch (e) {
                return { url, isMaster: true, label: 'Master playlist', cachedText: text, variantUrl: null, cachedVariantText: null };
            }
        }
        return { url, isMaster: true, label: 'Master playlist', cachedText: text, variantUrl: null, cachedVariantText: null };
    }

    const info = parseMediaPlaylist(text);
    return {
        url, isMaster: false,
        label: `${formatDuration(Math.ceil(info.duration))} | ${info.segments} segs`,
        cachedText: text,
        variantUrl: null,
        cachedVariantText: null
    };
}
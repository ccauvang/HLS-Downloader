import { fetchViaPage } from './bridge.js';
import { formatDuration } from './format.js';

export function parseMediaPlaylist(text) {
    const lines = text.split('\n');
    let duration = 0, segments = 0;
    for (const l of lines) {
        if (l.trimStart().startsWith('#EXTINF:')) {
            duration += parseFloat(l.trim().slice(8).split(',')[0]) || 0; // slice(8) drops "#EXTINF:" prefix
            segments++;
        }
    }
    return { duration, segments };
}

// used both to enrich the popup dropdown (label with duration/seg count) and to cache
// playlist text so parseStream() in download/parse.js can skip a redundant re-fetch later
export async function detectStreamInfo(url, frameId = 0) {
    const text = await fetchViaPage(url, frameId);
    if (!text.trimStart().startsWith('#EXTM3U')) return null; // not actually a valid HLS playlist

    const lines = text.split('\n').map(l => l.trim());
    const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

    if (isMaster) {
        // master playlists list multiple quality variants — pick the highest-bandwidth one
        // as the default so the user doesn't have to manually resolve which variant to grab
        let bestBw = -1, bestUrl = null;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                const vLine = lines[i + 1]?.trim(); // variant URL is the line immediately after its #EXT-X-STREAM-INF tag
                if (vLine && !vLine.startsWith('#') && bw > bestBw) {
                    bestBw = bw; bestUrl = vLine;
                }
            }
        }
        if (bestUrl) {
            const base = url.substring(0, url.lastIndexOf('/') + 1);
            const variantUrl = bestUrl.startsWith('http') ? bestUrl : base + bestUrl;
            try {
                const variantText = await fetchViaPage(variantUrl, frameId);
                const info = parseMediaPlaylist(variantText);
                return {
                    url, isMaster: true,
                    label: `${formatDuration(Math.ceil(info.duration))} | ${info.segments} segs | master`,
                    cachedText: text,
                    variantUrl,
                    cachedVariantText: variantText
                };
            } catch (e) {
                // variant fetch failed (network/CORS/etc) — still return the master info so it's
                // selectable in the dropdown, just without duration/seg count in the label
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
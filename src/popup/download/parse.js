import { state, saveState } from '../state.js';
import { log } from '../utils/logger.js';
import { fetchViaPage, fetchKey } from '../utils/bridge.js';
import { formatDuration } from '../utils/format.js';

export async function parseStream(url) {
    // check cache first
    const cached = state.detectedM3u8.find(e => typeof e === 'object' && e.url === url);
    const masterBase = url.substring(0, url.lastIndexOf('/') + 1);
    let text, base, masterText;

    log('Fetching m3u8…', 'inf');
    try {

        if (cached?.cachedText) {
            log('✔ Using cached playlist', 'ok');
            text = cached.cachedText;
            base = url.substring(0, url.lastIndexOf('/') + 1);
            if (cached.isMaster) masterText = cached.cachedText;

            // if master and has cached variant
            if (cached.isMaster && cached.cachedVariantText) {
                log('✔ Using cached variant', 'ok');
                text = cached.cachedVariantText;
                base = cached.variantUrl.substring(0, cached.variantUrl.lastIndexOf('/') + 1);
            } else if (cached.isMaster && !cached.cachedVariantText) {
                // master but no variant cached, fetch normally
                text = await fetchViaPage(url);
                base = masterBase;
            }
        } else {
            text = await fetchViaPage(url);
            base = masterBase;
            masterText = text;
        }

        const lines = text.split('\n').map(l => l.trim());
        state.totalDuration = 0;
        const segments = [];
        const mapLine = lines.find(l => l.startsWith('#EXT-X-MAP'));
        if (mapLine) {
            const mapMatch = mapLine.match(/URI="([^"]+)"/);
            if (!mapMatch) {
                log('⚠ Malformed EXT-X-MAP line', 'err');
                window._hlsInitUrl = null;
            } else {
                window._hlsInitUrl = mapMatch[1].startsWith('http') ? mapMatch[1] : base + mapMatch[1];
                log(`✔ fMP4 mode`, 'ok');
            }
        } else {
            window._hlsInitUrl = null;
        }

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF:'))
                state.totalDuration += parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
            if (lines[i] && !lines[i].startsWith('#'))
                segments.push(lines[i].startsWith('http') ? lines[i] : base + lines[i]);
        }
        log(`✔ ${segments.length} segments, ${formatDuration(state.totalDuration)}`, 'ok');
        document.getElementById('links').value = segments.join('\n');

        const keyLine = lines.find(l => l.startsWith('#EXT-X-KEY'));
        if (keyLine && !keyLine.includes('METHOD=NONE')) {
            const uriMatch = keyLine.match(/URI="([^"]+)"/);
            if (!uriMatch) {
                log('⚠ Malformed EXT-X-KEY line — no URI', 'err');
                window._hlsKey = null; window._hlsIv = null; window._hlsHasKey = false;
            } else {
                const ivMatch = keyLine.match(/IV=0x([0-9a-fA-F]+)/);
                const keyBuf = await fetchKey(uriMatch[1], url);
                const keyIv = ivMatch ? new Uint8Array(ivMatch[1].match(/../g).map(h => parseInt(h, 16))) : new Uint8Array(16);
                log(`✔ Key fetched, IV: ${ivMatch ? 'custom' : 'default'}`, 'ok');
                window._hlsKey = keyBuf; window._hlsIv = keyIv; window._hlsHasKey = true;
            }
        } else {
            window._hlsKey = null; window._hlsIv = null; window._hlsHasKey = false;
        }

        window._hlsAudioInitUrl = null; window._hlsAudioSegments = null;
        if (masterText?.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
            const audioLine = masterText.split('\n').find(l => l.includes('#EXT-X-MEDIA:TYPE=AUDIO'));
            const audioUriMatch = audioLine?.match(/URI="([^"]+)"/);
            if (audioUriMatch) {
                const audioUrl = audioUriMatch[1].startsWith('http') ? audioUriMatch[1] : masterBase + audioUriMatch[1];
                const audioText = await fetchViaPage(audioUrl);
                const aBase = audioUrl.substring(0, audioUrl.lastIndexOf('/') + 1);
                const aLines = audioText.split('\n').map(l => l.trim());
                const aMapLine = aLines.find(l => l.startsWith('#EXT-X-MAP'));
                if (aMapLine) {
                    const aMapUri = aMapLine.match(/URI="([^"]+)"/)[1];
                    window._hlsAudioInitUrl = aMapUri.startsWith('http') ? aMapUri : aBase + aMapUri;
                }
                window._hlsAudioSegments = aLines.filter(l => l && !l.startsWith('#')).map(l => l.startsWith('http') ? l : aBase + l);
                log(`✔ ${window._hlsAudioSegments.length} audio segs`, 'ok');
            }
        }
        saveState();
    } catch (e) { log(`❌ ${e.message}`, 'err'); }
}
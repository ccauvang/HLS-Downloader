import { dom } from '../dom.js';

let historyBodyHTML = null;
let settingsBodyHTML = null;
let historyScriptLoaded = false;
let settingsScriptLoaded = false;

export async function preloadViews() {
    const [histRes, setRes] = await Promise.all([
        fetch(chrome.runtime.getURL('src/history/history.html')),
        fetch(chrome.runtime.getURL('src/settings/settings.html'))
    ]);
    const [histHtml, setHtml] = await Promise.all([histRes.text(), setRes.text()]);
    const parser = new DOMParser();
    historyBodyHTML = parser.parseFromString(histHtml, 'text/html').getElementById('body').innerHTML;
    settingsBodyHTML = parser.parseFromString(setHtml, 'text/html').getElementById('body').innerHTML;

    // inject CSS once
    for (const [id, href] of [
        ['history-css', 'src/history/history.css'],
        ['settings-css', 'src/settings/settings.css']
    ]) {
        if (!document.getElementById(id)) {
            const link = document.createElement('link');
            link.id = id; link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL(href);
            document.head.appendChild(link);
        }
    }
}

export function showView(view) {
    // hide main body content
    [...dom.mainBody.children].forEach(el => el.style.display = view === 'main' ? '' : 'none');

    // update active btn
    document.getElementById('home-btn').classList.toggle('active', view === 'main');
    document.getElementById('history-btn').classList.toggle('active', view === 'history');
    document.getElementById('settings-btn').classList.toggle('active', view === 'settings');

    // remove old injected view
    document.getElementById('injected-view')?.remove();

    if (view === 'main') return;

    const div = document.createElement('div');
    div.id = 'injected-view';
    div.innerHTML = view === 'history' ? historyBodyHTML : settingsBodyHTML;
    dom.mainBody.appendChild(div);
}

export function wireViewButtons() {
    document.getElementById('home-btn').classList.add('active');
    document.getElementById('home-btn').addEventListener('click', () => showView('main'));

    document.getElementById('history-btn').addEventListener('click', () => {
        if (!historyBodyHTML) return;
        showView('history');
        if (!historyScriptLoaded) {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('src/history/history.js');
            script.onload = () => window.hlsHistoryLoad?.(); // wait for script then load
            document.body.appendChild(script);
            historyScriptLoaded = true;
        } else {
            window.hlsHistoryLoad?.();
        }
    });

    document.getElementById('settings-btn').addEventListener('click', () => {
        if (!settingsBodyHTML) return;
        showView('settings');
        if (!settingsScriptLoaded) {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('src/settings/settings.js');
            script.onload = () => window.hlsSettingsInit?.();
            document.body.appendChild(script);
            settingsScriptLoaded = true;
        } else {
            window.hlsSettingsInit?.();
        }
    });
}
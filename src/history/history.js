'use strict';

let allEntries = [];

function formatTimestamp(iso) {
    return new Date(iso).toLocaleString();
}

function getEls() {
    // re-queried every call rather than cached — views.js rebuilds this DOM from scratch
    // on each History tab open, so cached refs would go stale
    return {
        listEl: document.getElementById('list'),
        emptyEl: document.getElementById('empty'),
        countEl: document.getElementById('count'),
        searchEl: document.getElementById('search'),
    };
}

function render(entries) {
    const { listEl, emptyEl, countEl } = getEls();
    if (!listEl) return; // view may have been switched away before an async op (delete, load) resolved
    // use allEntries, not `entries` — entries is the search-filtered list and would hide the button on a zero-match search
    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) clearBtn.style.display = allEntries.length ? '' : 'none';
    listEl.innerHTML = '';
    if (!entries.length) {
        emptyEl.style.display = 'block';
        countEl.textContent = '';
        return;
    }
    emptyEl.style.display = 'none';
    countEl.textContent = `${entries.length} download${entries.length !== 1 ? 's' : ''}`;
    entries.forEach(({ id, filename, infoFile, dlStats, siteUrl, timestamp }) => {
        const div = document.createElement('div');

        div.className = 'entry';
        div.innerHTML = `
        <div class="entry-filename">${filename}</div>
        <div class="entry-info">${infoFile}</div>
        ${dlStats ? `<div class="entry-stats">${dlStats}</div>` : ''}
        <a class="entry-url" href="${siteUrl}" target="_blank" title="${siteUrl}">${siteUrl}</a>
        <div class="entry-time">${formatTimestamp(timestamp)}</div>
        <button class="entry-delete" data-id="${id}" title="Delete">✕</button>
        `;

        const delBtn = div.querySelector('.entry-delete');
        let delStep = 0; // per-card closure — render() rebuilds cards, so every new card starts at 0
        let delTimer;

        delBtn.addEventListener('click', async () => {
            // 3 clicks: ✕ → 1 → 2 → delete. each click re-arms the 3s reset,
            // so a stray click doesn't leave the card half-armed forever
            if (delStep < 2) {
                delStep++;
                delBtn.textContent = String(delStep);
                delBtn.dataset.step = String(delStep);
                clearTimeout(delTimer);
                delTimer = setTimeout(() => {
                    delStep = 0;
                    delBtn.textContent = '✕';
                    delBtn.dataset.step = '';
                }, 3000);
                return;
            }
            clearTimeout(delTimer);
            // re-read storage instead of trusting in-memory allEntries — guards against a stale
            // delete if another view/tab wrote to history between render() and this click
            const { history = {} } = await chrome.storage.local.get('history');
            delete history[id];
            await chrome.storage.local.set({ history });
            allEntries = allEntries.filter(e => e.id !== id);
            render(filtered());
        });
        listEl.appendChild(div);
    });
}

function filtered() {
    const { searchEl } = getEls();
    const q = searchEl?.value.trim().toLowerCase() || '';
    if (!q) return allEntries;
    return allEntries.filter(e =>
        e.filename.toLowerCase().includes(q) ||
        e.siteUrl.toLowerCase().includes(q)
    );
}

async function load() {
    const { searchEl } = getEls();
    const { history = {} } = await chrome.storage.local.get('history');
    allEntries = Object.entries(history)
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    render(filtered());

    // re-attach listeners every load since DOM is fresh
    searchEl?.addEventListener('input', () => render(filtered()));

    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            // two-step confirm on the same button instead of a modal — cheaper UI, resets
            // automatically after 3s so an accidental first click doesn't leave a stuck trap
            if (clearBtn.dataset.confirm !== 'yes') {
                clearBtn.dataset.confirm = 'yes';
                clearBtn.textContent = '⚠ Click again to confirm';
                setTimeout(() => {
                    clearBtn.dataset.confirm = '';
                    clearBtn.textContent = '🗑 Clear All';
                }, 3000);
                return;
            }
            await chrome.storage.local.set({ history: {} });
            allEntries = [];
            render([]);
        });
    }
}

// exposed on window so views.js can trigger a (re)load after injecting/rewiring this view,
// since this script itself is only ever appended to the DOM once (see views.js historyScriptLoaded)
window.hlsHistoryLoad = load;
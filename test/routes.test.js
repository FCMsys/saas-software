'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'random.html'), 'utf8');

test('route navigation supports direct links, history and role fallback', () => {
    const location = new URL('https://example.org/spieltage/?intro=done&umfrage=old');
    const changes = [], listeners = {};
    const buttons = ['players', 'days', 'match', 'history', 'payments', 'advertising'].map(tab => ({ dataset: { tab }, classList: { toggle() {} } }));
    const context = vm.createContext({
        URL, location, TABS: buttons.map(b => b.dataset.tab), me: { role: 'admin' }, activeTab: '',
        document: { querySelectorAll: selector => selector === '.tab-btn' ? buttons : [] },
        localStorage: { setItem() {} }, renderChart() {}, loadSpieltage() {},
        history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_a, _b, url) => { changes.push([method, url]); location.href = new URL(url, location).href; }])),
        window: { scrollTo() {}, addEventListener: (type, fn) => { listeners[type] = fn; } }
    });
    vm.runInContext(html.slice(html.indexOf('        const TAB_PATHS'), html.indexOf('        // 8. Events')), context);
    assert.equal(context.tabFromPath(), 'days');
    context.showTab('days', 'none');
    assert.equal(context.activeTab, 'days');
    assert.equal(changes.length, 0);
    let prevented = false;
    buttons[3].onclick({ preventDefault() { prevented = true; }, button: 0 });
    assert.ok(prevented);
    assert.deepEqual(changes[0], ['pushState', '/historie?intro=done']);
    buttons[0].onclick({ ctrlKey: true, preventDefault() { throw Error('modified click intercepted'); } });
    location.pathname = '/spieltage';
    listeners.popstate();
    assert.equal(context.activeTab, 'days');
    assert.equal(changes.length, 1);
    context.me.role = 'player';
    context.showTab('advertising', 'replace');
    assert.equal(context.activeTab, 'players');
    assert.equal(changes.at(-1)[0], 'replaceState');
    assert.equal(location.pathname, '/spieler');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'random.html'), 'utf8');
function setup() {
    const controls = {};
    for (const key of ['fontSize', 'fontFamily', 'imageSize', 'flightSeconds', 'idleSeconds']) controls['ad_' + key] = { value: key === 'fontFamily' ? 'Arial' : '8' };
    function item() {
        const listeners = new Map();
        const element = { style: {}, parentElement: { getBoundingClientRect: () => ({ width: 400, height: 100 }) },
            getBoundingClientRect: () => ({ width: 80, height: 20 }),
            setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {},
            addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
            removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
            emit(type, event) { for (const fn of [...(listeners.get(type) || [])]) fn(event); }
        };
        return element;
    }
    controls.adEditorText = item(); controls.adEditorImage = item();
    const c = vm.createContext({ $: id => { assert.ok(controls[id], 'Missing control: ' + id); return controls[id]; } });
    vm.runInContext('const AD_DEFAULTS = { textX: 50, textY: 50, imageX: 20, imageY: 50, fontSize: 5, fontFamily: "Arial", imageSize: 28, flightSeconds: 8, idleSeconds: 5 }; let adFormDirty = false;', c);
    vm.runInContext(html.slice(html.indexOf('        let adPositions ='), html.indexOf('        function renderAdContent')), c);
    vm.runInContext(html.slice(html.indexOf('        function initAdDragging()'), html.indexOf("        $('adForm').onchange")), c);
    return { c, controls };
}
test('text and image drag positions are saved without coordinate inputs and stay within the flag', () => {
    const { c, controls } = setup();
    for (const [id, prefix] of [['adEditorText', 'text'], ['adEditorImage', 'image']]) {
        const element = controls[id];
        element.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
        element.emit('pointermove', { pointerId: 1, clientX: 5000, clientY: -5000, preventDefault() {} });
        element.emit('pointerup', { pointerId: 1 });
        const saved = c.adFormSettings();
        assert.equal(saved[prefix + 'X'], 90);
        assert.equal(saved[prefix + 'Y'], 10);
        assert.equal(element.style.left, '90%');
        element.emit('pointermove', { pointerId: 1, clientX: 0, clientY: 0 });
        assert.equal(c.adFormSettings()[prefix + 'X'], 90);
    }
    assert.equal(vm.runInContext('adFormDirty', c), true);
});
test('clicking text without dragging preserves position and native image drag is suppressed', () => {
    const { c, controls } = setup();
    const element = controls.adEditorText;
    element.emit('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    element.emit('pointermove', { pointerId: 1, clientX: 102, clientY: 100 });
    element.emit('pointercancel', { pointerId: 1 });
    assert.equal(c.adFormSettings().textX, 50);
    assert.equal(vm.runInContext('adFormDirty', c), false);
    let prevented = false;
    controls.adEditorImage.emit('dragstart', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
});

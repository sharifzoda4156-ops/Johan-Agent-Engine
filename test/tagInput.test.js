import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createTagInput } from '../src/tagInput.js';

function setup(options = {}) {
  const dom = new JSDOM('<div id="root"></div>');
  const container = dom.window.document.getElementById('root');
  const api = createTagInput(container, options);
  return { dom, container, api };
}

test('creates a fresh JSDOM per test and mounts the component into #root', () => {
  const { container, api } = setup();

  assert.ok(container.querySelector('ul.tags'));
  assert.ok(container.querySelector('input.tag-input'));
  assert.deepEqual(api.getTags(), []);
});

test('each test gets an isolated JSDOM instance', () => {
  const first = setup({ initial: ['alpha'] });
  const second = setup({ initial: ['beta'] });

  assert.notEqual(first.dom, second.dom);
  assert.notEqual(first.container, second.container);
  assert.deepEqual(first.api.getTags(), ['alpha']);
  assert.deepEqual(second.api.getTags(), ['beta']);
});

function keydown(dom, input, key) {
  const event = new dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  return event;
}

function typeInput(dom, input, value) {
  input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function blur(dom, input) {
  input.dispatchEvent(new dom.window.Event('blur', { bubbles: true }));
}

test('Enter adds a normalized tag, clears the field and calls preventDefault', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = '  Alpha ';
  const event = keydown(dom, input, 'Enter');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(api.getTags(), ['alpha']);
  assert.equal(input.value, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('"," adds a tag and calls preventDefault', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'beta';
  const event = keydown(dom, input, ',');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(api.getTags(), ['beta']);
  assert.equal(input.value, '');
});

test('Enter with empty value does nothing', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = '   ';
  keydown(dom, input, 'Enter');

  assert.deepEqual(api.getTags(), []);
});

test('invalid value on Enter keeps text and sets aria-invalid', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'bad tag!';
  keydown(dom, input, 'Enter');

  assert.deepEqual(api.getTags(), []);
  assert.equal(input.value, 'bad tag!');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
});

test('duplicate on Enter clears the field without adding a tag', () => {
  const { dom, container, api } = setup({ initial: ['alpha'] });
  const input = container.querySelector('input.tag-input');

  input.value = 'ALPHA';
  keydown(dom, input, 'Enter');

  assert.deepEqual(api.getTags(), ['alpha']);
  assert.equal(input.value, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('input event with commas adds leading parts and keeps the remainder', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  typeInput(dom, input, 'a, b,c');

  assert.deepEqual(api.getTags(), ['a', 'b']);
  assert.equal(input.value, 'c');
});

test('input event silently drops invalid parts and duplicates', () => {
  const { dom, container, api } = setup({ initial: ['a'] });
  const input = container.querySelector('input.tag-input');

  typeInput(dom, input, 'a, bad tag!,b,');

  assert.deepEqual(api.getTags(), ['a', 'b']);
  assert.equal(input.value, '');
});

test('Backspace on empty field removes the last tag', () => {
  const { dom, container, api } = setup({ initial: ['a', 'b'] });
  const input = container.querySelector('input.tag-input');

  input.value = '';
  keydown(dom, input, 'Backspace');

  assert.deepEqual(api.getTags(), ['a']);
});

test('Backspace with text in the field does not remove a tag', () => {
  const { dom, container, api } = setup({ initial: ['a', 'b'] });
  const input = container.querySelector('input.tag-input');

  input.value = 'x';
  keydown(dom, input, 'Backspace');

  assert.deepEqual(api.getTags(), ['a', 'b']);
});

test('blur adds a valid value and clears the field', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'gamma';
  blur(dom, input);

  assert.deepEqual(api.getTags(), ['gamma']);
  assert.equal(input.value, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);
});

test('blur keeps an invalid value and sets aria-invalid', () => {
  const { dom, container, api } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'bad tag!';
  blur(dom, input);

  assert.deepEqual(api.getTags(), []);
  assert.equal(input.value, 'bad tag!');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
});

test('clicking .tag-remove removes the tag and focuses the input', () => {
  const { dom, container, api } = setup({ initial: ['a', 'b'] });
  const input = container.querySelector('input.tag-input');
  const button = container.querySelector('li.tag[data-tag="a"] .tag-remove');

  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(api.getTags(), ['b']);
  assert.equal(dom.window.document.activeElement, input);
});

test('reaching maxTags disables the input and blocks extra tags', () => {
  const { dom, container, api } = setup({ maxTags: 2 });
  const input = container.querySelector('input.tag-input');

  input.value = 'a';
  keydown(dom, input, 'Enter');
  input.value = 'b';
  keydown(dom, input, 'Enter');

  assert.deepEqual(api.getTags(), ['a', 'b']);
  assert.equal(input.disabled, true);

  input.value = 'c';
  keydown(dom, input, 'Enter');
  assert.deepEqual(api.getTags(), ['a', 'b']);

  const button = container.querySelector('li.tag[data-tag="a"] .tag-remove');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(api.getTags(), ['b']);
  assert.equal(input.disabled, false);
});

test('onChange receives a copy after user changes and not without changes', () => {
  const calls = [];
  const { dom, container } = setup({ onChange: (tags) => calls.push(tags) });
  const input = container.querySelector('input.tag-input');

  input.value = 'a';
  keydown(dom, input, 'Enter');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['a']);

  calls[0].push('mutated');
  assert.deepEqual(container.querySelectorAll('li.tag').length, 1);

  input.value = 'a';
  keydown(dom, input, 'Enter');
  assert.equal(calls.length, 1);

  input.value = 'bad tag!';
  keydown(dom, input, 'Enter');
  assert.equal(calls.length, 1);
});

test('getTags returns a copy of the current tags', () => {
  const { api } = setup({ initial: ['a'] });

  const tags = api.getTags();
  tags.push('b');

  assert.deepEqual(api.getTags(), ['a']);
});

test('setTags replaces the set without calling onChange', () => {
  const calls = [];
  const { api } = setup({ onChange: (tags) => calls.push(tags) });

  api.setTags(['x', 'y']);

  assert.deepEqual(api.getTags(), ['x', 'y']);
  assert.equal(calls.length, 0);
});

test('setTags throws TypeError and keeps state for invalid input', () => {
  const { api } = setup({ initial: ['a'], maxTags: 2 });

  assert.throws(() => api.setTags('nope'), TypeError);
  assert.throws(() => api.setTags(['bad tag!']), TypeError);
  assert.throws(() => api.setTags(['a', 'b', 'c']), TypeError);

  assert.deepEqual(api.getTags(), ['a']);
});

test('initial with invalid tags throws TypeError', () => {
  assert.throws(() => setup({ initial: ['bad tag!'] }), TypeError);
  assert.throws(() => setup({ initial: 'nope' }), TypeError);
});

test('destroy removes markup and is safe to call twice', () => {
  const { container, api } = setup({ initial: ['a'] });

  api.destroy();
  assert.equal(container.querySelector('ul.tags'), null);
  assert.equal(container.querySelector('input.tag-input'), null);

  assert.doesNotThrow(() => api.destroy());
});

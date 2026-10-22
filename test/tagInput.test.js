import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { createTagInput } from '../src/tagInput.js';

function setup(options = {}) {
  const dom = new JSDOM('<div id="root"></div>');
  const container = dom.window.document.getElementById('root');
  const tagInput = createTagInput(container, options);
  return { dom, container, tagInput };
}

function typeAndEnter(dom, input, value) {
  input.value = value;
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }));
}

function pressKey(dom, input, key) {
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
  input.dispatchEvent(new dom.window.Event('blur'));
}

test('creates a fresh JSDOM and mounts the component into #root', () => {
  const { dom, container, tagInput } = setup();

  assert.ok(dom.window.document.getElementById('root') === container);
  assert.ok(container.querySelector('ul.tags'));
  assert.ok(container.querySelector('input.tag-input'));
  assert.deepEqual(tagInput.getTags(), []);

  tagInput.destroy();
  dom.window.close();
});

test('each test gets an isolated document', () => {
  const first = setup();
  const second = setup();

  assert.notEqual(first.dom.window.document, second.dom.window.document);
  assert.notEqual(first.container, second.container);

  first.tagInput.destroy();
  second.tagInput.destroy();
  first.dom.window.close();
  second.dom.window.close();
});

test('normalizes tags with trim and toLowerCase', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, '  JavaScript  ');

  assert.deepEqual(tagInput.getTags(), ['javascript']);
  assert.equal(input.value, '');

  tagInput.destroy();
  dom.window.close();
});

test('accepts only a-z, 0-9, -, а-я, ё', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'abc-123-привет-ё');
  assert.deepEqual(tagInput.getTags(), ['abc-123-привет-ё']);

  for (const bad of ['foo_bar', 'foo bar', 'foo!', 'foo.bar']) {
    typeAndEnter(dom, input, bad);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
  }
  assert.deepEqual(tagInput.getTags(), ['abc-123-привет-ё']);

  tagInput.destroy();
  dom.window.close();
});

test('enforces tag length between 1 and 30 characters', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'a');
  assert.deepEqual(tagInput.getTags(), ['a']);

  const thirty = 'a'.repeat(30);
  typeAndEnter(dom, input, thirty);
  assert.deepEqual(tagInput.getTags(), ['a', thirty]);

  const thirtyOne = 'b'.repeat(31);
  typeAndEnter(dom, input, thirtyOne);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(tagInput.getTags(), ['a', thirty]);

  tagInput.destroy();
  dom.window.close();
});

test('ignores empty input', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, '   ');
  assert.deepEqual(tagInput.getTags(), []);
  assert.equal(input.hasAttribute('aria-invalid'), false);

  tagInput.destroy();
  dom.window.close();
});

test('rejects duplicates after normalization', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');
  typeAndEnter(dom, input, '  JS  ');
  typeAndEnter(dom, input, 'Js');

  assert.deepEqual(tagInput.getTags(), ['js']);
  assert.equal(container.querySelectorAll('li.tag').length, 1);

  tagInput.destroy();
  dom.window.close();
});

test('sets aria-invalid for invalid input and clears it for valid input', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'bad tag!');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(tagInput.getTags(), []);

  typeAndEnter(dom, input, 'good');
  assert.equal(input.hasAttribute('aria-invalid'), false);
  assert.deepEqual(tagInput.getTags(), ['good']);

  tagInput.destroy();
  dom.window.close();
});

test('Enter adds a tag, clears the field and calls preventDefault', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'js';
  const event = pressKey(dom, input, 'Enter');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(tagInput.getTags(), ['js']);
  assert.equal(input.value, '');

  tagInput.destroy();
  dom.window.close();
});

test('comma keydown adds a tag and calls preventDefault', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = 'css';
  const event = pressKey(dom, input, ',');

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(tagInput.getTags(), ['css']);
  assert.equal(input.value, '');

  tagInput.destroy();
  dom.window.close();
});

test('input event splits comma-separated values and keeps the remainder', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeInput(dom, input, 'a, b,c');

  assert.deepEqual(tagInput.getTags(), ['a', 'b']);
  assert.equal(input.value, 'c');

  tagInput.destroy();
  dom.window.close();
});

test('Backspace on an empty field removes the last tag', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'one');
  typeAndEnter(dom, input, 'two');
  assert.deepEqual(tagInput.getTags(), ['one', 'two']);

  input.value = '';
  pressKey(dom, input, 'Backspace');

  assert.deepEqual(tagInput.getTags(), ['one']);

  tagInput.destroy();
  dom.window.close();
});

test('blur adds a valid value and flags an invalid one', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  input.value = '  Vue  ';
  blur(dom, input);
  assert.deepEqual(tagInput.getTags(), ['vue']);
  assert.equal(input.value, '');
  assert.equal(input.hasAttribute('aria-invalid'), false);

  input.value = 'bad tag';
  blur(dom, input);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.deepEqual(tagInput.getTags(), ['vue']);

  tagInput.destroy();
  dom.window.close();
});

test('clicking .tag-remove removes the tag and returns focus to the input', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');
  typeAndEnter(dom, input, 'css');

  const button = container.querySelector('li[data-tag="js"] .tag-remove');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(tagInput.getTags(), ['css']);
  assert.equal(container.querySelector('li[data-tag="js"]'), null);
  assert.equal(dom.window.document.activeElement, input);

  tagInput.destroy();
  dom.window.close();
});

test('disables the input when maxTags is reached and re-enables it after removal', () => {
  const { dom, container, tagInput } = setup({ maxTags: 2 });
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'one');
  assert.equal(input.disabled, false);

  typeAndEnter(dom, input, 'two');
  assert.equal(input.disabled, true);
  assert.deepEqual(tagInput.getTags(), ['one', 'two']);

  const button = container.querySelector('li[data-tag="one"] .tag-remove');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.equal(input.disabled, false);
  assert.deepEqual(tagInput.getTags(), ['two']);

  typeAndEnter(dom, input, 'three');
  assert.deepEqual(tagInput.getTags(), ['two', 'three']);
  assert.equal(input.disabled, true);

  tagInput.destroy();
  dom.window.close();
});

test('does not add extra tags beyond maxTags through any input path', () => {
  const { dom, container, tagInput } = setup({ maxTags: 2 });
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'one');
  typeAndEnter(dom, input, 'two');
  assert.equal(input.disabled, true);

  typeAndEnter(dom, input, 'three');
  assert.deepEqual(tagInput.getTags(), ['one', 'two']);

  input.value = 'four';
  pressKey(dom, input, ',');

  typeInput(dom, input, 'five,six');

  input.value = 'seven';
  blur(dom, input);

  assert.deepEqual(tagInput.getTags(), ['one', 'two']);
  assert.equal(container.querySelectorAll('li.tag').length, 2);
  assert.equal(input.disabled, true);

  tagInput.destroy();
  dom.window.close();
});

test('getTags returns a copy that does not affect the component', () => {
  const { dom, container, tagInput } = setup();
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');

  const snapshot = tagInput.getTags();
  snapshot.push('mutated');
  snapshot.length = 0;

  assert.deepEqual(tagInput.getTags(), ['js']);
  assert.equal(container.querySelectorAll('li.tag').length, 1);

  tagInput.destroy();
  dom.window.close();
});

test('setTags replaces the set without calling onChange', () => {
  const changes = [];
  const { dom, container, tagInput } = setup({ onChange: (tags) => changes.push(tags) });
  const input = container.querySelector('input.tag-input');

  tagInput.setTags(['  JS  ', 'CSS']);

  assert.deepEqual(tagInput.getTags(), ['js', 'css']);
  assert.equal(container.querySelectorAll('li.tag').length, 2);
  assert.deepEqual(changes, []);

  typeAndEnter(dom, input, 'html');
  assert.deepEqual(changes, [['js', 'css', 'html']]);

  tagInput.destroy();
  dom.window.close();
});

test('setTags throws TypeError for invalid input and leaves state unchanged', () => {
  const { dom, container, tagInput } = setup();

  typeAndEnter(dom, container.querySelector('input.tag-input'), 'js');

  assert.throws(() => tagInput.setTags(['ok', 'bad tag']), TypeError);
  assert.throws(() => tagInput.setTags('not-an-array'), TypeError);

  assert.deepEqual(tagInput.getTags(), ['js']);
  assert.equal(container.querySelectorAll('li.tag').length, 1);

  tagInput.destroy();
  dom.window.close();
});

test('setTags throws TypeError when exceeding maxTags and leaves state unchanged', () => {
  const { dom, container, tagInput } = setup({ maxTags: 2 });

  tagInput.setTags(['one', 'two']);
  assert.throws(() => tagInput.setTags(['one', 'two', 'three']), TypeError);

  assert.deepEqual(tagInput.getTags(), ['one', 'two']);
  assert.equal(container.querySelectorAll('li.tag').length, 2);

  tagInput.destroy();
  dom.window.close();
});

test('initial tags are validated like setTags', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const container = dom.window.document.getElementById('root');

  assert.throws(() => createTagInput(container, { initial: ['bad tag'] }), TypeError);

  dom.window.close();
});

test('onChange receives a copy that does not affect the component', () => {
  const changes = [];
  const { dom, container, tagInput } = setup({ onChange: (tags) => changes.push(tags) });
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');
  assert.deepEqual(changes, [['js']]);

  changes[0].push('mutated');
  assert.deepEqual(tagInput.getTags(), ['js']);

  tagInput.destroy();
  dom.window.close();
});

test('onChange is not called when user input does not change the set', () => {
  const changes = [];
  const { dom, container, tagInput } = setup({ onChange: (tags) => changes.push(tags) });
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');
  changes.length = 0;

  typeAndEnter(dom, input, '  JS  ');
  typeAndEnter(dom, input, 'bad tag!');
  typeAndEnter(dom, input, '   ');

  assert.deepEqual(changes, []);
  assert.deepEqual(tagInput.getTags(), ['js']);

  tagInput.destroy();
  dom.window.close();
});

test('destroy is idempotent and detaches all handlers', () => {
  const changes = [];
  const { dom, container, tagInput } = setup({ onChange: (tags) => changes.push(tags) });
  const input = container.querySelector('input.tag-input');

  typeAndEnter(dom, input, 'js');
  changes.length = 0;

  tagInput.destroy();
  assert.doesNotThrow(() => tagInput.destroy());

  assert.equal(container.querySelector('ul.tags'), null);
  assert.equal(container.querySelector('input.tag-input'), null);

  typeAndEnter(dom, input, 'css');
  input.value = 'html';
  pressKey(dom, input, ',');
  typeInput(dom, input, 'a,b');
  blur(dom, input);

  assert.deepEqual(changes, []);
  assert.deepEqual(tagInput.getTags(), []);

  dom.window.close();
});

const TAG_PATTERN = /^[a-z0-9\-а-яё]+$/;

function normalize(tag) {
  return String(tag).trim().toLowerCase();
}

function isValid(tag) {
  return tag.length >= 1 && tag.length <= 30 && TAG_PATTERN.test(tag);
}

function renderTag(doc, tag, removeLabel) {
  const item = doc.createElement('li');
  item.className = 'tag';
  item.dataset.tag = tag;
  item.textContent = tag;

  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.className = 'tag-remove';
  remove.setAttribute('aria-label', removeLabel(tag));
  remove.textContent = '×';

  item.appendChild(remove);
  return item;
}

export function createTagInput(container, options = {}) {
  const doc = container.ownerDocument;
  const removeLabel = options.removeLabel ?? ((tag) => `Remove ${tag}`);

  const list = doc.createElement('ul');
  list.className = 'tags';

  const input = doc.createElement('input');
  input.className = 'tag-input';
  input.type = 'text';
  input.setAttribute('aria-label', 'Tags');

  container.appendChild(list);
  container.appendChild(input);

  const tags = [];
  const maxTags = options.maxTags ?? 10;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const listeners = [];
  let destroyed = false;

  function on(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  function syncDisabled() {
    if (destroyed) return;
    input.disabled = tags.length >= maxTags;
  }

  function notifyChange() {
    if (destroyed) return;
    if (onChange) onChange(tags.slice());
  }

  function addTag(normalized) {
    if (destroyed) return false;
    if (!isValid(normalized)) return false;
    if (tags.includes(normalized)) return false;
    if (tags.length >= maxTags) return false;
    tags.push(normalized);
    list.appendChild(renderTag(doc, normalized, removeLabel));
    syncDisabled();
    notifyChange();
    return true;
  }

  function removeTag(tag) {
    if (destroyed) return false;
    const index = tags.indexOf(tag);
    if (index === -1) return false;
    tags.splice(index, 1);
    const item = list.querySelector(`li[data-tag="${tag}"]`);
    if (item) item.remove();
    syncDisabled();
    notifyChange();
    return true;
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      const value = normalize(input.value);
      if (value === '') return;
      if (!isValid(value)) {
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      if (tags.includes(value)) {
        input.value = '';
        input.removeAttribute('aria-invalid');
        return;
      }
      addTag(value);
      input.value = '';
      input.removeAttribute('aria-invalid');
      return;
    }

    if (event.key === 'Backspace' && input.value === '') {
      if (tags.length > 0) {
        removeTag(tags[tags.length - 1]);
      }
    }
  }

  function handleInput() {
    const value = input.value;
    if (!value.includes(',')) return;

    const lastComma = value.lastIndexOf(',');
    const head = value.slice(0, lastComma);
    const rest = value.slice(lastComma + 1);

    for (const part of head.split(',')) {
      const normalized = normalize(part);
      if (normalized === '') continue;
      if (!isValid(normalized)) continue;
      if (tags.includes(normalized)) continue;
      addTag(normalized);
    }

    input.value = rest;
  }

  function handleClick(event) {
    const button = event.target.closest('.tag-remove');
    if (!button) return;
    const item = button.closest('li[data-tag]');
    if (!item) return;
    removeTag(item.dataset.tag);
    input.focus();
  }

  function handleBlur() {
    const value = normalize(input.value);
    if (value === '') return;
    if (!isValid(value)) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    if (!tags.includes(value)) {
      addTag(value);
    }
    input.value = '';
    input.removeAttribute('aria-invalid');
  }

  function setTags(next) {
    if (destroyed) return;
    if (!Array.isArray(next)) {
      throw new TypeError('tags must be an array');
    }

    const normalized = [];
    for (const tag of next) {
      const value = normalize(tag);
      if (!isValid(value)) {
        throw new TypeError(`Invalid tag: ${String(tag)}`);
      }
      if (!normalized.includes(value)) {
        normalized.push(value);
      }
    }
    if (normalized.length > maxTags) {
      throw new TypeError(`Too many tags: max ${maxTags}`);
    }

    tags.length = 0;
    tags.push(...normalized);
    list.textContent = '';
    for (const tag of tags) {
      list.appendChild(renderTag(doc, tag, removeLabel));
    }
    syncDisabled();
  }

  on(input, 'keydown', handleKeydown);
  on(input, 'input', handleInput);
  on(input, 'blur', handleBlur);
  on(list, 'click', handleClick);

  setTags(options.initial ?? []);

  return {
    getTags() {
      return tags.slice();
    },
    setTags,
    addTag,
    removeTag,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const [target, type, handler] of listeners) {
        target.removeEventListener(type, handler);
      }
      listeners.length = 0;
      list.remove();
      input.remove();
      tags.length = 0;
      input.disabled = false;
    },
  };
}

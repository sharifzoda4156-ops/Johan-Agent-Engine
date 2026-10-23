export function normalizeTag(v) {
  return String(v).trim().toLowerCase();
}

export function isValidTag(t) {
  return /^[a-z0-9\-а-яё]{1,30}$/.test(t);
}

export function createTagInput(container, options = {}) {
  const {
    initial = [],
    maxTags = 10,
    onChange,
    removeLabel = (tag) => `Remove ${tag}`,
  } = options;

  const doc = container.ownerDocument;

  const list = doc.createElement('ul');
  list.className = 'tags';

  const input = doc.createElement('input');
  input.className = 'tag-input';
  input.type = 'text';
  input.setAttribute('aria-label', 'Tags');

  container.appendChild(list);
  container.appendChild(input);

  const tags = [];
  let destroyed = false;

  function emitChange() {
    if (typeof onChange === 'function') onChange([...tags]);
  }

  function syncDisabled() {
    input.disabled = tags.length >= maxTags;
  }

  function addTag(raw) {
    const tag = normalizeTag(raw);
    if (!isValidTag(tag)) return false;
    if (tags.includes(tag)) return false;
    if (tags.length >= maxTags) return false;
    tags.push(tag);
    render();
    syncDisabled();
    emitChange();
    return true;
  }

  function removeTag(tag) {
    const index = tags.indexOf(tag);
    if (index === -1) return false;
    tags.splice(index, 1);
    render();
    syncDisabled();
    emitChange();
    return true;
  }

  function render() {
    list.textContent = '';
    for (const tag of tags) renderTag(tag);
  }

  function handleKeydown(event) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      const raw = input.value;
      const tag = normalizeTag(raw);
      if (tag === '') return;
      if (isValidTag(tag) && !tags.includes(tag) && tags.length < maxTags) {
        addTag(raw);
        input.value = '';
        input.removeAttribute('aria-invalid');
      } else if (tags.includes(tag)) {
        input.value = '';
        input.removeAttribute('aria-invalid');
      } else {
        input.setAttribute('aria-invalid', 'true');
      }
    } else if (event.key === 'Backspace' && input.value === '') {
      if (tags.length > 0) removeTag(tags[tags.length - 1]);
    }
  }

  function handleInput() {
    const value = input.value;
    if (!value.includes(',')) return;
    const parts = value.split(',');
    const rest = parts.pop();
    for (const part of parts) {
      const tag = normalizeTag(part);
      if (tag === '') continue;
      if (isValidTag(tag) && !tags.includes(tag) && tags.length < maxTags) {
        addTag(part);
      }
    }
    input.value = rest;
  }

  function handleBlur() {
    const raw = input.value;
    const tag = normalizeTag(raw);
    if (tag === '') return;
    if (isValidTag(tag) && !tags.includes(tag) && tags.length < maxTags) {
      addTag(raw);
      input.value = '';
      input.removeAttribute('aria-invalid');
    } else if (tags.includes(tag)) {
      input.value = '';
      input.removeAttribute('aria-invalid');
    } else {
      input.setAttribute('aria-invalid', 'true');
    }
  }

  function handleListClick(event) {
    const button = event.target.closest('.tag-remove');
    if (!button) return;
    const li = button.closest('.tag');
    if (!li) return;
    const tag = li.getAttribute('data-tag');
    if (removeTag(tag)) input.focus();
  }

  input.addEventListener('keydown', handleKeydown);
  input.addEventListener('input', handleInput);
  input.addEventListener('blur', handleBlur);
  list.addEventListener('click', handleListClick);

  function validateTags(input) {
    if (!Array.isArray(input)) throw new TypeError('tags must be an array');
    const next = [];
    for (const raw of input) {
      const tag = normalizeTag(raw);
      if (!isValidTag(tag)) throw new TypeError(`invalid tag: ${raw}`);
      if (!next.includes(tag)) next.push(tag);
    }
    if (next.length > maxTags) throw new TypeError('too many tags');
    return next;
  }

  function setTags(input) {
    const next = validateTags(input);
    tags.length = 0;
    tags.push(...next);
    render();
    syncDisabled();
  }

  function getTags() {
    return [...tags];
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    input.removeEventListener('keydown', handleKeydown);
    input.removeEventListener('input', handleInput);
    input.removeEventListener('blur', handleBlur);
    list.removeEventListener('click', handleListClick);
    if (list.parentNode) list.parentNode.removeChild(list);
    if (input.parentNode) input.parentNode.removeChild(input);
  }

  function renderTag(tag) {
    const li = doc.createElement('li');
    li.className = 'tag';
    li.setAttribute('data-tag', tag);
    li.textContent = tag;

    const button = doc.createElement('button');
    button.className = 'tag-remove';
    button.type = 'button';
    button.setAttribute('aria-label', removeLabel(tag));
    button.textContent = '×';

    li.appendChild(button);
    list.appendChild(li);
  }

  setTags(initial);

  return { getTags, setTags, destroy };
}

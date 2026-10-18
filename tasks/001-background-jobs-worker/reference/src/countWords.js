// Количество последовательностей непробельных символов (по правилам JS \s).
export function countWords(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// src/wordCount.js
//
// Word counting helper used by the worker when processing a job.
//
// A "word" is a maximal run of non-whitespace characters, where whitespace is
// defined by JavaScript's `\s` character class (spaces, tabs, newlines, and
// other Unicode whitespace). This means:
//
//   countWords('Hello world') === 2
//   countWords('')            === 0
//   countWords('   ')         === 0
//
// The function is pure: it has no side effects and does not touch the database.

export function countWords(text) {
  if (text === undefined || text === null) {
    return 0;
  }
  const str = String(text);
  if (str.length === 0) {
    return 0;
  }
  // Split on runs of whitespace (\s+). Leading/trailing whitespace produces
  // empty tokens, which are filtered out. What remains are the maximal runs
  // of non-whitespace characters.
  const tokens = str.split(/\s+/).filter((token) => token.length > 0);
  return tokens.length;
}

export default countWords;

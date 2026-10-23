/**
 * Pure job-processing logic for the worker.
 *
 * No side effects: given the same `text`, `processJob` always returns the same
 * result. This keeps the worker's processing step trivially retryable — the
 * worker may re-run a job after a crash without any cleanup.
 */

/**
 * Count "words" as runs of non-whitespace characters, using JavaScript's `\s`
 * definition of whitespace. Empty strings and whitespace-only strings yield 0.
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

/**
 * Process a job's text and produce its result payload.
 *
 * @param {string} text
 * @returns {{ wordCount: number }}
 */
export function processJob(text) {
  return { wordCount: countWords(text) };
}

// Example source for the Markdown reports in this directory.
export function greeting(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('A nonempty name is required.');
  }

  const normalized = name.trim();
  return `Hello, ${normalized}!`;
}

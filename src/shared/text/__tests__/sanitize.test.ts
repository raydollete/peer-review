import { sanitizeModelText, stripCodeFences } from '../sanitize.js';

describe('sanitizeModelText', () => {
  it('strips a complete think block whose body contains braces', () => {
    const text = '<think>maybe {"a": 1} or {b}</think>\nThe answer.';
    expect(sanitizeModelText(text)).toBe('The answer.');
  });

  it('strips thinking-variant tags case-insensitively', () => {
    expect(sanitizeModelText('<THINKING>hidden</THINKING>Answer')).toBe('Answer');
    expect(sanitizeModelText('<Think>hidden</Think>Answer')).toBe('Answer');
  });

  it('strips multiple think blocks in one string', () => {
    const text = '<think>one</think>First. <think>two</think>Second.';
    expect(sanitizeModelText(text)).toBe('First. Second.');
  });

  it('drops everything from an unclosed think tag to end of string', () => {
    expect(sanitizeModelText('The answer.\n<think>truncated mid-reason')).toBe('The answer.');
    expect(sanitizeModelText('<think>only reasoning, no answer')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeModelText('\n\nFor a Bash linter, use awk.  ')).toBe(
      'For a Bash linter, use awk.',
    );
  });

  it('returns plain text unchanged apart from trimming', () => {
    expect(sanitizeModelText('No tags here, just < a comparison.')).toBe(
      'No tags here, just < a comparison.',
    );
  });
});

describe('stripCodeFences', () => {
  it('unwraps a json-labelled fence', () => {
    expect(stripCodeFences('```json\n{"ok": true}\n```')).toBe('{"ok": true}');
  });

  it('unwraps a bare fence', () => {
    expect(stripCodeFences('```\n{"ok": true}\n```')).toBe('{"ok": true}');
  });

  it('tolerates a missing closing fence by dropping the opening line', () => {
    expect(stripCodeFences('```json\n{"ok": true}')).toBe('{"ok": true}');
  });

  it('returns unfenced text unchanged apart from trimming', () => {
    expect(stripCodeFences(' {"ok": true} ')).toBe('{"ok": true}');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTextIntoChunks } from '../src/tts.js';

test('splitTextIntoChunks keeps short text intact', () => {
  const input = 'Short sentence. Another short sentence.';
  assert.deepEqual(splitTextIntoChunks(input, 120), [input]);
});

test('splitTextIntoChunks splits long text into bounded chunks', () => {
  const input = [
    'This is the first sentence in a longer paragraph.',
    'This is the second sentence, which should remain grouped when possible.',
    'This is a third sentence that pushes the chunk over the limit and should start a new chunk.',
  ].join(' ');

  const chunks = splitTextIntoChunks(input, 90);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 90);
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), input);
});

test('splitTextIntoChunks force-splits oversized sentences', () => {
  const input = 'word '.repeat(120).trim();
  const chunks = splitTextIntoChunks(input, 80);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 80);
  }
});

// Unit tests — Tool Naming Engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NamingEngine } from '../../forge/NamingEngine.js';

test('technical ids are slugified and unique', () => {
  const engine = new NamingEngine(() => ['file_scout'], () => ['File Scout']);
  assert.equal(engine.normalizeTechnicalId('File Scout!!!'), 'file_scout_2');
  assert.equal(engine.normalizeTechnicalId('vision capture'), 'vision_capture');
});

test('display names are human-friendly and unique', () => {
  const engine = new NamingEngine(() => [], () => ['Desktop Vision']);
  assert.equal(engine.resolveDisplayName('Desktop Vision', 'desktop_vision'), 'Desktop Vision 2');
  assert.equal(engine.resolveDisplayName('', 'file_scout'), 'File Scout');
});

test('fallback technical id used for garbage input', () => {
  const engine = new NamingEngine(() => [], () => []);
  assert.ok(engine.normalizeTechnicalId('###', 'nova_tool').length > 0);
});

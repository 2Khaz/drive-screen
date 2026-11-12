import test from 'node:test';
import assert from 'node:assert/strict';
import { RangeCache } from '../frontend/range-cache.js';

test('seek cache reuses partial ranges and does not share mutable parser buffers', () => {
  const cache = new RangeCache(8);
  const source = Uint8Array.from([1,2,3,4]).buffer;
  cache.put(10, source); new Uint8Array(source)[1]=99;
  const hit = cache.get(11); assert.equal(hit.fileStart,11); assert.deepEqual([...new Uint8Array(hit)],[2,3,4]);
  new Uint8Array(hit)[0]=88;
  assert.equal(new Uint8Array(cache.get(11))[0],2);
  assert.equal(cache.get(14),null);
});

test('seek cache evicts least recently used data within its byte budget', () => {
  const cache = new RangeCache(8);
  cache.put(0,new Uint8Array(4).buffer); cache.put(4,new Uint8Array(4).buffer); cache.get(0);
  cache.put(8,new Uint8Array(4).buffer);
  assert.equal(cache.get(4),null); assert.ok(cache.get(0)); assert.equal(cache.bytes,8);
  cache.put(0,new Uint8Array(2).buffer); assert.equal(cache.bytes,6);
  cache.put(20,new Uint8Array(10).buffer); assert.equal(cache.bytes,6);
});

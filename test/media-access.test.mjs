import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaAccess } from '../frontend/media-access.js';
test('page-only media access reuses credentials, refreshes 401, and checks file membership', async () => {
  const calls=[];
  const access=new MediaAccess(async id => {calls.push(id);return {token:'fresh',expiresAt:Date.now()+3600000,file:{id,size:22}};});
  access.seed([{id:'one',size:11},{id:'two',size:33}],{token:'warm',expiresAt:Date.now()+3600000});
  assert.equal((await access.get('one')).token,'warm');
  assert.equal((await access.get('two')).file.size,33);
  assert.deepEqual(calls,[]);
  assert.equal((await access.get('one',{force:true})).token,'fresh');
  await access.get('not-listed');assert.deepEqual(calls,['one','not-listed']);
  access.setFiles([{id:'two',size:44}]);
  await access.get('one');assert.deepEqual(calls,['one','not-listed','one']);
  access.seed([{id:'two'}],{token:'old',expiresAt:Date.now()+1000});await access.get('two');assert.equal(calls.at(-1),'two');
  const controller=new AbortController();controller.abort();await assert.rejects(access.get('two',{signal:controller.signal}),{name:'AbortError'});
  access.clear();await access.get('two');assert.equal(calls.length,5);
});
test('a response from an old session cannot populate credentials after logout', async () => {
  let finish;
  const access=new MediaAccess(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=access.get('one');access.clear();finish({token:'old',expiresAt:Date.now()+3600000,file:{id:'one'}});
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(access.access,null);assert.equal(access.files.size,0);
});

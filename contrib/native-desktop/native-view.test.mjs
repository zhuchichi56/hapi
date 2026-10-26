import test from 'node:test';
import assert from 'node:assert/strict';
import {presentHistory} from './native-view.mjs';
const view={id:'original',status:'active',historyComplete:true,turns:[{id:'turn',status:'inProgress',items:Array.from({length:200},(_,i)=>({id:String(i),role:i%5?'tool':'assistant',text:'message '+i,output:'x'.repeat(20000)}))}]};
test('initial history is bounded, keeps native identities and defers tool output',()=>{
 const page=presentHistory(view);assert.equal(page.turns[0].items.length,80);assert.equal(page.turns[0].items[0].id,'120');assert.equal(page.hasEarlier,true);assert.equal(page.id,'original');assert.ok(JSON.stringify(page).length<20000);assert.ok(page.turns[0].items.every(i=>!('output' in i)));
 const earlier=presentHistory(view,{before:page.before});assert.equal(earlier.turns[0].items[0].id,'40');assert.equal(earlier.turns[0].items.at(-1).id,'119');
 const first=presentHistory(view,{before:earlier.before});assert.equal(first.turns[0].items[0].id,'0');assert.equal(first.hasEarlier,false);
 const detail=presentHistory(view,{itemKey:page.turns[0].items[1].key});assert.equal(detail.item.output.length,20000);
});
test('unchanged polling is tiny, while status, text and requests invalidate revisions',()=>{
 const page=presentHistory(view);const same=presentHistory(view,{since:page.revision});assert.deepEqual(Object.keys(same),['id','revision','unchanged']);assert.ok(JSON.stringify(same).length<150);
 assert.notEqual(presentHistory({...view,status:'idle'}).revision,page.revision);
 assert.notEqual(presentHistory({...view,requests:[{id:'approval'}]}).revision,page.revision);
 const changed=structuredClone(view);changed.turns[0].items.at(-1).text='new';assert.notEqual(presentHistory(changed).revision,page.revision);
});
test('detail pagination preserves long output and invalid historical cursors fail explicitly',()=>{
 const v={...view,turns:[{id:'t',items:[{id:'a',role:'tool',text:'Bash',output:'z'.repeat(70000)}]}]};
 const page=presentHistory(v);const key=page.turns[0].items[0].key;
 const first=presentHistory(v,{itemKey:key}).item;assert.equal(first.output.length,64000);assert.equal(first.outputMore,true);
 const second=presentHistory(v,{itemKey:key,outputOffset:64000}).item;assert.equal(second.output.length,6000);assert.equal(second.outputMore,false);
 assert.throws(()=>presentHistory(v,{before:'missing'}),/历史位置/);
});

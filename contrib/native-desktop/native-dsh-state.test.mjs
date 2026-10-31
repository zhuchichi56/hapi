import test from 'node:test';
import assert from 'node:assert/strict';
import { delegationDirectories, delegationProcesses, attachDelegationState } from './native-dsh-state.mjs';
import { delegationRecord } from './native-delegation.mjs';
import { parseModelCatalog } from './native-models.mjs';
import { CodexRuntime, validateCommand } from './native-host.mjs';
import { EventEmitter } from 'node:events';
test('DSH directories use literal launcher arguments without executing shell expansion',()=>{
 assert.deepEqual(delegationDirectories('bash /skills/dsh_run.sh --detach --skill /skill BRIEF.md "work one" 6','/project'),['/project/work one']);
 assert.deepEqual(delegationDirectories('python3 -I /skills/dsh_status.py /tasks/a /tasks/b --tail 2 2>/dev/null'),['/tasks/a','/tasks/b']);
 assert.deepEqual(delegationDirectories('bash /skills/dsh_steer.sh /tasks/a "continue"'),['/tasks/a']);
 assert.deepEqual(delegationDirectories('bash /skills/dsh_run.sh brief "$(touch /tmp/never)"'),[]);
 assert.deepEqual(delegationDirectories(JSON.stringify({cmd:'bash /skills/dsh_run.sh brief task',workdir:'/project'})),['/project/task']);
});
test('shared delegation entry points associate the real task directory and executor',()=>{
 for(const [executor,label] of [['dsh','DSH'],['codex','Codex'],['antigravity','Antigravity']]) {
  const command=`bash /skills/delegate_run.sh --executor=${executor} --detach --skill /skill --effort high brief.md "task one" 1`;
  assert.deepEqual(delegationDirectories(command,'/project'),['/project/task one']);
  assert.equal(delegationRecord(command).label,label);
 }
 assert.deepEqual(delegationDirectories('bash /skills/delegate_run.sh --executor codex --model gpt-6.1-sol brief /tasks/codex'),['/tasks/codex']);
 assert.deepEqual(delegationDirectories('python3 -I /skills/codex_run.py --fresh brief /tasks/codex'),['/tasks/codex']);
 assert.deepEqual(delegationDirectories('bash /skills/antigravity_run.sh --resume brief /tasks/agy'),['/tasks/agy']);
 assert.deepEqual(delegationDirectories('bash /skills/delegate_run.sh brief "$(touch /tmp/never)"'),[]);
 assert.equal(delegationRecord('bash /skills/dsh_status.py /tasks/a').phase,'检查进度');
 assert.equal(delegationRecord('bash /skills/dsh_steer.sh /tasks/a next').phase,'续跑 / 纠偏');
});
test('agent activity trusts live executor processes and excludes quoted commands and zombies',()=>{
 const records=delegationProcesses(`
100 S /bin/bash /skills/dsh_run.sh brief /tasks/a
101 S /usr/bin/python3 -I /skills/codex_run.py brief /tasks/b
102 S /usr/bin/python3.12 -I /skills/antigravity_run.py --workdir /tasks/c
103 S /bin/zsh -c bash /skills/dsh_run.sh brief /tasks/false
104 Z /bin/bash /skills/dsh_run.sh brief /tasks/zombie
105 S rg dsh_run.sh
106 S /usr/local/bin/dsh --profile headless --task /tasks/a
107 S /usr/bin/python3 unrelated.py /skills/codex_run.py`);
 assert.deepEqual(records,[{pid:'100',label:'DSH'},{pid:'101',label:'Codex'},{pid:'102',label:'Antigravity'},{pid:'106',label:'DSH'}]);
});
test('concurrent DSH numbering is per current task, deduplicates checks, and resets after completion',async()=>{
 const item=(id,path)=>({id,text:'Bash',role:'tool',output:JSON.stringify({command:`bash /skills/dsh_run.sh brief ${path}`}),delegation:delegationRecord(`bash /skills/dsh_run.sh brief ${path}`)});
 const view={cwd:'/project',turns:[{id:'turn',items:[item('a','/task/a'),item('check','/task/a'),item('b','/task/b')]}]};
 let result=await attachDelegationState(view,async()=> 'running');
 assert.equal(result.delegations.running,2);assert.deepEqual(result.delegations.tasks.map(t=>t.number),[1,2]);
 assert.deepEqual(result.turns[0].items.map(i=>i.delegation.numbers),[[1],[1],[2]]);
 result=await attachDelegationState(view,async path=>path.endsWith('/a')?'completed':'running');
 assert.equal(result.delegations.running,1);assert.equal(result.delegations.tasks[1].number,1);
 assert.deepEqual(result.turns[0].items[0].delegation.numbers,[]);assert.equal(result.turns[0].items[0].delegation.state,'completed');
 result=await attachDelegationState(view,async()=> 'unknown');assert.equal(result.delegations.running,0);
 assert.equal(view.turns[0].items[0].delegation.state,undefined);
});
test('model catalog follows the installed App and creation passes only an explicit supported override',async()=>{
 const catalog=parseModelCatalog([{name:'create_thread',inputSchema:{properties:{model:{description:'Models: gpt-6.1-sol (Default; supported reasoning efforts: high), claude-sonnet-5-5 (Claude; supported reasoning efforts: medium).'}}}}]);
 assert.deepEqual(catalog.models.map(m=>m.id),['gpt-6.1-sol','claude-sonnet-5-5']);
 const calls=[];const runtime=new CodexRuntime({callerThreadId:'caller',desktop:Object.assign(new EventEmitter(),{}),callTool:async(name,args)=>{calls.push({name,args});return{threadId:'new'}}});
 runtime.models=async()=>catalog;
 await runtime.execute({op:'create',text:'default'});
 assert.equal(Object.hasOwn(calls[0].args,'model'),false);
 await runtime.execute({op:'create',text:'explicit',model:'claude-sonnet-5-5'});
 assert.equal(calls[1].args.model,'claude-sonnet-5-5');
 await assert.rejects(runtime.execute({op:'create',text:'unsupported',model:'unknown'}),/不支持/);
 assert.throws(()=>validateCommand({app:'claude',op:'create',text:'x',model:'test',actionId:'a'}),/model/);
});

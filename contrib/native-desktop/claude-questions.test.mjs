import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingClaudeQuestions,claudeQuestionRequest,claudeQuestionAnswer} from './claude-questions.mjs';
const question={question:'Choose a path',header:'Path',multiSelect:false,options:[{label:'Recommended',description:'Use the suggestion'},{label:'Review',description:'Review each item'}]};
const entries=[{type:'assistant',message:{content:[{type:'tool_use',id:'native-tool',name:'AskUserQuestion',input:{questions:[question]}}]}}];
const state={selectedId:'local_test',nodes:[
 {path:[0],role:'AXGroup',description:question.question},
 ...question.options.flatMap((option,i)=>[{path:[0,1,i],role:'AXCheckBox',title:option.label+' '+option.description,checked:false},{path:[0,1,i,0],role:'AXStaticText',value:option.label}]),
 {path:[0,1,2],role:'AXCheckBox',title:'',description:'Other',checked:false},
 {path:[0,2,1],role:'AXButton',title:'Submit'}]};
test('native transcript identity and exact visible question gate original control submissions',()=>{
 const pending=pendingClaudeQuestions(entries);const match=claudeQuestionRequest(state,pending);
 assert.equal(match.request.questions[0].question,question.question);
 const command={requestId:match.request.id,response:{answers:{0:{answers:['Recommended']}}}};
 assert.deepEqual(claudeQuestionAnswer(match,command),{groupPath:[0],question:question.question,optionTitles:['Recommended Use the suggestion','Review Review each item'],selectedTitles:['Recommended Use the suggestion']});
 assert.throws(()=>claudeQuestionAnswer(match,{...command,requestId:'old'}),/已变化/);
 assert.throws(()=>claudeQuestionAnswer(match,{...command,response:{answers:{0:{answers:['not a native choice']}}}}),/有效选项/);
 assert.equal(claudeQuestionRequest({...state,selectedId:''},pending),null);
 assert.deepEqual(pendingClaudeQuestions([{...entries[0],type:'api-request-blob'}]),[]);
 assert.equal(claudeQuestionRequest({...state,nodes:[...state.nodes,{path:[0,3],role:'AXButton',title:'Submit'}]},pending),null);
 assert.equal(claudeQuestionRequest(state,pendingClaudeQuestions([...entries,{type:'user',message:{content:[{type:'tool_result',tool_use_id:'native-tool'}]}}])),null);
 assert.notEqual(claudeQuestionRequest(state,[{...pending[0],id:'new-tool'}]).request.id,match.request.id);
});
test('multiple-choice selection stays bounded to the original question options',()=>{
 const pending=[{id:'multi',questions:[{...question,multiSelect:true}]}];
 const match=claudeQuestionRequest(state,pending);
 assert.equal(claudeQuestionAnswer(match,{requestId:match.request.id,response:{answers:{0:{answers:['Recommended','Review']}}}}).selectedTitles.length,2);
 const single=claudeQuestionRequest(state,pendingClaudeQuestions(entries));
 assert.throws(()=>claudeQuestionAnswer(single,{requestId:single.request.id,response:{answers:{0:{answers:['Recommended','Review']}}}}),/有效选项/);
});
test('a single original pending question remains addressable while another native chat is selected',async()=>{
 const {claudePendingQuestionRequest}=await import('./claude-questions.mjs');const pending=pendingClaudeQuestions(entries);
 assert.deepEqual(claudePendingQuestionRequest('local_test',pending),claudeQuestionRequest(state,pending).request);
 assert.equal(claudePendingQuestionRequest('local_test',[]),null);
 assert.equal(claudePendingQuestionRequest('local_test',[{id:'paged',questions:[question,question]}]),null);
});

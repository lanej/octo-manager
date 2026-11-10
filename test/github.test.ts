import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readPullRequestDetails } from '../src/github.js';

const url='https://github.com/owner/repo/pull/12';
test('review reads gate all message sources on public visibility and preserve source, timestamp and truncation',async()=>{
 const paths:string[]=[];
 const read=async(path:string)=>{
  paths.push(path);
  if(path==='repos/owner/repo/pulls/12')return {base:{repo:{private:false}},title:'Example PR',state:'open',head:{sha:'abc'}};
  if(path.includes('/reviews?'))return [{id:1,user:{login:'reviewer'},state:'CHANGES_REQUESTED',body:'Please fix the race.',submitted_at:'2026-11-08T12:00:00Z',commit_id:'older',html_url:url+'#pullrequestreview-1'}];
  if(path.includes('/pulls/12/comments?'))return [{id:2,user:{login:'reviewer'},body:'x'.repeat(5000),created_at:'2026-11-08T12:01:00Z',path:'src/worker.ts',line:14}];
  return Array.from({length:100},(_,i)=>({id:i+3,user:{login:'author'},body:'Done',created_at:'2026-11-08T12:02:00Z'}));
 };
 const details=await readPullRequestDetails(url,undefined,read);
 assert.equal(paths[0],'repos/owner/repo/pulls/12');assert.equal(paths.length,4);
 assert.equal(details.headSha,'abc');assert.equal(details.state,'open');assert.equal(details.mayHaveMoreMessages,true);
 assert.equal(details.messages.length,102);assert.equal(details.messages[0]!.state,'CHANGES_REQUESTED');assert.equal(details.messages[0]!.commitSha,'older');
 assert.equal(details.messages[1]!.path,'src/worker.ts');assert.equal(details.messages[1]!.line,14);assert.equal(details.messages[1]!.bodyMarkdown.length,4000);assert.equal(details.messages[1]!.bodyTruncated,true);
 assert(details.messages.every(m=>m.atMs>0));
 for(const visibility of [true,undefined]){
  let calls=0;
  await assert.rejects(readPullRequestDetails(url,undefined,async()=>{calls++;return {base:{repo:{private:visibility}}};}),/Only confirmed public/);
  assert.equal(calls,1);
 }
 let called=false;
 await assert.rejects(readPullRequestDetails('file:///etc/passwd',undefined,async()=>{called=true;}));assert.equal(called,false);
});

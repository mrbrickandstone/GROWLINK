#!/usr/bin/env node
'use strict';
// Candidate selection only. Event-free intervals never establish footage availability.
process.umask(0o077);
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve('.pilot/bridge'),events=[],seen=new Set();
const device=JSON.parse(fs.readFileSync(path.join(root,'camera-0.json'),'utf8')).device;
let cursor;
for(let page=0;page<50;page++) {
 const input=path.join(root,'history-input.json');fs.writeFileSync(input,JSON.stringify({device,...(cursor?{cursor}:{})}));
 const child=spawnSync(process.execPath,['scripts/cloud-pilot.cjs','history',input],{encoding:'utf8',timeout:120000});
 if(child.status!==0)throw new Error('HISTORY_REQUEST_FAILED');
 const file=path.join(root,'history.private.json'),result=JSON.parse(fs.readFileSync(file,'utf8'));
 if(result.status!==200||!Array.isArray(result.body?.data))throw new Error('INVALID_HISTORY_RESPONSE');
 fs.copyFileSync(file,path.join(root,`history-page-${page}.private.json`));
 for(const event of result.body.data){const a=event.attributes;if(!Number.isSafeInteger(a?.start)||!Number.isSafeInteger(a?.end)||a.end<a.start)throw new Error('INVALID_EVENT_TIME');events.push({start:a.start,end:a.end,type:a.event_type});}
 cursor=result.body.links?.next;
 console.log(JSON.stringify({pages:page+1,events:events.length,paginationComplete:!cursor}));
 if(!cursor){
  const linkedAt=JSON.parse(fs.readFileSync(path.join(root,'connection.private.json'),'utf8')).body.linkedAt;
  const end=Date.now()-300000,start=Math.max(linkedAt+300000,end-24*3600000),gaps=[];let position=start;
  for(const event of events.sort((a,b)=>a.start-b.start)){if(event.end<start||event.start>end)continue;const next=Math.min(end,event.start-60000);if(next-position>=1800000)gaps.push({start:position,end:next});position=Math.max(position,event.end+60000);}
  if(end-position>=1800000)gaps.push({start:position,end});
  const report={at:new Date().toISOString(),cameraName:'1',pages:page+1,eventCount:events.length,paginationComplete:true,windowStart:new Date(start).toISOString(),windowEnd:new Date(end).toISOString(),candidates:gaps.map(g=>({start:new Date(g.start).toISOString(),end:new Date(g.end).toISOString(),minutes:(g.end-g.start)/60000})),recordingCoverage:'NOT_DEMONSTRATED',note:'Owner recording configuration confirmation required before historical media requests.'};
  fs.writeFileSync(path.join(root,'quiet-candidates.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exit(0);
 }
 if(typeof cursor!=='string'||seen.has(cursor))throw new Error('INVALID_HISTORY_CURSOR');seen.add(cursor);
}
throw new Error('HISTORY_PAGINATION_LIMIT');

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {coverage,assessMedia,jobKey}=require('../../lib/security/coverage.cjs');
const {PilotStore}=require('../../lib/security/pilot-store.cjs');
const {validatePlan,checkQuietWindow,retryPolicy,followMedia,preserveMedia,hashFile,report}=require('../../lib/security/ring-pilot.cjs');
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'farber-pilot-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const mediaProbe={durationSeconds:60,width:1920,height:1080,decoded:true,frameTimelineValid:true};

test('coverage distinguishes tiny gaps, overlaps, out-of-window footage and unverified spans',()=>{
 assert.deepEqual(coverage(100,200,[{start:90,end:150,verified:true},{start:149,end:170,verified:true},{start:171,end:250,verified:true},{start:170,end:171,verified:false}]).gaps,[{start:170,end:171}]);
 assert.equal(coverage(100,200,[]).coveredMs,0);
 assert.throws(()=>coverage(200,100,[]));
});
test('requested time is never substituted for missing or shifted media timestamps',()=>{
 const req={start:100000,end:160000};
 assert.equal(assessMedia(req,{status:200,timestamp:100000},mediaProbe).complete,true);
 const shifted=assessMedia(req,{status:200,timestamp:101000},mediaProbe);assert.deepEqual(shifted.gaps,[{start:100000,end:101000}]);
 assert.equal(assessMedia(req,{status:200,timestamp:null},mediaProbe).verified,false);
 assert.equal(assessMedia(req,{status:206,timestamp:100000,length:1000},mediaProbe).verified,false);
 assert.equal(assessMedia(req,{status:206,timestamp:100000,length:null},mediaProbe).verified,false);
 assert.equal(assessMedia(req,{status:200,timestamp:100000},{...mediaProbe,decoded:false}).complete,false);
 assert.equal(assessMedia(req,{status:200,timestamp:100000},{...mediaProbe,frameTimelineValid:false}).complete,false);
});
test('pilot plan requires affirmative recording configuration evidence and consecutive past windows',()=>{
 const p={cameraId:'one',start:'2026-10-12T00:00:00Z',end:'2026-10-12T00:30:00Z',segmentSeconds:600,attestations:{eligibleModelVerified:true,continuousPowerVerified:true,subscriptionVerified:true,recording247EnabledVerified:true,recordingModesVerified:true,reviewedBy:'test operator',evidenceReference:'private commissioning record'}};
 const now=Date.parse('2026-10-13T00:00:00Z');assert.equal(validatePlan(p,now).requests.length,3);
 const overlap=validatePlan({...p,lookbackSeconds:1},now).requests;
 assert.equal(overlap[0].start,Date.parse(p.start)-1000);assert.equal(overlap[0].end-overlap[1].start,1000);
 assert.throws(()=>validatePlan({...p,lookbackSeconds:11},now),/LOOKBACK/);
 assert.throws(()=>validatePlan({...p,segmentSeconds:900,lookbackSeconds:1},now),/LOOKBACK/);
 assert.throws(()=>validatePlan({...p,attestations:{...p.attestations,recording247EnabledVerified:false}},now),/EVIDENCE/);
 assert.throws(()=>validatePlan({...p,start:'2026-10-13T00:00:00Z',end:'2026-10-13T00:30:00Z'},now));
 assert.notEqual(jobKey('a',null,1,2),jobKey('a','module',1,2));
});
test('planned overlap can establish full target coverage while shifted individual requests remain partial',t=>{
 const s=new PilotStore(temp(t));
 try {
  s.enqueue({cameraId:'one',componentId:null,start:900,end:1600});s.enqueue({cameraId:'one',componentId:null,start:1500,end:2200});
  let j=s.claim();s.finish(j,'partial',{assessment:{verified:true,actualStart:950,actualEnd:1610}});
  j=s.claim();s.finish(j,'partial',{assessment:{verified:true,actualStart:1550,actualEnd:2210}});
  const r=report(s,{start:new Date(1000).toISOString(),end:new Date(2000).toISOString()});
  assert.equal(r.technicalCoverage,'MEASURED_CONTIGUOUS');assert.deepEqual(r.coverage.gaps,[]);assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.productionApproved,false);
 }finally{s.close();}
});
test('quiet-window exclusion follows all pages and catches earlier long events and cursor loops',async()=>{
 let n=0;const ring={pilotRequest:async(op)=>{assert.equal(op,'history');return Response.json(n++===0?{data:[{attributes:{start:300,end:310,event_type:'motion'}}],links:{next:'/v1/history/devices/a/events?page[key]=one'}}:{data:[{attributes:{start:50,end:150,event_type:'on_demand'}}]});}};
 const result=await checkQuietWindow(ring,'a',100,200);assert.equal(result.verified,false);assert.equal(result.overlaps[0].type,'on_demand');
 const cycle={pilotRequest:async()=>Response.json({data:[],links:{next:'/v1/history/devices/a/events?page[key]=repeat'}})};
 assert.equal((await checkQuietWindow(cycle,'a',100,200)).reason,'HISTORY_CURSOR_CYCLE');
 const quiet={pilotRequest:async()=>Response.json({data:[]})};assert.equal((await checkQuietWindow(quiet,'a',100,200)).verified,true);
});
test('retries honor rate limits and never retry an old 416 or move the requested window',()=>{
 assert.equal(retryPolicy(416,1,200000,100000,'0'),null);
 assert.equal(retryPolicy(425,1,300000,100000,'0'),null);
 assert.equal(retryPolicy(403,1,200000,100000,'0'),null);
 assert.equal(retryPolicy(503,5,200000,100000,'0'),null);
 assert(retryPolicy(429,1,200000,100000,'60')>=260000);
 assert.equal(retryPolicy(429,1,200000,100000,'7200'),null);
});
test('media redirects cannot send credentials to another host or access a private URL',async()=>{
 let calls=0;
 const first=new Response(null,{status:303,headers:{location:'https://example.s3.amazonaws.com/clip?signature=private','x-media-timestamp':'123'}});
 const next=await followMedia(first,async(url,options)=>{calls++;assert.equal(options.headers,undefined);return new Response('x',{headers:{'content-type':'video/mp4'}});});
 assert.equal(calls,1);assert.equal(next.timestamp,123);
 for(const location of ['http://example.s3.amazonaws.com/clip','https://127.0.0.1/','https://evil.test/','https://amazonaws.com.evil.test/','https://user:pass@example.s3.amazonaws.com/'])
  await assert.rejects(followMedia(new Response(null,{status:303,headers:{location}})),/REVIEW/);
});
test('preservation is content addressed, idempotent, readback verified and rejects truncated downloads',async t=>{
 const root=temp(t);fs.mkdirSync(path.join(root,'originals'));
 const response=bytes=>new Response(bytes,{headers:{'content-type':'video/mp4','content-length':String(bytes.length)}});
 const a=await preserveMedia(response('first'),root,'job');const b=await preserveMedia(response('first'),root,'job');assert.equal(a.file,b.file);assert.equal(await hashFile(path.join(root,a.file)),a.sha256);
 const c=await preserveMedia(response('other'),root,'job');assert.notEqual(a.file,c.file);assert.equal(fs.readFileSync(path.join(root,a.file),'utf8'),'first');
 await assert.rejects(preserveMedia(new Response('short',{headers:{'content-type':'video/mp4','content-length':'999'}}),root,'truncated'),/TRUNCATED/);
 assert(fs.readdirSync(path.join(root,'originals')).every(x=>!x.endsWith('.part')));
});
test('a killed process leaves a durable leased job; restart recovers it and rejects stale worker writes',t=>{
 const root=temp(t),store=new PilotStore(root);const request={cameraId:'one',componentId:null,start:100,end:200};
 const id=store.enqueue(request);assert.equal(id,store.enqueue(request));assert.equal(store.list().length,1);store.close();
 const moduleFile=path.resolve(__dirname,'../../lib/security/pilot-store.cjs');
 const child=spawnSync(process.execPath,['-e',`const {PilotStore}=require(process.argv[1]);const s=new PilotStore(process.argv[2]);const j=s.claim(1000);process.stdout.write(JSON.stringify(j));process.exit(17);`,moduleFile,root],{encoding:'utf8'});
 assert.equal(child.status,17);const stale=JSON.parse(child.stdout);
 const restarted=new PilotStore(root);assert.equal(restarted.claim(2000),null);const next=restarted.claim(601001);assert.equal(next.id,id);assert.equal(next.attempts,2);
 assert.throws(()=>restarted.finish(stale,'complete',{fake:true}),/LEASE_LOST/);restarted.finish(next,'complete',{verified:true});assert.equal(restarted.claim(900000),null);
 assert.equal(restarted.attempts().length,1);restarted.close();
});
test('empty pilot report cannot report successful continuous recording',t=>{
 const store=new PilotStore(temp(t));const r=report(store,null);assert.equal(r.verdict,'NOT_PASSED');assert.equal(r.productionApproved,false);assert.equal(r.technicalCoverage,'NOT_DEMONSTRATED');store.close();
});
test('reconciliation removes coverage credit after local originals are lost or modified',async t=>{
 const {reconcileFiles}=require('../../lib/security/ring-pilot.cjs');
 const store=new PilotStore(temp(t));store.enqueue({cameraId:'one',start:100,end:200});const job=store.claim();
 const media=await preserveMedia(new Response('original',{headers:{'content-type':'video/mp4'}}),store.root,job.id);
 store.finish(job,'complete',{media,assessment:{verified:true,actualStart:100,actualEnd:200}});
 assert.equal((await reconcileFiles(store)).invalidated,0);
 fs.writeFileSync(path.join(store.root,media.file),'tampered');
 assert.equal((await reconcileFiles(store)).invalidated,1);assert.equal(store.list()[0].state,'queued');assert.equal(store.list()[0].result,null);store.close();
});
test('real media analysis detects a decodable fixture and rejects a corrupt file (synthetic, not Ring footage)',t=>{
 const {probeMedia}=require('../../lib/security/ring-pilot.cjs');const root=temp(t),file=path.join(root,'synthetic.mp4');
 const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-t','2','-c:v','libx264','-pix_fmt','yuv420p',file],{encoding:'utf8'});
 if(generated.error?.code==='ENOENT'){t.skip('FFmpeg not installed');return;}
 assert.equal(generated.status,0);const result=probeMedia(file);assert.equal(result.durationSeconds,2);assert.equal(result.frameCount,50);assert.equal(result.decoded,true);assert.equal(result.frameTimelineValid,true);assert.equal(result.width,320);
 const invalid=path.join(root,'invalid.mp4');fs.writeFileSync(invalid,'not video');assert.throws(()=>probeMedia(invalid),/FFPROBE/);
});

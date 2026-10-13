'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseHeaders}=require('../../lib/security/cloud-pilot-client.cjs');
const {cloudClient}=require('../../lib/security/cloud-pilot-client.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
test('bridge headers use final response, preserve actual timing and reject missing status',()=>{
 const h=parseHeaders('HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 206\r\nContent-Type: video/mp4\r\nX-Media-Timestamp: 123456\r\nX-Media-Length: 59000\r\n\r\n');
 assert.equal(h.get('x-media-timestamp'),'123456');assert.equal(h.get('x-media-length'),'59000');
 assert.throws(()=>parseHeaders('bad'),/INVALID_BRIDGE_HEADERS/);
});
test('cloud client signs exact requests, preserves partial bytes and records separate immutable attempts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'farber-cloud-test-'));
 try {
  fs.mkdirSync(path.join(root,'staging'));
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(root,'private.pem'),privateKey.export({type:'pkcs8',format:'pem'}));
  fs.writeFileSync(path.join(root,'staging/pilot-config.json'),JSON.stringify({pilotId:'unit'}));
  fs.writeFileSync(path.join(root,'deployment-url.txt'),'https://unit.vercel.app');
  let count=0;
  const runner=(cmd,args)=>{
   assert.equal(cmd,'vercel');assert(!args.some(a=>a.includes('Bearer')));
   const text=fs.readFileSync(args.at(-1),'utf8');
   const field=name=>JSON.parse(text.split('\n').find(s=>s.startsWith(name+' = ')).slice(name.length+3));
   const bytes=fs.readFileSync(field('data-binary').slice(1));
   const signature=text.match(/x-farber-pilot-signature: ([A-Za-z0-9_-]+)/)[1];
   assert(crypto.verify(null,bytes,publicKey,Buffer.from(signature,'base64url')));
   assert.deepEqual(JSON.parse(bytes).input,{device:'one'});
   fs.writeFileSync(field('output'),'original-bytes');
   fs.writeFileSync(field('dump-header'),'HTTP/2 206\r\nContent-Type: video/mp4\r\nContent-Length: 14\r\nX-Farber-Upstream-Status: 206\r\nX-Media-Timestamp: 123456\r\nX-Media-Length: 30000\r\n\r\n');
   count++;return {status:0,stdout:'206'};
  };
  const ring=cloudClient(root,runner);
  for(let i=0;i<2;i++){const r=await ring.pilotRequest('download',{device:'one',cursor:undefined});assert.equal(r.status,206);assert.equal(r.headers.get('x-media-length'),'30000');assert.equal(await r.text(),'original-bytes');}
  assert.equal(count,2);const files=fs.readdirSync(path.join(root,'responses'));
  assert.equal(files.filter(f=>f.endsWith('.receipt.json')).length,2);assert.equal(files.filter(f=>f.endsWith('.curl')).length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('observed official Ring media redirect host is allowed only for video download and receives no bearer',async()=>{
 const {followMedia}=require('../../lib/security/ring-pilot.cjs');let calls=0;
 const location='https://download-us-east-1.prod.phoenix.devices.amazon.dev/v1/download?req_type=video_download&security_token=fixture';
 const r=await followMedia(new Response(null,{status:303,headers:{location}}),async(url,options)=>{calls++;assert.equal(options.headers,undefined);assert.equal(options.redirect,'manual');return new Response('video',{headers:{'content-type':'video/mp4'}})});
 assert.equal(r.redirects,1);assert.equal(calls,1);
 for(const bad of [location.replace('video_download','image_download'),location.replace('/v1/download','/other'),location.replace('amazon.dev','amazon.dev.example.com')])await assert.rejects(followMedia(new Response(null,{status:303,headers:{location:bad}})),/HOST_REVIEW/);
});
test('reviewed-host resumption preserves the request and original attempt; other blocked jobs cannot be silently reset',()=>{
 const {PilotStore}=require('../../lib/security/pilot-store.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'farber-resume-test-'));const s=new PilotStore(root);
 try{const req={cameraId:'one',componentId:null,start:1000,end:61000};const id=s.enqueue(req);const j=s.claim();s.finish(j,'blocked',{code:'MEDIA_REDIRECT_REQUIRES_HOST_REVIEW'});s.requeueReviewedHost(id);assert.deepEqual(s.list()[0].request,req);assert.equal(s.claim().attempts,2);assert.equal(s.attempts()[0].result.code,'MEDIA_REDIRECT_REQUIRES_HOST_REVIEW');assert.throws(()=>s.requeueReviewedHost(id),/NOT_BLOCKED/);}finally{s.close();fs.rmSync(root,{recursive:true,force:true})}
});

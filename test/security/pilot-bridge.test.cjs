'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const {authenticate,createHandler}=require('../../lib/security/pilot-bridge.cjs');
const {Writable}=require('node:stream');
function setup(operation='inventory') {
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const config={pilotId:'test-pilot',expiresAt:Date.now()+600000,publicKey};
 const body={pilotId:config.pilotId,at:Date.now(),nonce:crypto.randomBytes(32).toString('hex'),operation,input:{}};
 const sign=b=>crypto.sign(null,Buffer.from(JSON.stringify(b)),privateKey).toString('base64url');
 return {config,body,sign};
}
test('pilot authentication rejects expired, modified, stale, wrong-audience and nonmetadata requests',()=>{
 const {config,body,sign}=setup();assert.equal(authenticate(config,body,sign(body)),body);
 assert.throws(()=>authenticate({...config,expiresAt:0},body,sign(body)),/EXPIRED/);
 assert.throws(()=>authenticate(config,{...body,input:{device:'changed'}},sign(body)),/UNAUTHORIZED/);
 for(const bad of [{...body,at:body.at-61000},{...body,pilotId:'other'},{...body,nonce:'bad'}])assert.throws(()=>authenticate(config,bad,sign(bad)),/STALE_OR_INVALID/);
 for(const operation of ['stream','stop','download','webhook','link']){const bad={...body,operation};assert.throws(()=>authenticate(config,bad,sign(bad)),/UNSUPPORTED/);}
});
test('bridge rejects nonce replay across instances and never returns token configuration',async()=>{
 const {config,body,sign}=setup();const seen=new Set();let calls=0;
 const env={KV_REST_API_URL:'https://unit.upstash.io',KV_REST_API_TOKEN:'unit-secret'};
 const fetcher=async(url,options)=>{const command=JSON.parse(options.body);assert.equal(url,'https://unit.upstash.io');const fresh=!seen.has(command[1]);seen.add(command[1]);return Response.json({result:fresh?'OK':null});};
 const invoke=async(signature)=>{const handler=createHandler(config,{env,fetcher,ringFactory:()=>({pilotRequest:async()=>{calls++;return Response.json({data:[]});}})});const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.headers={'x-farber-pilot-signature':signature};const res={setHeader(){},status(code){this.code=code;return this},json(value){this.value=value;}};await handler(req,res);return res;};
 assert.equal((await invoke('bad')).code,401);assert.equal(calls,0);
 const result=await invoke(sign(body));assert.equal(result.code,200);assert.deepEqual(result.value.body,{data:[]});assert(!JSON.stringify(result.value).includes('unit-secret'));
 assert.equal((await invoke(sign(body))).code,409);assert.equal(calls,1);
});
test('historical download authority is restricted to one camera, after enablement and before readiness cutoff',()=>{
 const {config,body,sign}=setup('download'),now=Date.now();
 config.media={cameraId:'one',enabledAfter:now-1800000,endBefore:now+1000000,maxDurationMs:300000};
 body.input={device:'one',body:{timestamp:now-1200000,duration:300000}};
 assert.equal(authenticate(config,body,sign(body),now),body);
 for(const input of [
  {...body.input,device:'two'},
  {device:'one',body:{timestamp:now-1900000,duration:300000}},
  {device:'one',body:{timestamp:now-350000,duration:300000}},
  {device:'one',body:{timestamp:now-1200000,duration:900000}},
  {device:'one',body:{timestamp:now-1200000,duration:300000,video_options:{}}},
 ]){const bad={...body,input};assert.throws(()=>authenticate(config,bad,sign(bad),now),/OUTSIDE_PILOT/);}
 const live={...body,operation:'stream'};assert.throws(()=>authenticate(config,live,sign(live),now),/UNSUPPORTED/);
});
test('bridge streams partial media with vendor timing and no credential headers',async()=>{
 const {config,body,sign}=setup('download'),now=Date.now();
 config.media={cameraId:'one',enabledAfter:now-1800000,endBefore:now,maxDurationMs:300000};
 body.input={device:'one',body:{timestamp:now-1200000,duration:300000}};
 const handler=createHandler(config,{env:{KV_REST_API_URL:'https://unit.upstash.io',KV_REST_API_TOKEN:'unit-secret'},fetcher:async()=>Response.json({result:'OK'}),ringFactory:()=>({pilotRequest:async()=>new Response('partial-media',{status:206,headers:{'content-type':'video/mp4','content-length':'13','x-media-timestamp':'123456','x-media-length':'60000','authorization':'must-not-leave','set-cookie':'must-not-leave'}})})});
 const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.headers={'x-farber-pilot-signature':sign(body)};
 const chunks=[],headers={};const res=new Writable({write(chunk,encoding,done){chunks.push(chunk);done()}});
 res.setHeader=(k,v)=>{headers[k.toLowerCase()]=v};res.status=n=>{res.code=n;return res};res.flushHeaders=()=>{res.headersSent=true};
 await handler(req,res);assert.equal(res.code,206);assert.equal(Buffer.concat(chunks).toString(),'partial-media');
 assert.equal(headers['x-media-length'],'60000');assert.equal(headers['x-media-timestamp'],'123456');assert.equal(headers.authorization,undefined);assert.equal(headers['set-cookie'],undefined);
});

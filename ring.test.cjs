const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {client,authorized,validNonce,validSignature}=require('./lib/ring.cjs');
test('Ring authentication, nonce expiry and exact webhook signatures reject forged requests',()=>{
 const now=Date.now(),key='test-key',account='account-one',nonce=crypto.createHmac('sha256',key).update(`${now}:${account}`).digest('base64url');
 assert(validNonce(nonce,now,account,key,now));assert(!validNonce(nonce,now,account,key,now+600001));assert(!validNonce(nonce,now,account,key,now-1));assert(!validNonce(nonce,now,'other-account',key,now));
 const raw=Buffer.from('{ "a": 1 }'),sig='sha256='+crypto.createHmac('sha256',key).update(raw).digest('hex');assert(validSignature(raw,sig,key));assert(!validSignature(Buffer.from('{"a":1}'),sig,key));assert(!validSignature(raw,'',key));
 assert(authorized('Basic '+Buffer.from('farber:test-password').toString('base64'),'test-password'));assert(!authorized('Basic '+Buffer.from('farber:wrong').toString('base64'),'test-password'));assert(!authorized('',undefined));
});
test('Ring requires password before storage, linking or live requests',async()=>{const handler=require('./api/ring.js');for(const [action,method]of [['devices','GET'],['link','POST'],['stream','POST'],['stop','POST']]){const res={setHeader(){},status(code){this.code=code;return this},json(body){this.body=body}};await handler({query:{action},method,headers:{}},res);assert.equal(res.code,401)}});
test('Ring links only verified pending accounts, encrypts tokens, refreshes and manages live sessions',async()=>{
 const env={RING_CLIENT_ID:'client',RING_CLIENT_SECRET:'private-test-secret',RING_HMAC_KEY:'hmac',KV_REST_API_URL:'https://example.upstash.io',KV_REST_API_TOKEN:'redis'},db=new Map(),pending=new Map(),calls=[];let refreshes=0;
 const fetcher=async(url,opt={})=>{url=String(url);if(url==='https://example.upstash.io'){const [cmd,k,...a]=JSON.parse(opt.body);let result=null;if(cmd==='GET')result=db.get(k)||null;if(cmd==='SET'){if(a.includes('NX')&&db.has(k))result=null;else{db.set(k,a[0]);result='OK'}}if(cmd==='DEL'){db.delete(k);result=1}if(cmd==='EVAL'){db.delete('farber:ring:v1:lock');result=1}if(cmd==='ZADD')pending.set(a[1],Number(a[0]));if(cmd==='ZREMRANGEBYSCORE')for(const [v,t]of pending)if(t<=Number(a[1]))pending.delete(v);if(cmd==='ZRANGEBYSCORE')result=[...pending.keys()];if(cmd==='ZREM')pending.delete(a[0]);return {ok:true,json:async()=>({result})}}
  calls.push({url,opt});if(url.includes('oauth.ring.com')){if(opt.body.get('grant_type')==='refresh_token')refreshes++;return {ok:true,json:async()=>({access_token:'access-secret',refresh_token:'refresh-secret',expires_in:60})}}
  if(url.endsWith('/users/me'))return {ok:true,json:async()=>({data:{id:'account-one'}})};
  if(url.includes('/devices?'))return {ok:true,json:async()=>({data:[{type:'devices',id:'camera-one',attributes:{name:'Farber'},relationships:{status:{data:{type:'device-status',id:'status-one'}}}}],included:[{type:'device-status',id:'status-one',attributes:{online:true}}]})};
  if(url.endsWith('/sessions'))return {ok:true,headers:new Headers({location:'https://api.amazonvision.com/v1/devices/camera-one/media/streaming/whep/sessions/session-one'}),text:async()=> 'v=0\r\nanswer'};
  return {ok:true,json:async()=>({})};
 };
 const ring=client(env,fetcher);assert.deepEqual(await ring.devices(),{linked:false,devices:[]});await ring.receiveCode('code');assert([...db.values()].every(v=>!v.includes('access-secret')&&!v.includes('refresh-secret')));
 await assert.rejects(ring.link('forged',Date.now()),/could not be verified/);assert(!db.has('farber:ring:v1:active'));
 const now=Date.now(),nonce=crypto.createHmac('sha256','hmac').update(`${now}:account-one`).digest('base64url');assert.deepEqual(await ring.link(nonce,now),{linked:true});await assert.rejects(ring.link(nonce,now),/could not be verified/);
 const result=await ring.devices();assert.equal(result.devices[0].online,true);assert(refreshes>0);assert(!JSON.stringify(result).includes('secret'));
 const stream=await ring.stream('camera-one','v=0\r\noffer');assert.equal(stream.session,'session-one');await ring.stop('camera-one',stream.session);assert(calls.some(c=>c.opt.method==='DELETE'));await assert.rejects(ring.stop('camera-one','../escape'),/Invalid stream session/);
 const integration=calls.filter(c=>c.url.endsWith('/app-integrations'));assert.deepEqual(integration.map(c=>c.opt.method),['POST','PATCH']);
 await assert.rejects(ring.webhook(Buffer.from('{}'),'sha256=wrong'),/Invalid signature/);
});

test('Ring WHEP session URLs normalize opaque device IDs and relative references',()=>{
 const {streamSession}=require('./lib/ring.cjs'),device='ava1:ring.device.a+b=';
 const base='/v1/devices/'+device+'/media/streaming/whep/sessions/';
 assert.equal(streamSession('https://api.amazonvision.com'+base+'session:one=',device),'session:one=');
 assert.equal(streamSession(base+'session-one',device),'session-one');
 assert.equal(streamSession('sessions/session-one',device),'session-one');
 assert.equal(streamSession('/v1/devices/'+encodeURIComponent(device)+'/media/streaming/whep/sessions/session-one',device),'session-one');
 for(const url of [null,'','https://evil.example'+base+'session-one',base+'../escape',base+'%2fescape',base+'%252fescape',base+'session?token=x',base+'session#x',base.replace(device,'other')+'session',base+'%zz']){
  assert.throws(()=>streamSession(url,device),/RING_/);
 }
});

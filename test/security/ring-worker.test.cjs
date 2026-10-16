'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {client}=require('../../lib/ring.cjs');
function setup() {
 const env={RING_CLIENT_ID:'unit-client',RING_CLIENT_SECRET:'unit-secret',RING_HMAC_KEY:'unit-hmac',KV_REST_API_URL:'https://unit.upstash.io',KV_REST_API_TOKEN:'unit-redis'};
 const key=crypto.hkdfSync('sha256',env.RING_CLIENT_SECRET,'farber:ring:v1','token-encryption',32);
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const bytes=Buffer.concat([cipher.update(JSON.stringify({access:'old-token',refresh:'old-refresh',expires:Date.now()+3600000,linkedAt:1000})),cipher.final()]);
 const db=new Map([['farber:ring:v1:active',[iv,cipher.getAuthTag(),bytes].map(x=>x.toString('base64url')).join('.')]]);
 const calls=[];let first=true;
 const fetcher=async(url,options)=>{
  if(url==='https://unit.upstash.io') {const [cmd,k,...args]=JSON.parse(options.body);let result=null;if(cmd==='GET')result=db.get(k)||null;if(cmd==='SET'){if(args.includes('NX')&&db.has(k))result=null;else {db.set(k,args[0]);result='OK';}}if(cmd==='EVAL'){db.delete('farber:ring:v1:lock');result=1;}return Response.json({result});}
  calls.push({url,options});
  if(url==='https://oauth.ring.com/oauth/token')return Response.json({access_token:'new-token',refresh_token:'new-refresh',expires_in:14400,scope:'device:read'});
  if(first){first=false;return new Response(null,{status:401});}
  if(url.endsWith('/download'))return new Response('media',{headers:{'content-type':'video/mp4','x-media-timestamp':'2000'}});
  return Response.json({data:[]});
 };
 return {env,db,calls,fetcher};
}
test('worker refreshes once on 401, persists encrypted rotated credentials and a new worker can read them',async()=>{
 const {env,db,calls,fetcher}=setup();const ring=client(env,fetcher);
 const response=await ring.pilotRequest('download',{device:'one',body:{timestamp:2000,duration:1000}});assert.equal(response.status,200);
 assert.equal(calls.filter(c=>c.url.includes('oauth.ring.com')).length,1);
 const downloaded=calls.filter(c=>c.url.endsWith('/download'));assert.equal(downloaded.length,2);assert.equal(downloaded[0].options.body,downloaded[1].options.body);
 const restarted=client(env,fetcher);assert.equal((await restarted.pilotRequest('inventory')).status,200);
 assert.equal(calls.at(-1).options.headers.Authorization,'Bearer new-token');
 assert(!db.get('farber:ring:v1:active').includes('new-token'));assert(!db.get('farber:ring:v1:active').includes('new-refresh'));
 assert(calls.every(c=>!c.url.includes('/streaming/')&&!c.url.includes('/image/')));
});
test('pilot API rejects live operations, arbitrary pagination URLs, future downloads and transformation settings',async()=>{
 const {env,fetcher,calls}=setup();const ring=client(env,fetcher);
 await assert.rejects(ring.pilotRequest('stream',{device:'one'}),/Unsupported/);
 await assert.rejects(ring.pilotRequest('history',{device:'one',cursor:'https://evil.test/v1/history/devices/one/events?page[key]=secret'}),/pagination/);
 await assert.rejects(ring.pilotRequest('download',{device:'one',body:{timestamp:Date.now(),duration:1000}}),/window/);
 await assert.rejects(ring.pilotRequest('download',{device:'one',body:{timestamp:2000,duration:1000,video_options:{codec:'avc'}}}),/window/);
 assert.equal(calls.length,0);
});
test('public Ring handler never exposes worker operations',async()=>{
 const handler=require('../../api/ring.js');
 for(const action of ['download','inventory','history','refresh','connection']) {const res={setHeader(){},status(code){this.code=code;return this;},json(){}};await handler({query:{action},method:'POST',headers:{}},res);assert.equal(res.code,400);}
});

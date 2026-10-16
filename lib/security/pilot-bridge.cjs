'use strict';
const crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {client}=require('../ring.cjs');
const operations=new Set(['connection','inventory','status','capabilities','configurations','history','refresh']);
function reject(code,status=400) { const e=new Error(code);e.status=status;throw e; }
function authenticate(config,body,signature,now=Date.now()) {
 if(!Number.isSafeInteger(config.expiresAt)||now>=config.expiresAt)reject('PILOT_EXPIRED',410);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='at,input,nonce,operation,pilotId')reject('INVALID_REQUEST');
 const bytes=Buffer.from(JSON.stringify(body));
 if(bytes.length>16384||typeof signature!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(signature)||!crypto.verify(null,bytes,config.publicKey,Buffer.from(signature,'base64url')))reject('UNAUTHORIZED',401);
 if(body.pilotId!==config.pilotId||!Number.isSafeInteger(body.at)||Math.abs(now-body.at)>60000||!/^[a-f0-9]{64}$/.test(body.nonce))reject('STALE_OR_INVALID_REQUEST',401);
 if(!operations.has(body.operation)&&!(body.operation==='download'&&config.media))reject('UNSUPPORTED_OPERATION');
 if(!body.input||typeof body.input!=='object'||Array.isArray(body.input))reject('INVALID_INPUT');
 const keys=Object.keys(body.input);
 const allowed=['connection','inventory','refresh'].includes(body.operation)?[]:body.operation==='history'?['device','cursor']:body.operation==='download'?['device','body']:['device'];
 if(keys.some(k=>!allowed.includes(k)))reject('INVALID_INPUT');
 if(config.media&&body.input.device&&body.input.device!==config.media.cameraId)reject('CAMERA_OUTSIDE_PILOT',403);
 if(body.operation==='download') {
  const b=body.input.body,m=config.media;
  if(body.input.device!==m.cameraId||!b||!Number.isSafeInteger(b.timestamp)||!Number.isSafeInteger(b.duration)||b.duration<=0||b.duration>m.maxDurationMs||b.timestamp<m.enabledAfter||b.timestamp+b.duration>Math.min(m.endBefore,now-300000)||Object.keys(b).some(k=>!['timestamp','duration','components'].includes(k)))reject('WINDOW_OUTSIDE_PILOT',403);
 }
 return body;
}
async function claimNonce(config,nonce,env,fetcher) {
 const endpoint=env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL,token=env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN;
 let url;try{url=new URL(endpoint)}catch{reject('STORAGE_CONFIGURATION_REQUIRED',503)}
 if(!token||url.protocol!=='https:'||!url.hostname.endsWith('.upstash.io')||url.username||url.password||url.pathname!=='/'||url.search||url.hash)reject('STORAGE_CONFIGURATION_REQUIRED',503);
 const response=await fetcher(url.origin,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['SET',`farber:pilot:${config.pilotId}:nonce:${nonce}`,'used','NX','EX',180]),redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!response.ok)reject('PILOT_STORAGE_UNAVAILABLE',503);
 const result=await response.json();if(result.error)reject('PILOT_STORAGE_UNAVAILABLE',503);
 if(result.result!=='OK')reject('REQUEST_ALREADY_USED',409);
}
function createHandler(config,{env=process.env,fetcher=fetch,ringFactory=client}={}) {
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try {
   // Read a bounded raw body; Vercel body parsing is disabled by the staged wrapper.
   let raw=Buffer.alloc(0);for await(const chunk of req){raw=Buffer.concat([raw,Buffer.from(chunk)]);if(raw.length>16384)reject('REQUEST_TOO_LARGE',413);}
   let body;try{body=JSON.parse(raw.toString('utf8'))}catch{reject('INVALID_JSON')}
   authenticate(config,body,req.headers['x-farber-pilot-signature']);
   await claimNonce(config,body.nonce,env,fetcher);
   const result=await ringFactory(env,fetcher).pilotRequest(body.operation,body.input);
   if(!(result instanceof Response))return res.status(200).json({status:200,body:result});
   const status=result.status,headers={};
   for(const name of ['content-type','retry-after','x-media-timestamp','x-media-length','content-length','x-request-id'])if(result.headers.has(name))headers[name]=result.headers.get(name);
   if(body.operation==='download') {
    // Only this signed, expiring, camera/time-bounded pilot can retrieve historical bytes.
    // The worker persists the queue and originals; this function owns no recording job.
    if([200,206].includes(status)) {
     if(!/^(video\/mp4|application\/octet-stream)(;|$)/i.test(headers['content-type']||'')){await result.body?.cancel();reject('UNEXPECTED_MEDIA_TYPE',502);}
     res.status(status);for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
     res.setHeader('X-Farber-Upstream-Status',String(status));res.flushHeaders();
     let bytes=0;
     await pipeline(Readable.fromWeb(result.body),new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>512*1024*1024?new Error('MEDIA_TOO_LARGE'):null,chunk);}}),res);
     return;
    }
    if([301,302,303,307,308].includes(status)) {
     // Do not forward Ring credentials. The local worker validates the media host.
     const location=result.headers.get('location');await result.body?.cancel();
     return res.status(200).json({status,headers:{...headers,location}});
    }
   }
   // Never proxy authentication headers, redirects or media. This first bridge is metadata-only.
   if(status!==200){await result.body?.cancel();return res.status(200).json({status,headers,error:'RING_API_REJECTED_REQUEST'});}
   if(!headers['content-type']?.includes('application/json')){await result.body?.cancel();reject('UNEXPECTED_RING_RESPONSE',502);}
   const bytes=await result.text();if(bytes.length>2000000)reject('RING_METADATA_TOO_LARGE',502);
   return res.status(200).json({status,headers,body:JSON.parse(bytes)});
  } catch(e) {
   if(res.headersSent){res.destroy();return;}
   const code=e.message==='Connect your Ring account first.'?'RING_ACCOUNT_NOT_LINKED':e.message==='Ring authorization failed. Restart account linking.'?'RING_REAUTHORIZATION_REQUIRED':/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'PILOT_OPERATION_FAILED';
   return res.status(e.status||502).json({error:code});
  }
 };
}
module.exports={authenticate,claimNonce,createHandler};

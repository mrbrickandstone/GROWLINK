'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {spawnSync} = require('node:child_process');
const {windowRange, assessMedia, coverage} = require('./coverage.cjs');

function validatePlan(plan,now=Date.now()) {
  const start=Date.parse(plan.start),end=Date.parse(plan.end);
  windowRange(start,end);
  if(end>now-5*60000 || end-start>24*3600000)throw new Error('USE_A_PAST_WINDOW_BETWEEN_FIVE_MINUTES_AND_24_HOURS_LONG');
  if(typeof plan.cameraId!=='string'||!plan.cameraId||plan.cameraId.startsWith('REPLACE'))throw new Error('CAMERA_SELECTION_REQUIRED');
  if(plan.componentId!=null&&(typeof plan.componentId!=='string'||!plan.componentId))throw new Error('INVALID_COMPONENT');
  if(!Number.isInteger(plan.segmentSeconds)||plan.segmentSeconds<1||plan.segmentSeconds>900)throw new Error('SEGMENT_MUST_BE_1_TO_900_SECONDS');
  const lookback=plan.lookbackSeconds??0;
  if(!Number.isInteger(lookback)||lookback<0||lookback>10||plan.segmentSeconds+lookback>900)throw new Error('INVALID_BOUNDARY_LOOKBACK');
  const a=plan.attestations;
  if(!a||!['eligibleModelVerified','continuousPowerVerified','subscriptionVerified','recording247EnabledVerified','recordingModesVerified'].every(k=>a[k]===true)||!a.reviewedBy?.trim()||!a.evidenceReference?.trim())throw new Error('RECORDING_CONFIGURATION_EVIDENCE_REQUIRED');
  const requests=[];
  // Plan overlap explicitly before execution. Retries still use identical stored ranges.
  for(let s=start;s<end;s+=plan.segmentSeconds*1000) requests.push({cameraId:plan.cameraId,componentId:plan.componentId??null,start:s-lookback*1000,end:Math.min(end,s+plan.segmentSeconds*1000)});
  if(requests[0].start<0)throw new Error('INVALID_BOUNDARY_LOOKBACK');
  if(requests.length<2)throw new Error('AT_LEAST_TWO_CONSECUTIVE_REQUESTS_REQUIRED');
  return {start,end,requests};
}

async function inspectInventory(ring) {
  const response=await ring.pilotRequest('inventory');
  if(response.status!==200)throw new Error(`INVENTORY_HTTP_${response.status}`);
  const inventory=await response.json();
  if(!Array.isArray(inventory.data)||inventory.links?.next)throw new Error('INVENTORY_INCOMPLETE');
  return inventory;
}

// History only excludes windows contaminated by events. It NEVER establishes recording coverage.
async function checkQuietWindow(ring,device,start,end,maxPages=250) {
  let cursor,oldest=Infinity;
  const seen=new Set(),overlaps=[];
  for(let page=0;page<maxPages;page++) {
    const r=await ring.pilotRequest('history',{device,cursor});
    if(r.status!==200)return {verified:false,reason:`HISTORY_HTTP_${r.status}`,pages:page+1};
    const j=await r.json();
    if(!Array.isArray(j.data))return {verified:false,reason:'INVALID_HISTORY',pages:page+1};
    for(const e of j.data) {
      const a=e.attributes;
      if(a?.start==null||a?.end==null)return {verified:false,reason:'INVALID_EVENT_TIMESTAMPS',pages:page+1};
      const s=Number(a.start), t=Number(a.end);
      if(!Number.isSafeInteger(s)||!Number.isSafeInteger(t)||t<s)return {verified:false,reason:'INVALID_EVENT_TIMESTAMPS',pages:page+1};
      oldest=Math.min(oldest,s);
      if(s<end&&t>=start)overlaps.push({type:a.event_type,start:s,end:t});
    }
    const next=j.links?.next;
    // Exhaust pagination to catch long events whose start precedes this window.
    if(!next)return {verified:overlaps.length===0,reason:overlaps.length?'EVENTS_OVERLAP':'NO_EVENTS_IN_COMPLETE_HISTORY',pages:page+1,overlaps,oldestEvent:oldest===Infinity?null:oldest};
    if(seen.has(next))return {verified:false,reason:'HISTORY_CURSOR_CYCLE',pages:page+1};
    seen.add(next);cursor=next;
  }
  return {verified:false,reason:'HISTORY_PAGINATION_LIMIT'};
}

function retryPolicy(status,attempt,now,requestEnd,retryAfter) {
  if(attempt>=5)return null;
  if(status===425 && now>requestEnd+120000)return null;
  if(![425,429,500,502,503,504].includes(status))return null;
  let wait=Number(retryAfter)*1000;
  if(!Number.isFinite(wait)||wait<0)wait=Date.parse(retryAfter)-now;
  const base=Math.min(30000,5000*2**(attempt-1));
  // Bound unusually long Retry-After by stopping, never by retrying too early.
  if(wait>3600000)return null;
  const delay=Math.max(base,Number.isFinite(wait)?wait:0)+Math.floor(Math.random()*1000);
  if(status===425&&now+delay>requestEnd+120000)return null;
  return now+delay;
}

function mediaNumber(value) {return typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;}
async function followMedia(response,fetcher=fetch) {
  const initialHeaders={timestamp:mediaNumber(response.headers.get('x-media-timestamp')),length:mediaNumber(response.headers.get('x-media-length'))};
  let redirects=0;
  while([301,302,303,307,308].includes(response.status)) {
    if(++redirects>3)throw new Error('REDIRECT_LIMIT');
    const location=response.headers.get('location');
    if(!location)throw new Error('REDIRECT_WITHOUT_LOCATION');
    const url=new URL(location);
    // Presigned media hosts only. Never forward the Ring bearer token or signed URL to logs.
    // This exact Amazon-owned host/path was returned by the official video endpoint
    // during the 2026-10-13 pilot (303, req_type=video_download). Other regions stop
    // for review; this is a documented redirect flow, not an invented media API.
    const ringDownload=url.hostname==='download-us-east-1.prod.phoenix.devices.amazon.dev'&&url.pathname==='/v1/download'&&url.searchParams.get('req_type')==='video_download';
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!(ringDownload||/(^|\.)amazonaws\.com$|(^|\.)cloudfront\.net$/.test(url.hostname)))throw new Error('MEDIA_REDIRECT_REQUIRES_HOST_REVIEW');
    await response.body?.cancel();
    response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(60000)});
  }
  return {response,redirects,timestamp:mediaNumber(response.headers.get('x-media-timestamp'))??initialHeaders.timestamp,
    length:mediaNumber(response.headers.get('x-media-length'))??initialHeaders.length};
}
async function hashFile(file) {
  const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');
}
async function reconcileFiles(store) {
  let invalidated=0;
  for(const job of store.list().filter(j=>['complete','partial'].includes(j.state))) {
    const media=job.result?.media;
    const expected=media&&`originals/${job.id}.${media.sha256}.mp4`;
    let valid=false;
    if(media?.file===expected&&/^[a-f0-9]{64}$/.test(media.sha256)) {
      try{valid=await hashFile(path.join(store.root,expected))===media.sha256;}catch{}
    }
    if(!valid){store.invalidate(job.id);invalidated++;}
  }
  return {invalidated};
}
async function preserveMedia(response,root,jobId,maxBytes=512*1024*1024,beforeWrite=()=>{}) {
  if(!/^(video\/mp4|application\/octet-stream)(;|$)/i.test(response.headers.get('content-type')||''))throw new Error('NOT_MP4_MEDIA');
  const tmp=path.join(root,'originals',`${jobId}.${crypto.randomUUID()}.part`);
  const hash=crypto.createHash('sha256');let size=0;
  const measure=new Transform({transform(chunk,encoding,cb){try{beforeWrite(chunk.length);size+=chunk.length;if(size>maxBytes)return cb(new Error('MEDIA_TOO_LARGE'));hash.update(chunk);cb(null,chunk);}catch(e){cb(e);}}});
  try {
    await pipeline(Readable.fromWeb(response.body),measure,fs.createWriteStream(tmp,{flags:'wx',mode:0o600}));
    const declared=response.headers.get('content-length');
    if(!size||(declared!==null&&Number(declared)!==size))throw new Error('TRUNCATED_MEDIA');
    const fd=fs.openSync(tmp,'r');fs.fsyncSync(fd);fs.closeSync(fd);
    const sha256=hash.digest('hex'),name=`${jobId}.${sha256}.mp4`,dest=path.join(root,'originals',name);
    // Never replace a prior response; different bytes become another preserved version.
    try{fs.linkSync(tmp,dest);}catch(e){if(e.code!=='EEXIST')throw e;}
    if(await hashFile(dest)!==sha256)throw new Error('READBACK_HASH_MISMATCH');
    fs.unlinkSync(tmp);
    const dir=fs.openSync(path.dirname(dest),'r');fs.fsyncSync(dir);fs.closeSync(dir);
    return {file:`originals/${name}`,sha256,size,readbackVerified:true};
  } catch(e) {try{fs.unlinkSync(tmp);}catch{}throw e;}
}
function probeMedia(file, binaries={ffprobe:'ffprobe',ffmpeg:'ffmpeg'}) {
  const result=spawnSync(binaries.ffprobe,['-v','error','-show_format','-show_streams','-show_frames','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time,pkt_duration_time:stream=codec_name,width,height,r_frame_rate:format=duration','-of','json',file],{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
  if(result.error||result.status!==0)throw new Error('FFPROBE_UNAVAILABLE_OR_FAILED');
  let j;try{j=JSON.parse(result.stdout);}catch{throw new Error('INVALID_MEDIA_PROBE');}
  const video=j.streams?.[0],frames=j.frames||[];
  const times=frames.map(f=>Number(f.best_effort_timestamp_time));
  const [n,d]=(video?.r_frame_rate||'0/1').split('/').map(Number),fps=n/d;
  const maxGap=Number.isFinite(fps)&&fps>0?Math.max(0.1,2/fps):0;
  let worstFrameGap=0;
  const duration=Number(j.format?.duration);
  let valid=times.length>1&&maxGap>0&&Number.isFinite(duration)&&times.every(Number.isFinite);
  for(let i=1;i<times.length;i++){const diff=times[i]-times[i-1];worstFrameGap=Math.max(worstFrameGap,diff);if(diff<=0||diff>maxGap)valid=false;}
  if(valid&&(times[0]>maxGap||times[0]<0||duration-times.at(-1)>maxGap))valid=false;
  const decoded=spawnSync(binaries.ffmpeg,['-v','error','-xerror','-i',file,'-map','0:v:0','-f','null','-'],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  return {durationSeconds:duration,width:video?.width,height:video?.height,codec:video?.codec_name,fps,frameCount:times.length,worstFrameGapSeconds:worstFrameGap,frameTimelineValid:valid,decoded:!decoded.error&&decoded.status===0};
}
function report(store,plan) {
  const jobs=store.list(),spans=jobs.flatMap(j=>j.result?.assessment?.verified?[{start:j.result.assessment.actualStart,end:j.result.assessment.actualEnd,verified:true}]:[]);
  const range=plan?coverage(Date.parse(plan.start),Date.parse(plan.end),spans):null;
  const completed=jobs.length>=2&&jobs.every(j=>['complete','partial'].includes(j.state)&&j.result?.assessment?.verified)&&range?.gaps.length===0;
  return {generatedAt:new Date().toISOString(),verdict:'NOT_PASSED',technicalCoverage:completed?'MEASURED_CONTIGUOUS':'NOT_DEMONSTRATED',
    productionApproved:false,reason:completed?'Manual image quality, embedded time, vendor policy and end-to-end refresh/restart review still required.':'No complete verified consecutive historical export demonstrated.',
    quietWindow:store.meta('quietWindow'),refresh:store.meta('refresh'),runs:store.meta('runs')||[],coverage:range,jobs,attempts:store.attempts(),
    manualChecks:{embeddedTimestamp:'NOT_TESTED',clockAlignment:'NOT_TESTED',imageQuality:'NOT_TESTED',boundaryVisualContinuity:'NOT_TESTED',originalVendorAuthentication:'UNRESOLVED'},
    disclaimer:'Local pilot files are not a commissioned independent archive. Hashes prove post-download byte integrity, not camera-origin authenticity. Event metadata is only used to reject contaminated test windows.'};
}
module.exports={validatePlan,inspectInventory,checkQuietWindow,retryPolicy,followMedia,preserveMedia,probeMedia,report,hashFile,reconcileFiles};

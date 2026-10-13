#!/usr/bin/env node
'use strict';
// This runner never imports browser automation and cannot start a live view.
process.umask(0o077);
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {client}=require('../lib/ring.cjs');
const {cloudClient}=require('../lib/security/cloud-pilot-client.cjs');
const {PilotStore}=require('../lib/security/pilot-store.cjs');
const {assessMedia}=require('../lib/security/coverage.cjs');
const {validatePlan,inspectInventory,checkQuietWindow,retryPolicy,followMedia,preserveMedia,probeMedia,report,reconcileFiles}=require('../lib/security/ring-pilot.cjs');

const [command='preflight',planFile,...flags]=process.argv.slice(2);
const root=path.resolve(process.env.PILOT_DIR||'.pilot');
const envFile=path.resolve(process.env.PILOT_ENV_FILE||'.env.pilot.local');
if(fs.existsSync(envFile))process.loadEnvFile(envFile);
const store=new PilotStore(root);
const safeError=e=>/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'PILOT_OPERATION_FAILED';
const write=(name,value)=>{const file=path.join(root,name),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);};
const output=(value)=>console.log(JSON.stringify(value,null,2));
const toolsAvailable=()=>Object.fromEntries(['ffprobe','ffmpeg'].map(name=>[name,spawnSync(name,['-version'],{stdio:'ignore',timeout:5000}).status===0]));
function preflight() {
  const groups=[['RING_CLIENT_ID'],['RING_CLIENT_SECRET'],['RING_HMAC_KEY'],['UPSTASH_REDIS_REST_URL','KV_REST_API_URL'],['UPSTASH_REDIS_REST_TOKEN','KV_REST_API_TOKEN']];
  const missing=process.env.PILOT_BRIDGE_DIR?[]:groups.filter(g=>!g.some(k=>process.env[k])).map(g=>g.join(' or '));
  const mediaTools=toolsAvailable();
  const result={at:new Date().toISOString(),verdict:missing.length||Object.values(mediaTools).some(v=>!v)?'BLOCKED':'READY_FOR_INVENTORY',missing,mediaTools,liveViewRequests:0,footageRetrieved:0};
  write('preflight.json',result);store.meta('preflight',result);return result;
}
async function run() {
  if(command==='preflight'){const result=preflight();output(result);if(result.verdict==='BLOCKED')process.exitCode=2;return;}
  if(command==='report'){await reconcileFiles(store);write('report.json',report(store,store.meta('plan')));output({report:path.join(root,'report.json')});return;}
  if(!['inventory','run','refresh'].includes(command))throw new Error('USE_PREFLIGHT_INVENTORY_RUN_REFRESH_OR_REPORT');
  const check=preflight();
  if(check.missing.length)throw new Error('RING_CREDENTIAL_ACCESS_REQUIRED');
  const makeClient=()=>process.env.PILOT_BRIDGE_DIR?cloudClient(process.env.PILOT_BRIDGE_DIR):client();
  const ring=makeClient();
  if(command==='inventory') {
    const inventory=await inspectInventory(ring);write('inventory.private.json',inventory);
    const connection=await ring.pilotRequest('connection');store.meta('connection',connection);
    output({cameraCount:inventory.data.length,inventoryFile:path.join(root,'inventory.private.json'),scopeKnown:connection.scope!==null,
      note:'Inspect camera model/capabilities and confirm 24/7 subscription, continuous power, recording mode and schedule with the account owner. Online is not recording evidence.'});return;
  }
  if(command==='refresh') {
    const before=await ring.pilotRequest('connection');await ring.pilotRequest('refresh');
    // A fresh client uses persisted encrypted state instead of this process's access token.
    const restarted=makeClient();await inspectInventory(restarted);
    store.meta('refresh',{at:new Date().toISOString(),liveExchange:true,persistedCredentialsReadByNewClient:true,priorExpiry:before.expiresAt,
      processRestartTested:false});output({refresh:'PASS',processRestart:'NOT_TESTED'});return;
  }
  if(Object.values(check.mediaTools).some(v=>!v))throw new Error('FFMPEG_AND_FFPROBE_REQUIRED');
  if(!planFile)throw new Error('PLAN_FILE_REQUIRED');
  const plan=JSON.parse(fs.readFileSync(planFile,'utf8')),{start,end,requests}=validatePlan(plan);
  const priorPlan=store.meta('plan');
  if(priorPlan&&JSON.stringify(priorPlan)!==JSON.stringify(plan))throw new Error('USE_A_NEW_PILOT_DIR_FOR_A_DIFFERENT_PLAN');
  const connection=await ring.pilotRequest('connection');
  if(!Number.isSafeInteger(connection.linkedAt)||requests[0].start<connection.linkedAt)throw new Error('WINDOW_MUST_FOLLOW_APP_CONSENT');
  const inventory=await inspectInventory(ring);
  if(!inventory.data.some(d=>d.type==='devices'&&d.id===plan.cameraId))throw new Error('CAMERA_NOT_AUTHORIZED');
  write('inventory.private.json',inventory);
  for(const operation of ['status','capabilities','configurations']) {
    const response=await ring.pilotRequest(operation,{device:plan.cameraId});
    if(response.status!==200)throw new Error(`CAMERA_${operation.toUpperCase()}_HTTP_${response.status}`);
    const detail=await response.json();write(`${operation}.private.json`,detail);
    if(operation==='capabilities') {
      const items=detail.data?.attributes?.components?.items||[];
      if(items.length>1&&!plan.componentId)throw new Error('CAMERA_COMPONENT_REQUIRED');
      if(plan.componentId&&!items.some(c=>c.component_id===plan.componentId))throw new Error('CAMERA_COMPONENT_UNVERIFIED');
    }
  }
  const quiet=await checkQuietWindow(ring,plan.cameraId,requests[0].start,end);store.meta('quietWindow',quiet);
  if(!quiet.verified)throw new Error('QUIET_WINDOW_NOT_VERIFIED');
  store.meta('plan',plan);
  for(const request of requests)store.enqueue(request);
  await reconcileFiles(store);
  const runs=store.meta('runs')||[];runs.push({id:crypto.randomUUID(),startedAt:new Date().toISOString(),pid:process.pid});store.meta('runs',runs);
  let count=0;
  for(let job;(job=store.claim());) {
    let result,state;
    try {
      const req=job.request,body={timestamp:req.start,duration:req.end-req.start,...(req.componentId?{components:[{component_id:req.componentId}]}:{})};
      const raw=await ring.pilotRequest('download',{device:req.cameraId,body});
      result={at:new Date().toISOString(),initialHttpStatus:raw.status,requestedStart:req.start,requestedEnd:req.end};
      const {response,timestamp,length,redirects}=await followMedia(raw);
      Object.assign(result,{httpStatus:response.status,actualTimestamp:timestamp,actualLength:length,redirects});
      if([200,206].includes(response.status)) {
        const media=await preserveMedia(response,root,job.id);
        result.media=media; // Durable original remains if probing fails or the process stops here.
        const probe=probeMedia(path.join(root,media.file));
        const assessment=assessMedia(req,{status:response.status,timestamp,length},probe);
        Object.assign(result,{probe,assessment});state=assessment.complete?'complete':'partial';
      } else {
        const nextAt=retryPolicy(response.status,job.attempts,Date.now(),req.end,response.headers.get('retry-after'));
        await response.body?.cancel();
        state=nextAt?'queued':'failed';
        result.nextAttemptAt=nextAt;
      }
      store.finish(job,state,result,result.nextAttemptAt||0);
    } catch(e) {
      const code=safeError(e);
      const transient=e.name==='TypeError'||e.name==='AbortError'||e.name==='TimeoutError';
      const nextAt=transient?retryPolicy(503,job.attempts,Date.now(),job.request.end,null):null;
      store.finish(job,nextAt?'queued':'blocked',{...result,code,nextAttemptAt:nextAt},nextAt||0);
    }
    count++;
    write('report.json',report(store,plan));
    if(flags.includes('--one-job'))break;
  }
  const final=report(store,plan);write('report.json',final);
  output({processed:count,verdict:final.verdict,technicalCoverage:final.technicalCoverage,report:path.join(root,'report.json'),
    restart:'Rerun the same plan to resume queued work or reclaim expired leases. No timestamps are changed.'});
}
run().catch(e=>{const result={at:new Date().toISOString(),verdict:'BLOCKED',code:safeError(e),liveViewRequests:0};write('blocked.json',result);output(result);process.exitCode=2;}).finally(()=>store.close());

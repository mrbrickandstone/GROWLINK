'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {spawnSync}=require('node:child_process');
const quote=s=>'"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'\\r')+'"';
function parseHeaders(text) {
 const blocks=text.trim().split(/\r?\n\r?\n/),headers=new Headers();
 const block=blocks.filter(b=>/^HTTP\/\S+ \d{3}/.test(b)).at(-1);
 if(!block)throw new Error('INVALID_BRIDGE_HEADERS');
 for(const line of block.split(/\r?\n/).slice(1)){const n=line.indexOf(':');if(n>0)headers.append(line.slice(0,n),line.slice(n+1).trim());}
 return headers;
}
function cloudClient(root,runner=spawnSync) {
 root=path.resolve(root);
 const config=JSON.parse(fs.readFileSync(path.join(root,'staging/pilot-config.json'),'utf8'));
 const deployment=fs.readFileSync(path.join(root,'deployment-url.txt'),'utf8').trim(),url=new URL(deployment);
 if(url.protocol!=='https:'||!url.hostname.endsWith('.vercel.app')||url.origin!==deployment)throw new Error('INVALID_DEPLOYMENT');
 const privateKey=fs.readFileSync(path.join(root,'private.pem'));
 const records=path.join(root,'responses');fs.mkdirSync(records,{recursive:true,mode:0o700});
 return {async pilotRequest(operation,input={}) {
  const nonce=crypto.randomBytes(32).toString('hex');
  // Match the transmitted bytes exactly; omitted undefined cursor fields stay omitted.
  const body={pilotId:config.pilotId,at:Date.now(),nonce,operation,input};
  const bytes=JSON.stringify(body),signature=crypto.sign(null,Buffer.from(bytes),privateKey).toString('base64url');
  const stem=path.join(records,`${body.at}-${operation}-${nonce.slice(0,12)}`);
  const request=stem+'.request.json',response=stem+'.body',headersFile=stem+'.headers',curlConfig=stem+'.curl';
  fs.writeFileSync(request,bytes,{mode:0o600});
  fs.writeFileSync(curlConfig,[`request = "POST"`,`header = "Content-Type: application/json"`,`header = "x-farber-pilot-signature: ${signature}"`,`data-binary = ${quote('@'+request)}`,`output = ${quote(response)}`,`dump-header = ${quote(headersFile)}`,`write-out = "%{http_code}"`,'silent','max-time = 90','max-filesize = 536870912'].join('\n'),{mode:0o600});
  let r;try{r=runner('vercel',['curl','/api/pilot','--deployment',deployment,'--scope','team_jAJWNnxg9NdbPls1w9MD7Z7Q','--','--config',curlConfig],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});}finally{fs.unlinkSync(curlConfig);}
  if(fs.existsSync(response))fs.chmodSync(response,0o600);
  if(fs.existsSync(headersFile))fs.chmodSync(headersFile,0o600);
  const status=Number(r.stdout?.match(/(\d{3})\s*$/)?.[1]);
  fs.writeFileSync(stem+'.receipt.json',JSON.stringify({operation,at:body.at,httpStatus:status||null,transportExitCode:r.status,requestSha256:crypto.createHash('sha256').update(bytes).digest('hex')}),{mode:0o600});
  if(r.status!==0)throw new TypeError('BRIDGE_TRANSFER_INTERRUPTED');
  const headers=parseHeaders(fs.readFileSync(headersFile,'utf8'));
  if(status!==200&&status!==206)throw new Error(`BRIDGE_HTTP_${status}`);
  if(operation==='download'&&headers.get('x-farber-upstream-status')) {
   return new Response(Readable.toWeb(fs.createReadStream(response)),{status,headers});
  }
  if(fs.statSync(response).size>2000000)throw new Error('BRIDGE_METADATA_TOO_LARGE');
  let envelope;try{envelope=JSON.parse(fs.readFileSync(response,'utf8'))}catch{throw new Error('INVALID_BRIDGE_RESPONSE')}
  if(!Number.isInteger(envelope.status))throw new Error('BRIDGE_OPERATION_FAILED');
  if(['connection','refresh'].includes(operation)&&envelope.status===200)return envelope.body;
  const upstreamHeaders=new Headers(envelope.headers);
  // JSON envelopes carry upstream errors and private redirect URLs without auto-following.
  const content=JSON.stringify(envelope.body||{error:envelope.error});
  // Content-Length on redirects refers to the vendor response, not this JSON wrapper.
  upstreamHeaders.delete('content-length');
  return new Response(content,{status:envelope.status,headers:upstreamHeaders});
 }};
}
module.exports={cloudClient,parseHeaders};

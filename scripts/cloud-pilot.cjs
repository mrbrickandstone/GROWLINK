#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve('.pilot/bridge');
const [operation='inventory',inputFile]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(path.join(root,'staging/pilot-config.json'),'utf8'));
const deployment=fs.readFileSync(path.join(root,'deployment-url.txt'),'utf8').trim();
const url=new URL(deployment);if(url.protocol!=='https:'||!url.hostname.endsWith('.vercel.app')||url.origin!==deployment)throw new Error('INVALID_DEPLOYMENT');
const body={pilotId:config.pilotId,at:Date.now(),nonce:crypto.randomBytes(32).toString('hex'),operation,input:inputFile?JSON.parse(fs.readFileSync(inputFile,'utf8')):{}};
const signature=crypto.sign(null,Buffer.from(JSON.stringify(body)),fs.readFileSync(path.join(root,'private.pem'))).toString('base64url');
const request=path.join(root,'request.json'),response=path.join(root,`${operation}.private.json`),curlConfig=path.join(root,'request.curl');
fs.writeFileSync(request,JSON.stringify(body));
// curl config quoting, not shell interpolation. The short-lived signature never appears in argv.
const quote=s=>'"'+s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n').replace(/\r/g,'\\r')+'"';
fs.writeFileSync(curlConfig,[`request = "POST"`,`header = "Content-Type: application/json"`,`header = "x-farber-pilot-signature: ${signature}"`,`data-binary = ${quote('@'+request)}`,`output = ${quote(response)}`,`write-out = "%{http_code}"`,'silent','max-time = 90'].join('\n'));
const result=spawnSync('vercel',['curl','/api/pilot','--deployment',deployment,'--scope','team_jAJWNnxg9NdbPls1w9MD7Z7Q','--','--config',curlConfig],{encoding:'utf8',timeout:120000});
fs.unlinkSync(curlConfig);fs.unlinkSync(request);
if(result.status!==0){console.log(JSON.stringify({operation,error:'PROTECTED_PILOT_REQUEST_FAILED',exitCode:result.status}));process.exit(2);}
let value;try{value=JSON.parse(fs.readFileSync(response,'utf8'))}catch{console.log(JSON.stringify({operation,error:'NON_JSON_RESPONSE',response}));process.exit(2);}
console.log(JSON.stringify({operation,httpStatus:result.stdout.match(/\d{3}\s*$/)?.[0]?.trim(),upstreamStatus:value.status,error:value.error||null,response,
 ...(operation==='inventory'&&Array.isArray(value.body?.data)?{cameraCount:value.body.data.length,attributeKeys:[...new Set(value.body.data.flatMap(d=>Object.keys(d.attributes||{})))],includedTypes:[...new Set((value.body.included||[]).map(d=>d.type))]}:{}),
 ...(operation==='connection'?{connection:value.body}:{}),...(operation==='refresh'?{refresh:value.body}:{})},null,2));

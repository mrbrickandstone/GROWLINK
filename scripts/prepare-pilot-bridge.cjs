#!/usr/bin/env node
'use strict';
// Generates a minimal expiring pilot. Private signing key stays outside staging.
process.umask(0o077);
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.env.PILOT_BRIDGE_DIR||'.pilot/bridge');
if(fs.existsSync(root))throw new Error('BRIDGE_ALREADY_EXISTS');
const staging=path.join(root,'staging');fs.mkdirSync(path.join(staging,'api'),{recursive:true});
fs.mkdirSync(path.join(staging,'lib/security'),{recursive:true});fs.mkdirSync(path.join(staging,'.vercel'),{recursive:true});
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
const config={pilotId:crypto.randomUUID(),expiresAt:Date.now()+4*3600000,publicKey:publicKey.export({type:'spki',format:'pem'})};
if(process.argv[2]) {
 const media=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 if(typeof media.cameraId!=='string'||!media.cameraId||!Number.isSafeInteger(media.enabledAfter)||!Number.isSafeInteger(media.endBefore)||media.endBefore<=media.enabledAfter||media.endBefore-media.enabledAfter>86400000||!Number.isSafeInteger(media.maxDurationMs)||media.maxDurationMs<1000||media.maxDurationMs>900000)throw new Error('INVALID_MEDIA_AUTHORIZATION');
 config.media=media;
}
fs.writeFileSync(path.join(root,'private.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
fs.writeFileSync(path.join(staging,'pilot-config.json'),JSON.stringify(config));
fs.copyFileSync('.vercel/project.json',path.join(staging,'.vercel/project.json'));
for(const name of ['lib/ring.cjs','lib/security/pilot-bridge.cjs'])fs.copyFileSync(name,path.join(staging,name));
fs.writeFileSync(path.join(staging,'api/pilot.js'),"const {createHandler}=require('../lib/security/pilot-bridge.cjs');\nmodule.exports=createHandler(require('../pilot-config.json'));\nmodule.exports.config={api:{bodyParser:false}};\n");
fs.writeFileSync(path.join(staging,'package.json'),JSON.stringify({name:'farber-ring-metadata-pilot',private:true,engines:{node:'24.x'}}));
fs.writeFileSync(path.join(staging,'vercel.json'),JSON.stringify({framework:null,functions:{'api/pilot.js':{maxDuration:60}},headers:[{source:'/(.*)',headers:[{key:'Cache-Control',value:'no-store'},{key:'X-Robots-Tag',value:'noindex, nofollow'}]}]}));
fs.writeFileSync(path.join(staging,'index.html'),'<!doctype html><title>Private pilot</title><p>Private, temporary Ring metadata pilot.</p>');
console.log(JSON.stringify({staging,expiresAt:new Date(config.expiresAt).toISOString(),historicalDownloadsEnabled:!!config.media,liveViewEnabled:false}));

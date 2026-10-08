const crypto=require('node:crypto');
const cfg=require('../config.cjs');
function equal(a,b){const x=crypto.createHash('sha256').update(a).digest(),y=crypto.createHash('sha256').update(b).digest();return crypto.timingSafeEqual(x,y)}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 const key=process.env.GROWLINK_API_KEY,password=process.env.DASHBOARD_PASSWORD;
 if(!key||!password)return res.status(503).json({error:'Setup required: add GROWLINK_API_KEY and DASHBOARD_PASSWORD in Vercel, then redeploy.'});
 const auth=req.headers.authorization||'';
 let supplied='';try{const decoded=Buffer.from(auth.replace(/^Basic /,''),'base64').toString();supplied=decoded.slice(decoded.indexOf(':')+1)}catch{}
 if(!auth.startsWith('Basic ')||!equal(supplied,password))return res.status(401).json({error:'Enter your dashboard password.'});
 const mode=req.query.mode||'live';
 if(!['live','history','weather'].includes(mode))return res.status(400).json({error:'Unknown request'});
 const hours=Number(req.query.hours||24);
 if(mode!=='live'&&![1,24,72,168].includes(hours))return res.status(400).json({error:'Unsupported time range'});
 if(mode==='weather'){
  const end=Date.now(),start=end-hours*3600000;
  try{
   const windows=[];for(let a=start;a<end;a+=86400000)windows.push([a,Math.min(end,a+86400000)]);
   const batches=await Promise.all(windows.map(async([a,b])=>{
    const url=new URL('https://api.weather.gov/stations/KHWV/observations');url.searchParams.set('start',new Date(a).toISOString());url.searchParams.set('end',new Date(b).toISOString());url.searchParams.set('limit','500');
    const r=await fetch(url,{headers:{Accept:'application/geo+json','User-Agent':'FarberDashboard (farber-growlink-dashboard.vercel.app)'},signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!r.ok)throw new Error('Weather unavailable');const j=await r.json();if(!Array.isArray(j.features))throw new Error('Invalid observations');return j.features;
   }));
   const points=new Map();for(const f of batches.flat()){const p=f.properties,t=Date.parse(p?.timestamp),v=p?.temperature?.value;if(Number.isFinite(t)&&t>=start&&t<=end&&typeof v==='number'&&Number.isFinite(v)&&p.temperature.unitCode==='wmoUnit:degC')points.set(t,{x:p.timestamp,y:Math.round((v*9/5+32)*10)/10})}
   const data=[...points.values()].sort((a,b)=>Date.parse(a.x)-Date.parse(b.x));
   return res.status(200).json({data:{series:[{name:'Bellport-area outside temperature',seriesType:1,unit:'°F',data}],dayNight:[]},start:new Date(start).toISOString(),end:new Date(end).toISOString(),fetchedAt:new Date().toISOString(),station:'KHWV',source:'NWS · Shirley / Brookhaven Airport'});
  }catch{return res.status(502).json({error:'Outside weather observations are temporarily unavailable. Try refreshing.'})}
 }
 const body={sensorIds:cfg.sensors.map(s=>s[0])};
 if(mode==='history'){body.start=new Date(Date.now()-hours*3600000).toISOString();body.end=new Date().toISOString();body.includeDayNight=true}
 try{
  const response=await fetch(`https://api.developer.growlink.com/api/v2/organization/${encodeURIComponent(process.env.GROWLINK_ORG_ID||cfg.orgId)}/sensors/data/${mode==='history'?'chart':'live'}`,{method:'POST',headers:{'Gl-Api-Key':key,'Content-Type':'application/json','Accept':'application/json','Uom-Temp':'1','Uom-Vpd':'8','Uom-Tds':'6','Uom-Light':'16','Uom-Volume':'42'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000),redirect:'error'});
  if(!response.ok)return res.status(502).json({error:`Growlink returned HTTP ${response.status}. Check the API key and organization.`});
  const data=await response.json();
  if(mode==='live'&&!Array.isArray(data.sensorData)||mode==='history'&&!Array.isArray(data.series))return res.status(502).json({error:'Unexpected Growlink response.'});
  return res.status(200).json({data,sensors:cfg.sensors,fetchedAt:new Date().toISOString(),room:'INTERM FLOWERING'});
 }catch{return res.status(502).json({error:'Unable to reach Growlink. Try again shortly.'})}
};

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
  const now=Date.now(),start=now-hours*3600000,forecastEnd=now+120*3600000;
  const get=async url=>{const r=await fetch(url,{headers:{Accept:'application/geo+json','User-Agent':'FarberDashboard (farber-growlink-dashboard.vercel.app)'},signal:AbortSignal.timeout(20000),redirect:'error'});if(!r.ok)throw new Error('Weather unavailable');return r.json()};
  const [observed,forecast]=await Promise.allSettled([
   (async()=>{
    const windows=[];for(let a=start;a<now;a+=86400000)windows.push([a,Math.min(now,a+86400000)]);
    const batches=await Promise.all(windows.map(async([a,b])=>{
     const url=new URL('https://api.weather.gov/stations/KHWV/observations');url.searchParams.set('start',new Date(a).toISOString());url.searchParams.set('end',new Date(b).toISOString());url.searchParams.set('limit','500');
     const j=await get(url);if(!Array.isArray(j.features))throw new Error('Invalid observations');return j.features;
    }));
    const points=new Map();for(const f of batches.flat()){const p=f.properties,t=Date.parse(p?.timestamp),v=p?.temperature?.value;if(Number.isFinite(t)&&t>=start&&t<=now&&typeof v==='number'&&Number.isFinite(v)&&p.temperature.unitCode==='wmoUnit:degC')points.set(t,{x:p.timestamp,y:Math.round((v*9/5+32)*10)/10})}
    return [...points.values()].sort((a,b)=>Date.parse(a.x)-Date.parse(b.x));
   })(),
   (async()=>{
    // NWS grid for Bellport, NY (40.757, -72.939), resolved via /points.
    const j=await get('https://api.weather.gov/gridpoints/OKX/69,50/forecast/hourly');
    if(!Array.isArray(j.properties?.periods))throw new Error('Invalid forecast');
    const points=new Map();
    for(const p of j.properties.periods){const t=Date.parse(p.startTime),end=Date.parse(p.endTime),v=p.temperature;
     if(!Number.isFinite(t)||!Number.isFinite(end)||end<=now||t>forecastEnd||typeof v!=='number'||!Number.isFinite(v)||!['F','C'].includes(p.temperatureUnit))continue;
     points.set(Math.max(t,now),{x:new Date(Math.max(t,now)).toISOString(),y:Math.round((p.temperatureUnit==='C'?v*9/5+32:v)*10)/10});
    }
    return {points:[...points.values()].sort((a,b)=>Date.parse(a.x)-Date.parse(b.x)),updatedAt:j.properties.updateTime||null};
   })()
  ]);
  const observations=observed.status==='fulfilled'?observed.value:[],prediction=forecast.status==='fulfilled'?forecast.value:{points:[],updatedAt:null};
  if(!observations.length&&!prediction.points.length)return res.status(502).json({error:'Outside weather observations and forecast are temporarily unavailable. Try refreshing.'});
  return res.status(200).json({
   data:{series:[{name:'Bellport-area outside temperature',seriesType:1,unit:'°F',data:observations}],dayNight:[]},
   forecast:{data:prediction.points,updatedAt:prediction.updatedAt,source:'NWS · Bellport, NY'},
   warnings:[...(!observations.length?['Observed temperatures unavailable for this range.']:[]),...(!prediction.points.length?['Five-day forecast temporarily unavailable.']:[])],
   start:new Date(start).toISOString(),now:new Date(now).toISOString(),end:new Date(forecastEnd).toISOString(),fetchedAt:new Date().toISOString(),station:'KHWV',source:'NWS · Shirley / Brookhaven Airport'
  });
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

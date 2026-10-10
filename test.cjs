const test=require('node:test'),assert=require('node:assert/strict'),handler=require('./api/data.js'),cfg=require('./config.cjs');
function response(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(j){this.body=j;return this}}}
test('config has 13 unique sensors for three installed probes',()=>{assert.equal(cfg.sensors.length,13);assert.equal(new Set(cfg.sensors.map(s=>s[0])).size,13)});
test('backend requires setup and auth; forwards only configured sensors and keeps key private',async()=>{
 delete process.env.GROWLINK_API_KEY;delete process.env.DASHBOARD_PASSWORD;let res=response();await handler({method:'GET',query:{},headers:{}},res);assert.equal(res.code,503);
 process.env.GROWLINK_API_KEY='test-secret';process.env.DASHBOARD_PASSWORD='test-password';res=response();await handler({method:'GET',query:{},headers:{}},res);assert.equal(res.code,401);
 const original=global.fetch;let called=false;global.fetch=async(url,opt)=>{called=true;assert.equal(opt.headers['Gl-Api-Key'],'test-secret');assert.equal(opt.headers['Uom-Light'],'16');assert.equal(opt.headers['Uom-Temp'],'1');assert.equal(opt.headers['Uom-Vpd'],'8');assert.equal(opt.headers['Uom-Tds'],'6');assert.equal(JSON.parse(opt.body).sensorIds.length,13);assert.match(url,/sensors\/data\/live$/);return {ok:true,json:async()=>({sensorData:[]})}};
 try{res=response();await handler({method:'GET',query:{mode:'live'},headers:{authorization:'Basic '+Buffer.from('farber:test-password').toString('base64')}},res);assert(called);assert.equal(res.code,200);assert(!JSON.stringify(res.body).includes('test-secret'));res=response();await handler({method:'GET',query:{mode:'history',hours:'999'},headers:{authorization:'Basic '+Buffer.from('farber:test-password').toString('base64')}},res);assert.equal(res.code,400)}finally{global.fetch=original;delete process.env.GROWLINK_API_KEY;delete process.env.DASHBOARD_PASSWORD}
});

test('weather combines a five-day Bellport forecast with observations and tolerates either upstream outage',async()=>{
 const originalFetch=global.fetch,originalNow=Date.now,now=Date.parse('2026-10-10T19:30:00Z'),hour=3600000;
 Date.now=()=>now;process.env.GROWLINK_API_KEY='test-secret';process.env.DASHBOARD_PASSWORD='test-password';
 const req={method:'GET',query:{mode:'weather',hours:'24'},headers:{authorization:'Basic '+Buffer.from('farber:test-password').toString('base64')}};
 let failObservations=false,failForecast=false;
 global.fetch=async url=>{
  const forecast=String(url).includes('/forecast/hourly');
  if(forecast?failForecast:failObservations)throw new Error('Offline');
  const periods=Array.from({length:145},(_,i)=>({startTime:new Date(now+(i-1)*hour).toISOString(),endTime:new Date(now+i*hour).toISOString(),temperature:20,temperatureUnit:'C'}));
  periods.push({startTime:new Date(now+hour).toISOString(),endTime:new Date(now+2*hour).toISOString(),temperature:null,temperatureUnit:'F'});
  return {ok:true,json:async()=>forecast?{properties:{periods,updateTime:new Date(now-hour).toISOString()}}:{features:[{properties:{timestamp:new Date(now-hour).toISOString(),temperature:{value:10,unitCode:'wmoUnit:degC'}}}]}};
 };
 try{
  let res=response();await handler(req,res);assert.equal(res.code,200);assert.equal(res.body.data.series[0].data[0].y,50);assert.equal(res.body.forecast.data[0].y,68);
  assert.equal(Date.parse(res.body.end)-Date.parse(res.body.now),120*hour);assert(res.body.forecast.data.every(p=>Date.parse(p.x)>=now&&Date.parse(p.x)<=now+120*hour));assert.equal(res.body.forecast.data.length,121);assert.deepEqual(res.body.warnings,[]);
  failForecast=true;res=response();await handler(req,res);assert.equal(res.code,200);assert.equal(res.body.forecast.data.length,0);assert.equal(res.body.data.series[0].data.length,1);assert.match(res.body.warnings[0],/forecast/);
  failForecast=false;failObservations=true;res=response();await handler(req,res);assert.equal(res.code,200);assert.equal(res.body.data.series[0].data.length,0);assert(res.body.forecast.data.length);assert.match(res.body.warnings[0],/Observed/);
  failForecast=true;res=response();await handler(req,res);assert.equal(res.code,502);
 }finally{global.fetch=originalFetch;Date.now=originalNow;delete process.env.GROWLINK_API_KEY;delete process.env.DASHBOARD_PASSWORD}
});

const {client,authorized}=require('../lib/ring.cjs');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 const action=req.query.action||'devices',publicAction=['token','webhook'].includes(action);
 if(!['token','webhook','link','devices','stream','stop'].includes(action))return res.status(400).json({error:'Unknown Ring request.'});
 if(req.method!==(action==='devices'?'GET':'POST'))return res.status(405).json({error:'Method not allowed.'});
 if(!publicAction&&!authorized(req.headers.authorization,process.env.DASHBOARD_PASSWORD))return res.status(401).json({error:'Enter your dashboard password.'});
 try{
  const ring=client();let raw=Buffer.alloc(0);if(req.method==='POST'){for await(const chunk of req){raw=Buffer.concat([raw,Buffer.from(chunk)]);if(raw.length>70000)return res.status(413).json({error:'Request too large.'})}}
  if(action==='webhook')return res.status(200).json(await ring.webhook(raw,req.headers['x-signature']));
  let body={};if(raw.length){try{body=(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded')?Object.fromEntries(new URLSearchParams(raw.toString())):JSON.parse(raw.toString())}catch{return res.status(400).json({error:'Invalid request.'})}}
  const result=action==='token'?await ring.receiveCode(body.code||body.authorization_code):action==='link'?await ring.link(body.nonce,body.time):action==='stream'?await ring.stream(body.device,body.sdp):action==='stop'?await ring.stop(body.device,body.session):await ring.devices();
  return res.status(200).json(result);
 }catch(e){return res.status(e.status||502).json({error:e.status?e.message:'Ring is temporarily unavailable. Try again shortly.'})}
};
module.exports.config={api:{bodyParser:false}};

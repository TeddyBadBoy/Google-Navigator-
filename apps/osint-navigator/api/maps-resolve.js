const ALLOWED=new Set(['maps.app.goo.gl','www.google.com','google.com','maps.google.com']);
function parseStreetView(url){
  const out={camera:null,heading:null,fov:null,pitch:null};
  const m=url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(?:\d+(?:\.\d+)?a,)?(\d+(?:\.\d+)?)y,(-?\d+(?:\.\d+)?)h,(-?\d+(?:\.\d+)?)t/i);
  if(m){out.camera={lat:Number(m[1]),lon:Number(m[2])};out.fov=Number(m[3]);out.heading=Number(m[4]);out.pitch=Number(m[5]);return out;}
  const c=url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if(c)out.camera={lat:Number(c[1]),lon:Number(c[2])};
  const h=url.match(/(?:,|%2C)(-?\d+(?:\.\d+)?)h/i);if(h)out.heading=Number(h[1]);
  const y=url.match(/(?:,|%2C)(\d+(?:\.\d+)?)y/i);if(y)out.fov=Number(y[1]);
  const d3=url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);if(!out.camera&&d3)out.camera={lat:Number(d3[1]),lon:Number(d3[2])};
  return out;
}
async function resolve(input){let current=new URL(input);for(let i=0;i<6;i++){if(!ALLOWED.has(current.hostname))throw new Error(`Host not allowed: ${current.hostname}`);const r=await fetch(current,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 OSINT-Navigator/0.5','accept':'text/html,*/*'},signal:AbortSignal.timeout(7000)});if(r.status>=300&&r.status<400&&r.headers.get('location')){current=new URL(r.headers.get('location'),current);continue;}return{final_url:current.toString(),http_status:r.status,...parseStreetView(current.toString())};}throw new Error('Too many redirects');}
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed'});}const input=req.method==='GET'?req.query:(req.body||{});const url=String(input.url||'').trim();if(!url||url.length>2048)return res.status(400).json({error:'Google Maps URL required'});try{const u=new URL(url);if(!ALLOWED.has(u.hostname))return res.status(400).json({error:'Only Google Maps links are allowed'});const x=await resolve(url);return res.status(200).json({status:'MAPS_RESOLVED',input:url,...x,usable_for_view_order:Boolean(x.camera&&Number.isFinite(x.heading))});}catch(e){return res.status(502).json({status:'MAPS_RESOLVE_FAILED',error:e.message});}}

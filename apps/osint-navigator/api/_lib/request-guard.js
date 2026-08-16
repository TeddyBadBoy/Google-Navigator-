import crypto from 'node:crypto';

const SITE_ORIGIN='https://osint-navigator.wojciechwoytynowski.chatgpt.site';
const DEFAULT_LIMIT=12;
const DEFAULT_WINDOW_MS=60_000;
const buckets=globalThis.__osintApiRateBuckets||(globalThis.__osintApiRateBuckets=new Map());

function splitHeader(value){return String(value||'').split(',')[0].trim();}
function configuredOrigins(){return String(process.env.EXTRA_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);}
function requestHost(req){return splitHeader(req.headers?.['x-forwarded-host']||req.headers?.host).toLowerCase();}
function isSameOrigin(origin,req){if(!origin)return false;try{return new URL(origin).host.toLowerCase()===requestHost(req)&&Boolean(requestHost(req));}catch{return false;}}
export function isAllowedOrigin(origin,req={headers:{}}){
  if(!origin)return false;
  if(isSameOrigin(origin,req))return true;
  if(origin===SITE_ORIGIN)return true;
  if(/^https:\/\/([a-z0-9-]+\.)*chatgpt\.site$/i.test(origin))return true;
  if(/^https:\/\/(chatgpt\.com|chat\.openai\.com)$/i.test(origin))return true;
  return configuredOrigins().includes(origin);
}
function validBearer(req){
  const expected=String(process.env.OSINT_API_TOKEN||'').trim();
  if(!expected)return false;
  const auth=String(req.headers?.authorization||'');
  const supplied=auth.replace(/^Bearer\s+/i,'');
  if(!supplied||supplied===auth)return false;
  const a=Buffer.from(expected),b=Buffer.from(supplied);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function clientIp(req){return splitHeader(req.headers?.['x-forwarded-for']||req.headers?.['x-real-ip']||req.ip||req.socket?.remoteAddress)||'unknown';}
function writeJson(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));}
function applyCors(req,res,allowedOrigin){
  const origin=String(req.headers?.origin||'');
  if(allowedOrigin)res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age','600');
}
function positiveInt(value,fallback){const n=Number.parseInt(String(value??''),10);return Number.isFinite(n)&&n>0?n:fallback;}
function rateAllowed(req,res,{limit,windowMs}){
  const now=Date.now();
  const route=String(req.url||req.originalUrl||'api').split('?')[0];
  const key=`${route}|${clientIp(req)}`;
  const current=buckets.get(key);
  const bucket=!current||current.resetAt<=now?{count:0,resetAt:now+windowMs}:current;
  bucket.count+=1;buckets.set(key,bucket);
  if(buckets.size>5000){for(const [k,v] of buckets){if(v.resetAt<=now)buckets.delete(k);}}
  const remaining=Math.max(0,limit-bucket.count);
  res.setHeader('RateLimit-Limit',String(limit));
  res.setHeader('RateLimit-Remaining',String(remaining));
  res.setHeader('RateLimit-Reset',String(Math.ceil(bucket.resetAt/1000)));
  if(bucket.count<=limit)return true;
  res.setHeader('Retry-After',String(Math.max(1,Math.ceil((bucket.resetAt-now)/1000))));
  writeJson(res,429,{error:'Too many requests'});
  return false;
}
export function guardApiRequest(req,res,options={}){
  if(req.apiGuardPassed)return true;
  const origin=String(req.headers?.origin||'');
  const allowedOrigin=isAllowedOrigin(origin,req);
  const tokenOk=validBearer(req);
  applyCors(req,res,allowedOrigin);
  if(req.method==='OPTIONS'){
    if(!allowedOrigin){writeJson(res,403,{error:'Origin not allowed'});return false;}
    res.statusCode=204;res.setHeader('Cache-Control','no-store');res.end();return false;
  }
  if(!allowedOrigin&&!tokenOk){writeJson(res,403,{error:'Origin or bearer token required'});return false;}
  const limit=positiveInt(options.limit??process.env.OSINT_RATE_LIMIT_PER_MINUTE,DEFAULT_LIMIT);
  const windowMs=positiveInt(options.windowMs,DEFAULT_WINDOW_MS);
  if(!rateAllowed(req,res,{limit,windowMs}))return false;
  req.apiGuardPassed=true;
  return true;
}

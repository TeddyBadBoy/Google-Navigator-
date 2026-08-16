import assert from 'node:assert/strict';
import {guardApiRequest} from '../api/_lib/request-guard.js';

function res(){return {statusCode:200,headers:{},body:'',ended:false,setHeader(k,v){this.headers[k]=String(v)},end(v=''){this.body=String(v);this.ended=true}};}
function req({origin='',authorization='',ip='203.0.113.10',url='/api/run',method='POST',host='engine.example'}={}){return {method,url,headers:{origin,authorization,host,'x-forwarded-for':ip}};}

{
  const r=res();assert.equal(guardApiRequest(req({origin:'https://evil.example',ip:'203.0.113.11'}),r),false);assert.equal(r.statusCode,403);
}
{
  const r=res();assert.equal(guardApiRequest(req({ip:'203.0.113.12'}),r),false);assert.equal(r.statusCode,403);
}
{
  process.env.OSINT_API_TOKEN='test-secret';
  const r=res();assert.equal(guardApiRequest(req({authorization:'Bearer test-secret',ip:'203.0.113.13'}),r),true);assert.equal(r.statusCode,200);
}
{
  const r=res();assert.equal(guardApiRequest(req({origin:'https://engine.example',ip:'203.0.113.14'}),r),true);
}
{
  const base={origin:'https://osint-navigator.wojciechwoytynowski.chatgpt.site',ip:'203.0.113.15',url:'/api/vision'};
  assert.equal(guardApiRequest(req(base),res(),{limit:2}),true);
  assert.equal(guardApiRequest(req(base),res(),{limit:2}),true);
  const r=res();assert.equal(guardApiRequest(req(base),r,{limit:2}),false);assert.equal(r.statusCode,429);
}
{
  const r=res();assert.equal(guardApiRequest(req({origin:'https://osint-navigator.wojciechwoytynowski.chatgpt.site',method:'OPTIONS',ip:'203.0.113.16'}),r),false);assert.equal(r.statusCode,204);
}
console.log('request-guard tests: OK');

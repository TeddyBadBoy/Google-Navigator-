import crypto from 'node:crypto';
import * as exifr from 'exifr';
import {safeFetchImage} from './_lib/safe-image-fetch.js';
import {extractCoordinatesFromImage} from './_lib/openai-vision.js';
import {extractCoordinatesWithOcr} from './_lib/ocr.js';
import {guardApiRequest} from './_lib/request-guard.js';

export const config={maxDuration:60};
const MAX_INLINE=3*1024*1024;

function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');res.setHeader('Pragma','no-cache');res.end(JSON.stringify(body));}
function parseDataUrl(input){
  const m=String(input||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if(!m) throw new Error('Unsupported inline image. Use JPEG, PNG or WEBP data URL.');
  const buffer=Buffer.from(m[2].replace(/\s/g,''),'base64');
  if(!buffer.length||buffer.length>MAX_INLINE) throw new Error('Inline image must be between 1 byte and 3 MB.');
  return {buffer,contentType:m[1].toLowerCase(),finalUrl:null,resolvedIp:null};
}
async function loadInput(body){
  const url=typeof body?.url==='string'?body.url.trim():'';
  const imageData=typeof body?.image_data==='string'?body.image_data.trim():'';
  if(Boolean(url)===Boolean(imageData)) throw new Error('Provide exactly one input: url or image_data.');
  if(url){if(url.length>2048) throw new Error('URL too long.');return {kind:'url',source:url,...await safeFetchImage(url)};}
  return {kind:'image_data',source:'inline-upload',...parseDataUrl(imageData)};
}
async function analyzeImage(fetched){
  const sha256=crypto.createHash('sha256').update(fetched.buffer).digest('hex');
  let exifGps=null;
  try{const gps=await exifr.gps(fetched.buffer);if(gps&&Number.isFinite(gps.latitude)&&Number.isFinite(gps.longitude))exifGps={lat:gps.latitude,lon:gps.longitude};}catch{}
  let vision={available:false,coordinates:[],raw_text:''};
  try{vision=await extractCoordinatesFromImage(fetched.buffer,fetched.contentType);}catch(e){vision={available:true,error:e.message,coordinates:[],raw_text:''};}
  let ocr={available:false,coordinates:[],text:''};
  if(!(vision.coordinates||[]).length){try{ocr=await extractCoordinatesWithOcr(fetched.buffer);}catch(e){ocr={available:true,error:e.message,coordinates:[],text:''};}}
  const candidates=[];
  if(exifGps)candidates.push({...exifGps,source:'EXIF_GPS',confidence:1,verified:false});
  for(const c of vision.coordinates||[])candidates.push({lat:c.lat,lon:c.lon,source:'IMAGE_TEXT_AI',confidence:c.confidence,verbatim:c.verbatim,verified:false});
  for(const c of ocr.coordinates||[])candidates.push({lat:c.lat,lon:c.lon,source:'IMAGE_TEXT_OCR',confidence:c.confidence,verbatim:c.verbatim,verified:false});
  return {sha256,exifGps,vision,ocr,candidates};
}
export default async function handler(req,res){
  if(!guardApiRequest(req,res))return;
  if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
  const run_id=crypto.randomUUID();
  const started_at=new Date().toISOString();
  try{
    const fetched=await loadInput(req.body||{});
    const a=await analyzeImage(fetched);
    const warnings=[];
    if(a.vision.available===false&&a.vision.reason)warnings.push({extractor:'IMAGE_TEXT_AI',degraded:true,reason:a.vision.reason});
    if(a.vision.error)warnings.push({extractor:'IMAGE_TEXT_AI',degraded:true,reason:a.vision.error});
    if(a.ocr.error)warnings.push({extractor:'IMAGE_TEXT_OCR',degraded:true,reason:a.ocr.error});
    return send(res,200,{
      run_id,started_at,reset:true,
      status:a.candidates.length?'CANDIDATE_FOUND':(warnings.length?'NO_COORDINATES_FOUND_DEGRADED':'NO_COORDINATES_FOUND'),
      state:{current_only:true,previous_run_discarded:true},
      input:{kind:fetched.kind,source:fetched.source},
      image:{final_url:fetched.finalUrl,content_type:fetched.contentType,bytes:fetched.buffer.length,sha256:a.sha256},
      exif:{gps:a.exifGps},vision:a.vision,ocr:a.ocr,candidates:a.candidates,
      extractors:{exif_gps:Boolean(a.exifGps),vision:a.vision.available===true&&!a.vision.error,ocr:a.ocr.available===true&&!a.ocr.error},
      warnings,
      next:{tree_match:a.candidates.length>0,streetview_match:true}
    });
  }catch(e){return send(res,400,{run_id,started_at,reset:true,status:'RUN_FAILED',error:e.message,state:{current_only:true,previous_run_discarded:true}});}
}

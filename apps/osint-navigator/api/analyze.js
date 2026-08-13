import crypto from 'node:crypto';
import * as exifr from 'exifr';
import {safeFetchImage} from './_lib/safe-image-fetch.js';
import {extractCoordinatesFromImage} from './_lib/openai-vision.js';
import {extractCoordinatesWithOcr} from './_lib/ocr.js';
export const config={api:{bodyParser:{sizeLimit:'32kb'}},maxDuration:60};
function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));}
export default async function handler(req,res){
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(res,405,{error:'Method not allowed'});}
  const url=typeof req.body?.url==='string'?req.body.url.trim():'';
  if(!url||url.length>2048)return send(res,400,{error:'Valid image URL required'});
  try{
    const fetched=await safeFetchImage(url);
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
    return send(res,200,{status:candidates.length?'CANDIDATE_FOUND':'NO_COORDINATES_FOUND',input:{type:'url',url},image:{final_url:fetched.finalUrl,content_type:fetched.contentType,bytes:fetched.buffer.length,sha256},exif:{gps:exifGps},vision,ocr,candidates});
  }catch(e){return send(res,400,{status:'ANALYZE_FAILED',error:e.message});}
}

import crypto from 'node:crypto';
import {safeFetchImage} from './_lib/safe-image-fetch.js';
import {guardApiRequest} from './_lib/request-guard.js';

export const config={maxDuration:60};
const MODEL=process.env.GEMINI_VISION_MODEL||'gemini-3.6-flash';
const MAX_INLINE=3*1024*1024;

function send(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  res.end(JSON.stringify(body));
}
function parseDataUrl(input){
  const m=String(input||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if(!m) throw new Error('Unsupported inline image. Use JPEG, PNG or WEBP.');
  const buffer=Buffer.from(m[2].replace(/\s/g,''),'base64');
  if(!buffer.length||buffer.length>MAX_INLINE) throw new Error('Inline image must be between 1 byte and 3 MB.');
  return {buffer,contentType:m[1].toLowerCase()};
}
async function loadImage(input){
  const value=String(input||'').trim();
  if(value.startsWith('data:')) return parseDataUrl(value);
  if(/^https?:\/\//i.test(value)){
    const fetched=await safeFetchImage(value);
    return {buffer:fetched.buffer,contentType:fetched.contentType};
  }
  throw new Error('Image must be a data URL or http/https URL.');
}
function outputText(payload){
  if(typeof payload?.output_text==='string') return payload.output_text;
  if(typeof payload?.outputText==='string') return payload.outputText;
  return (payload?.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
}
const responseSchema={
  type:'object',
  properties:{
    verdict:{type:'string',enum:['MATCH_HIGH','MATCH_POSSIBLE','NO_MATCH','INSUFFICIENT']},
    samePlace:{type:'boolean'},
    confidence:{type:'integer',minimum:0,maximum:100},
    targetVisible:{type:'boolean'},
    target:{
      type:'object',
      properties:{
        x:{type:['number','null'],minimum:0,maximum:1},
        y:{type:['number','null'],minimum:0,maximum:1},
        label:{type:'string'}
      },
      required:['x','y','label']
    },
    scores:{
      type:'object',
      properties:{
        architecture:{type:'integer',minimum:0,maximum:100},
        entrancePath:{type:'integer',minimum:0,maximum:100},
        vegetation:{type:'integer',minimum:0,maximum:100},
        fixedObjects:{type:'integer',minimum:0,maximum:100},
        viewpoint:{type:'integer',minimum:0,maximum:100}
      },
      required:['architecture','entrancePath','vegetation','fixedObjects','viewpoint']
    },
    stableLandmarks:{type:'array',items:{type:'string'}},
    conflicts:{type:'array',items:{type:'string'}},
    hint:{type:'string'},
    needsEscalation:{type:'boolean'}
  },
  required:['verdict','samePlace','confidence','targetVisible','target','scores','stableLandmarks','conflicts','hint','needsEscalation']
};

export default async function handler(req,res){
  if(!guardApiRequest(req,res))return;
  if(req.method!=='POST'){res.setHeader('Allow','POST');return send(res,405,{error:'Method not allowed'});}
  if(!process.env.GEMINI_API_KEY)return send(res,503,{error:'GEMINI_API_KEY missing. Import this branch into Google AI Studio Build or configure the secret server-side.'});
  const {reference_image,current_image,target,last_position}=req.body||{};
  if(!reference_image||!current_image)return send(res,400,{error:'reference_image and current_image are required'});
  const run_id=crypto.randomUUID();
  try{
    const [reference,current]=await Promise.all([loadImage(reference_image),loadImage(current_image)]);
    const prompt=`Jesteś modułem wizualnej nawigacji terenowej „ostatnie 5 metrów”.\n\nOBRAZ 1 to zdjęcie referencyjne miejsca.\nOBRAZ 2 to zdjęcie wykonane TERAZ przez użytkownika.\n\nUstal, czy oba obrazy pokazują ten sam fizyczny punkt lub bezpośrednie otoczenie w skali około 5 metrów. Nie identyfikuj ludzi i ignoruj twarze, pojazdy, pogodę, porę dnia, światło i cienie. Największą wagę mają trwałe elementy: architektura, wejścia, krawędzie budynków, chodniki i ścieżki, latarnie, ogrodzenia, układ pni i korzeni, stała mała architektura.\n\nJeżeli sceny są zgodne, wskaż na OBRAZIE 2 najbardziej użyteczny trwały punkt/anchor odpowiadający zdjęciu referencyjnemu. target.x i target.y są współrzędnymi znormalizowanymi 0..1 na OBRAZIE 2 (0,0 lewy-górny; 1,1 prawy-dolny). Jeśli nie da się wiarygodnie wskazać punktu, ustaw targetVisible=false i x/y=null.\n\nNie licz metrów, GPS ani bearing. Kod aplikacji robi to osobno. target GPS=${JSON.stringify(target||null)}, ostatnia pozycja GPS=${JSON.stringify(last_position||null)} są tylko kontekstem diagnostycznym i NIE wolno na ich podstawie podnosić confidence wizualnego.\n\nZasady confidence: 85+ tylko gdy kilka niezależnych trwałych elementów zgadza się geometrycznie; 60-84 możliwe miejsce, ale wymaga kolejnego zdjęcia; poniżej 60 nie zgaduj. hint po polsku, maksymalnie 12 słów, konkretna instrukcja gdzie spojrzeć lub jak zmienić kadr.`;
    const apiResponse=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
      method:'POST',
      headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'content-type':'application/json'},
      body:JSON.stringify({
        model:MODEL,
        input:[
          {type:'text',text:prompt},
          {type:'image',mime_type:reference.contentType,data:reference.buffer.toString('base64')},
          {type:'image',mime_type:current.contentType,data:current.buffer.toString('base64')}
        ],
        response_format:{type:'text',mime_type:'application/json',schema:responseSchema}
      })
    });
    const raw=await apiResponse.json();
    if(!apiResponse.ok)return send(res,502,{run_id,error:`Gemini failed: HTTP ${apiResponse.status}`,details:raw?.error?.message||null});
    const text=outputText(raw);
    if(!text)return send(res,502,{run_id,error:'Gemini returned no structured text'});
    const result=JSON.parse(text);
    return send(res,200,{run_id,model:MODEL,verified:Boolean(result.samePlace&&result.confidence>=85),...result});
  }catch(e){return send(res,500,{run_id,error:e.message});}
}

function outputText(payload){
  if(typeof payload.output_text==='string') return payload.output_text;
  return (payload.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('');
}
function parseJson(text){return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
export async function extractCoordinatesFromImage(buffer,contentType){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return {available:false,reason:'OPENAI_API_KEY missing',coordinates:[],raw_text:''};
  const r=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:process.env.OPENAI_VISION_MODEL||'gpt-5-mini',input:[{role:'user',content:[
      {type:'input_text',text:'Extract only geographic coordinates visibly written or printed in this image. Do not infer location from scenery. Return JSON only: {"coordinates":[{"lat":number,"lon":number,"verbatim":"text seen","confidence":0..1}],"raw_text":"short relevant text"}. If none are visible, return an empty coordinates array.'},
      {type:'input_image',image_url:`data:${contentType};base64,${buffer.toString('base64')}`,detail:'high'}
    ]}],max_output_tokens:300})
  });
  if(!r.ok) throw new Error(`OpenAI vision failed: HTTP ${r.status}`);
  const parsed=parseJson(outputText(await r.json()));
  const coordinates=Array.isArray(parsed.coordinates)?parsed.coordinates.map(c=>({lat:Number(c.lat),lon:Number(c.lon),verbatim:String(c.verbatim||''),confidence:Math.max(0,Math.min(1,Number(c.confidence??0.5)))})).filter(c=>Number.isFinite(c.lat)&&Number.isFinite(c.lon)&&c.lat>=-90&&c.lat<=90&&c.lon>=-180&&c.lon<=180):[];
  return {available:true,coordinates,raw_text:String(parsed.raw_text||'')};
}

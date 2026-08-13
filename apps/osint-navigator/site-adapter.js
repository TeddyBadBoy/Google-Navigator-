(()=>{
  const API='/api/run';
  // Vercel rejects request bodies over 4.5 MB at the edge (413, no CORS headers, function never
  // invoked). base64 costs 4/3, so cap the BINARY we inline: 3 MB -> ~4.19 MB of JSON.
  const MAX_INLINE_BYTES=3*1024*1024;
  const MAX_SOURCE_BYTES=12*1024*1024;
  const MAX_EDGE=1600;

  let generation=0;
  let inputKey='';
  let controller=null;
  // Identity token of the single run allowed to write state. Anything that supersedes a run
  // replaces this; a superseded run can then never emit a result, whatever order it finishes in.
  let activeRun=null;

  function emit(name,detail){window.dispatchEvent(new CustomEvent(name,{detail}));}
  function keyFor({url,file}={}){
    const clean=typeof url==='string'?url.trim():'';
    if(clean) return `url:${clean}`;
    if(file) return `file:${file.name||'upload'}:${file.size||0}:${file.lastModified||0}`;
    return '';
  }
  function clearVisibleState(reason='new-input'){
    sessionStorage.removeItem('osint.currentRun');
    sessionStorage.removeItem('osint.currentInput');
    emit('osint:reset',{generation,reason});
  }
  function abortPrevious(reason='superseded'){
    if(controller){try{controller.abort(reason);}catch{}}
    controller=null;
  }
  // Advisory: called from an input's onChange. It must be a no-op when the key is unchanged,
  // otherwise a re-render during an in-flight run would abort the run that just started.
  function inputChanged(input={}){
    const next=keyFor(input);
    if(!next||next===inputKey) return {changed:false,generation};
    generation+=1;
    inputKey=next;
    activeRun=null;
    abortPrevious('input-changed');
    clearVisibleState('input-changed');
    return {changed:true,generation};
  }

  function blobToDataUrl(blob){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('Nie udało się odczytać pliku.'));r.readAsDataURL(blob);});}
  async function downscale(file){
    let bitmap;
    // imageOrientation must be explicit: without it older Chrome/Android ignores the EXIF
    // orientation flag and a portrait phone photo reaches the OCR rotated 90 degrees.
    try{bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});}
    catch{
      try{bitmap=await createImageBitmap(file);}
      catch{throw new Error('Przeglądarka nie potrafi zdekodować tego zdjęcia.');}
    }
    const scale=Math.min(1,MAX_EDGE/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx){bitmap.close?.();throw new Error('Brak kontekstu canvas 2D.');}
    ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height); // flatten PNG alpha
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    bitmap.close?.();
    for(const quality of [0.82,0.68,0.5]){
      const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));
      if(blob&&blob.size<=MAX_INLINE_BYTES) return blob;
    }
    throw new Error('Nie udało się zmniejszyć zdjęcia poniżej limitu API.');
  }
  async function fileToDataUrl(file){
    const type=String(file?.type||'').toLowerCase();
    if(!/^image\/(jpeg|png|webp)$/.test(type)){
      throw new Error(/hei[cf]/.test(type)
        ? 'HEIC/HEIF nie jest obsługiwany. Ustaw w aparacie format JPEG.'
        : 'Obsługiwane formaty: JPG, PNG, WEBP.');
    }
    if(file.size>MAX_SOURCE_BYTES) throw new Error('Zdjęcie przekracza 12 MB.');
    // Under budget: send the original bytes so EXIF (including GPS) survives. Re-encoding
    // through canvas strips EXIF and destroys the highest-confidence coordinate source.
    if(file.size<=MAX_INLINE_BYTES) return blobToDataUrl(file);
    return blobToDataUrl(await downscale(file));
  }

  async function analyze({url,file}={}){
    const cleanUrl=typeof url==='string'?url.trim():'';
    const nextKey=keyFor({url:cleanUrl,file});

    // Every submit is a new run: bump the generation, take a fresh token, drop the visible
    // result. Re-running the same input is still a new run, so it still clears the screen.
    generation+=1;
    const runGeneration=generation;
    const token={};
    activeRun=token;
    inputKey=nextKey;
    abortPrevious('superseded');
    clearVisibleState('new-run');
    const isCurrent=()=>activeRun===token;

    const fail=message=>{
      if(isCurrent()) emit('osint:error',{message,generation:runGeneration});
      const error=new Error(message);
      error.runGeneration=runGeneration;
      throw error;
    };

    if(Boolean(cleanUrl)===Boolean(file)) fail('Podaj dokładnie jeden nowy link albo jedno nowe zdjęcie.');

    let body;
    try{
      body=cleanUrl?{url:cleanUrl}:{image_data:await fileToDataUrl(file)};
    }catch(e){
      if(!isCurrent()) return {ignored:true,reason:'superseded-during-encode'};
      fail(e?.message||String(e));
    }
    // Image encoding can take seconds; if a newer input landed meanwhile, stop here.
    if(!isCurrent()) return {ignored:true,reason:'superseded-before-send'};

    sessionStorage.setItem('osint.currentInput',JSON.stringify({kind:cleanUrl?'url':'file',value:cleanUrl||file?.name||'upload'}));
    emit('osint:loading',{generation:runGeneration,input:cleanUrl||file?.name||'upload'});

    // The controller is created AFTER the slow encode. Creating it earlier left a window in
    // which the run could abort the request it was about to make, so no POST ever left the page.
    const localController=new AbortController();
    controller=localController;

    let response,raw;
    try{
      response=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:localController.signal,cache:'no-store',mode:'cors',credentials:'omit'});
      raw=await response.text();
    }catch(e){
      if(localController.signal.aborted||e?.name==='AbortError') return {ignored:true,reason:'aborted-superseded'};
      if(!isCurrent()) return {ignored:true,reason:'superseded-during-fetch'};
      fail(`Brak połączenia z silnikiem analizy (${e?.message||e}). Sprawdź CORS lub rozmiar żądania.`);
    }finally{
      if(controller===localController) controller=null;
    }

    if(!isCurrent()) return {ignored:true,reason:'stale-response'};

    let payload=null;
    try{payload=JSON.parse(raw);}catch{}
    if(!payload){
      // 413 comes from the Vercel edge as text/plain with no CORS headers: the function is
      // never invoked, so this failure is invisible in the runtime log.
      fail(response.status===413
        ? 'Zdjęcie jest za duże dla API (limit żądania 4.5 MB). Wyślij mniejsze zdjęcie.'
        : `Silnik zwrócił odpowiedź spoza JSON (HTTP ${response.status}).`);
    }
    if(!response.ok) fail(payload.error||`Analiza nie powiodła się (HTTP ${response.status}).`);

    sessionStorage.setItem('osint.currentRun',JSON.stringify(payload));
    emit('osint:result',payload);
    return payload;
  }

  function current(){try{return JSON.parse(sessionStorage.getItem('osint.currentRun')||'null');}catch{return null;}}
  function cancel(){generation+=1;inputKey='';activeRun=null;abortPrevious('manual-cancel');clearVisibleState('manual-cancel');}

  window.OSINTNavigatorFreshRun={analyze,current,cancel,inputChanged,api:API};
})();

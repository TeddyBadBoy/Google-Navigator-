import { createWorker } from 'tesseract.js';

const DEC = String.raw`-?\d{1,3}[.,]\d{3,}`;

function toNumber(raw) { return Number(String(raw).replace(',', '.')); }
function push(matches, lat, lon, verbatim, confidence) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
  matches.push({ lat, lon, verbatim: String(verbatim).trim(), confidence });
}
function dmsToDecimal(deg, min, sec, hemi) {
  const value = Math.abs(Number(deg)) + Number(min || 0) / 60 + Number(sec || 0) / 3600;
  return /[SWsw]/.test(hemi || '') ? -value : value;
}

function findDecimalCoordinates(text) {
  const normalized = String(text || '')
    .replace(/[|]/g, '1')
    .replace(/[Oo](?=\d)/g, '0')
    .replace(/(?<=\d)[Oo]/g, '0')
    .replace(/[°˚⁰]/g, '°');
  const matches = [];

  // Bare decimal pair, e.g. "52.23898, 20.92140" or "52,1914531 21,0060642".
  const bare = new RegExp(String.raw`(${DEC})\s*[,;\s]\s*(${DEC})`, 'g');
  for (let m; (m = bare.exec(normalized));) {
    const decimals = Math.min((m[1].split(/[.,]/)[1] || '').length, (m[2].split(/[.,]/)[1] || '').length);
    push(matches, toNumber(m[1]), toNumber(m[2]), m[0], decimals >= 5 ? 0.75 : 0.55);
  }

  // Labelled pair, e.g. "lat: 52.23898 ... lon: 20.92140".
  const labelled = new RegExp(String.raw`(?:lat(?:itude)?\s*[:=]?\s*)(${DEC}).{0,40}?(?:lon(?:gitude)?|lng)\s*[:=]?\s*(${DEC})`, 'gis');
  for (let m; (m = labelled.exec(normalized));) push(matches, toNumber(m[1]), toNumber(m[2]), m[0], 0.8);

  // Degrees/minutes/seconds, e.g. 52°14'20.3"N 20°55'17.0"E — common on camera overlays.
  const dms = /(\d{1,3})\s*°\s*(\d{1,2})\s*['’]\s*([\d.,]+)?\s*["”]?\s*([NSns])\D{0,6}(\d{1,3})\s*°\s*(\d{1,2})\s*['’]\s*([\d.,]+)?\s*["”]?\s*([EWew])/g;
  for (let m; (m = dms.exec(normalized));) {
    push(matches,
      dmsToDecimal(m[1], m[2], toNumber(m[3] || 0), m[4]),
      dmsToDecimal(m[5], m[6], toNumber(m[7] || 0), m[8]),
      m[0], 0.7);
  }

  const seen = new Set();
  return matches
    .sort((a, b) => b.confidence - a.confidence)
    .filter(c => { const k = `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function extractCoordinatesWithOcr(buffer) {
  const worker = await createWorker('eng');
  try {
    // NOTE: no tessedit_char_whitelist. With the default LSTM engine a whitelist does not
    // constrain the decoder, it degrades it — it turned "52.23898, 20.92140" into "52 2NNE 0"
    // on the tree-regression-002 case, so the coordinate pair was never seen by the regex.
    await worker.setParameters({ preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(buffer);
    const text = String(data?.text || '');
    return { available: true, text, confidence: Number(data?.confidence || 0) / 100, coordinates: findDecimalCoordinates(text) };
  } finally {
    await worker.terminate();
  }
}

export { findDecimalCoordinates };

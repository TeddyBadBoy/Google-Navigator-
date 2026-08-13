import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 10_000;
const TOTAL_DEADLINE_MS = 25_000;

function ipv4ToInt(ip) { return ip.split('.').reduce((n, oct) => (n << 8) + Number(oct), 0) >>> 0; }
function inV4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
function isPublicV4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const blocked = [
    ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
    ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],
    ['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],
    ['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
  ];
  return !blocked.some(([base,bits]) => inV4(ip,base,bits));
}

// Full expansion is the only reliable way to classify IPv6. Prefix-string matching
// silently lets ::ffff:127.0.0.1, ::ffff:169.254.169.254, 64:ff9b:: and 2002:: through.
function expandIpv6(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  const dotted = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    if (o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = s.slice(0, -dotted[1].length) + ((o[0] << 8 | o[1]).toString(16)) + ':' + ((o[2] << 8 | o[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':').filter(Boolean) : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const words = parts.map(p => /^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN);
  return words.some(w => !Number.isInteger(w)) ? null : words;
}
function v4From(hi, lo) { return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'); }

export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPublicV4(ip);
  if (family !== 6) return false;
  const w = expandIpv6(ip);
  if (!w) return false;
  const [a,b,c,d,e,f,g,h] = w;
  // ::/96 (unspecified, ::1, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
  if (a===0 && b===0 && c===0 && d===0 && e===0 && (f===0 || f===0xffff)) return isPublicV4(v4From(g,h));
  if ((a & 0xfe00) === 0xfc00) return false;              // fc00::/7   unique local
  if ((a & 0xffc0) === 0xfe80) return false;              // fe80::/10  link local
  if ((a & 0xff00) === 0xff00) return false;              // ff00::/8   multicast
  if (a === 0x2002) return isPublicV4(v4From(b,c));       // 2002::/16  6to4, carries an IPv4
  if (a === 0x0064 && b === 0xff9b) return false;         // 64:ff9b::/96 NAT64
  if (a === 0x0100 && b===0 && c===0 && d===0) return false; // 100::/64 discard-only
  if (a === 0x2001 && b <= 0x01ff) return false;          // 2001::/23 protocol assignments (Teredo, ORCHID)
  if (a === 0x2001 && b === 0x0db8) return false;         // 2001:db8::/32 documentation
  return true;
}

async function resolvePublic(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Host resolves to a non-public IP');
    return {address:hostname,family:net.isIP(hostname)};
  }
  const records = await dns.lookup(hostname,{all:true,verbatim:true});
  if (!records.length) throw new Error('DNS returned no addresses');
  // Every answer must be public, then we pin one address for the actual socket so a
  // second DNS answer (rebinding) cannot be substituted between check and connect.
  if (records.some(r => !isPublicIp(r.address))) throw new Error('Host resolves to a non-public IP');
  return records[0];
}
function sniffType(buf) {
  if (buf.length >= 3 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP') return 'image/webp';
  if (buf.length >= 6 && ['GIF87a','GIF89a'].includes(buf.toString('ascii',0,6))) return 'image/gif';
  return null;
}
function typesAgree(headerType, actualType) {
  if (!headerType) return true;
  const alias = {'image/jpg':'image/jpeg','image/pjpeg':'image/jpeg','image/x-png':'image/png'};
  return (alias[headerType] || headerType) === actualType;
}
function requestOnce(url,resolved) {
  return new Promise((resolve,reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol:url.protocol, hostname:url.hostname, port:url.port||undefined,
      path:`${url.pathname}${url.search}`, method:'GET', timeout:TIMEOUT_MS,
      lookup:(_host,opts,cb)=>{ if(opts?.all) cb(null,[{address:resolved.address,family:resolved.family}]); else cb(null,resolved.address,resolved.family); },
      headers:{'User-Agent':'OSINT-Navigator/0.3','Accept':'image/jpeg,image/png,image/webp,image/gif;q=0.8,*/*;q=0.1','Accept-Encoding':'identity'}
    }, res => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) { req.destroy(new Error('Image exceeds 10 MB limit')); return; }
      const chunks=[]; let size=0;
      res.on('data',chunk=>{ size+=chunk.length; if(size>MAX_BYTES){req.destroy(new Error('Image exceeds 10 MB limit'));return;} chunks.push(chunk); });
      res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,body:Buffer.concat(chunks)}));
      res.on('error',reject);
    });
    // `timeout` is idle-only; this caps a slowloris origin that dribbles bytes forever.
    const hardStop = setTimeout(()=>req.destroy(new Error('Image fetch exceeded total deadline')), TOTAL_DEADLINE_MS);
    req.on('close',()=>clearTimeout(hardStop));
    req.on('timeout',()=>req.destroy(new Error('Image fetch timed out')));
    req.on('error',reject); req.end();
  });
}
export async function safeFetchImage(inputUrl) {
  let current = new URL(inputUrl);
  const seen = new Set();
  for(let redirects=0; redirects<=MAX_REDIRECTS; redirects++) {
    if(!['http:','https:'].includes(current.protocol)) throw new Error('Only http/https URLs are allowed');
    if(current.username||current.password) throw new Error('Credentials in URL are not allowed');
    const expectedPort = current.protocol==='https:' ? '443' : '80';
    if(current.port && current.port!==expectedPort) throw new Error('Non-standard ports are not allowed');
    const key = current.toString();
    if(seen.has(key)) throw new Error('Redirect loop detected');
    seen.add(key);
    const resolved=await resolvePublic(current.hostname);
    const response=await requestOnce(current,resolved);
    if(response.status>=300 && response.status<400 && response.headers.location){
      if(redirects===MAX_REDIRECTS) throw new Error('Too many redirects');
      current=new URL(response.headers.location,current); continue;
    }
    if(response.status<200||response.status>=300) throw new Error(`Image server returned HTTP ${response.status}`);
    const headerType=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
    const actualType=sniffType(response.body);
    if(!actualType) throw new Error('Response is not a supported image');
    if(!typesAgree(headerType,actualType)) throw new Error(`Content-Type mismatch: ${headerType} vs ${actualType}`);
    return {buffer:response.body,contentType:actualType,finalUrl:current.toString(),resolvedIp:resolved.address};
  }
  throw new Error('Redirect handling failed');
}

// Receives package updates. Only verified destination milestones are retained.
export async function onRequestPost({request, env}) {
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
  if (!env.TRACK17_API_KEY || !env.ORDERS_KV) return reply({error:"not configured"},503);
  const length=Number(request.headers.get("content-length")||0);
  if(length>262144) return reply({error:"too large"},413);
  const raw=await request.text();
  if(new TextEncoder().encode(raw).length>262144) return reply({error:"too large"},413);
  const supplied=(request.headers.get("sign")||"").toLowerCase();
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw+"/"+env.TRACK17_API_KEY));
  const expected=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
  if(!/^[0-9a-f]{64}$/.test(supplied)) return reply({error:"unauthorized"},401);
  let difference=0; for(let i=0;i<64;i++) difference|=expected.charCodeAt(i)^supplied.charCodeAt(i);
  if(difference!==0) return reply({error:"unauthorized"},401);
  let payload; try{payload=JSON.parse(raw)}catch{return reply({error:"invalid JSON"},400)}
  if(payload.event!=="TRACKING_UPDATED") return reply({ok:true});
  const data=Array.isArray(payload.data?.accepted)?payload.data.accepted:[payload.data];
  for(const shipment of data){
    const number=shipment?.number;
    if(typeof number!=="string" || !/^[A-Za-z0-9-]{5,100}$/.test(number)) continue;
    const milestones=shipment?.track_info?.time_metrics?.milestone;
    if(!Array.isArray(milestones)) continue;
    const safe=milestones.filter(m=>["Arrival","AvailableForPickup","OutForDelivery","Delivered"].includes(m.key_stage)&&typeof m.time_utc==="string").map(m=>({stage:m.key_stage,time:m.time_utc}));
    const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(number.toUpperCase()));
    const id=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
    await env.ORDERS_KV.put("tracking:milestones:"+id,JSON.stringify({milestones:safe}),{expirationTtl:15552000});
  }
  return reply({ok:true});
}
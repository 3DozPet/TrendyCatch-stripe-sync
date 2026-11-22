// Returns only safe delivery milestones for numbers already registered in 17TRACK.
export async function onRequestPost({ request, env }) {
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  if(!env.TRACK17_API_KEY) return json({error:"Tracking is temporarily unavailable. Please contact us for help."},503);
  if(Number(request.headers.get("content-length")||0)>1024) return json({error:"Invalid request."},400);
  let input; try { input=await request.json(); } catch { return json({error:"Please enter a tracking number."},400); }
  const n=typeof input.number==="string"?input.number.trim():"";
  if(!/^[a-zA-Z0-9-]{5,100}$/.test(n)) return json({error:"Please check your tracking number and try again."},400);
  try {
    const response=await fetch("https://api.17track.net/track/v2.4/gettrackinfo",{method:"POST",headers:{"Content-Type":"application/json","17token":env.TRACK17_API_KEY},body:JSON.stringify([{number:n}])});
    if(!response.ok) return json({error:"Tracking is temporarily unavailable. Please try again later."},503);
    const data=await response.json();
    if(data.code!==0) return json({error:"Tracking is temporarily unavailable. Please try again later."},503);
    const shipments=Array.isArray(data.data?.accepted)?data.data.accepted:[];
    if(!shipments.length) return json({message:"No tracking updates found. Check your number or contact us for help.",updates:[]});
    const labels={Arrival:"Arrived in destination country",AvailableForPickup:"Available for pickup",OutForDelivery:"Out for delivery",Delivered:"Delivered"};
    const updates=[];
    for(const s of shipments){
      const milestones=s?.track_info?.time_metrics?.milestone;
      if(!Array.isArray(milestones)) continue;
      for(const m of milestones){
        if(!Object.hasOwn(labels,m?.key_stage)) continue;
        const time=m.time_utc||m.time_iso;
        if(typeof time!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(time) || Number.isNaN(Date.parse(time))) continue;
        if(!updates.some(x=>x.stage===m.key_stage)) updates.push({stage:m.key_stage,label:labels[m.key_stage],time:new Date(time).toISOString()});
      }
    }
    updates.sort((a,b)=>Date.parse(b.time)-Date.parse(a.time));
    return json({message:updates.length?"Latest delivery updates":"Destination tracking updates are not available yet. Please check again later.",updates});
  } catch { return json({error:"Tracking is temporarily unavailable. Please try again later."},503); }
}
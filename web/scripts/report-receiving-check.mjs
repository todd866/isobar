#!/usr/bin/env node
// Read-only. Offline fixtures by default; --live is an explicit operator action.
import {readFile} from 'node:fs/promises';
import {resolveMx} from 'node:dns/promises';
const args=process.argv.slice(2), domain='isobar.md';
async function request(path){
 if(!process.env.RESEND_API_KEY)throw new Error('RESEND_API_KEY unavailable');
 const response=await fetch(`https://api.resend.com${path}`,{headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`},redirect:'error',signal:AbortSignal.timeout(10_000)});
 if(!response.ok)throw new Error(`Resend domain lookup returned ${response.status}`);return response.json();
}
try{
 let row,mx;
 if(args[0]==='--fixture' && args[1])row=JSON.parse(await readFile(args[1],'utf8'));
 else if(args.length===1 && args[0]==='--live'){
  const list=await request('/domains'), match=list.data?.find(item=>item.name===domain);
  if(!match)throw new Error('Domain absent from returned domain page; availability unknown');
  row=await request(`/domains/${encodeURIComponent(match.id)}`);mx=await resolveMx(domain);
 }else{process.stdout.write('Usage: node scripts/report-receiving-check.mjs --fixture DOMAIN_JSON | --live\n');process.exit(0);}
 if(row.name!==domain)throw new Error('Expected isobar.md domain response');
 process.stdout.write(JSON.stringify({domain:row.name,status:row.status??'unknown',sending:row.capabilities?.sending??'unknown',receiving:row.capabilities?.receiving??'unknown',records:row.records??[],...(mx?{currentMx:mx}:{}),attestation:'Not verified: raw Authentication-Results headers are insufficient'},null,2)+'\n');
}catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}

// Sends one request on to the live game server and hands back its answer.
// forwardRequest only collects the answer, so the caller can decide what to do if the server is down.
async function forwardRequest(request,origin,timeoutMs=25000) {
  const base=new URL(origin);
  if(base.username||base.password||base.search||base.hash||base.pathname!=="/"||base.protocol!=="https:"&&process.env.NODE_ENV!=="test")throw new Error("Invalid backend origin");
  const url=new URL(request.url,"https://game.invalid");
  const headers={};
  for(const name of ["cookie","content-type","accept"])if(request.headers[name])headers[name]=request.headers[name];
  let body;
  if(!["GET","HEAD"].includes(request.method)) {
    if(request.body!==undefined)body=typeof request.body==="string"||Buffer.isBuffer(request.body)?request.body:JSON.stringify(request.body);
    else {
      const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>2_000_000)throw new Error("Request too large");chunks.push(chunk);}
      body=Buffer.concat(chunks);
      request.body=body; // keep it, in case the request has to be handled somewhere else after all
    }
    if(Buffer.byteLength(body)>2_000_000)throw new Error("Request too large");
  }
  const upstream=await fetch(new URL(url.pathname+url.search,base),{method:request.method,headers,body,redirect:"manual",signal:AbortSignal.timeout(timeoutMs)});
  const kept={};
  for(const name of ["content-type","cache-control","retry-after","x-content-type-options"])if(upstream.headers.has(name))kept[name]=upstream.headers.get(name);
  return {status:upstream.status,headers:kept,cookies:upstream.headers.getSetCookie(),body:Buffer.from(await upstream.arrayBuffer())};
}

function sendForwarded(response,forwarded) {
  for(const [name,value] of Object.entries(forwarded.headers))response.setHeader(name,value);
  if(forwarded.cookies.length)response.setHeader("Set-Cookie",forwarded.cookies);
  response.writeHead(forwarded.status);response.end(forwarded.body);
}

async function proxyBackend(request,response,origin,timeoutMs) {
  sendForwarded(response,await forwardRequest(request,origin,timeoutMs));
}
module.exports={proxyBackend,forwardRequest,sendForwarded};

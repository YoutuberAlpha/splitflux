async function proxyBackend(request,response,origin) {
  const base=new URL(origin);
  if(base.username||base.password||base.search||base.hash||base.pathname!=="/"||base.protocol!=="https:"&&process.env.NODE_ENV!=="test")throw new Error("Invalid backend origin");
  const url=new URL(request.url,"https://game.invalid");
  const headers={};
  for(const name of ["cookie","content-type","accept"])if(request.headers[name])headers[name]=request.headers[name];
  let body;
  if(!["GET","HEAD"].includes(request.method)) {
    if(request.body!==undefined)body=typeof request.body==="string"||Buffer.isBuffer(request.body)?request.body:JSON.stringify(request.body);
    else {const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>2_000_000)throw new Error("Request too large");chunks.push(chunk);}body=Buffer.concat(chunks);}
    if(Buffer.byteLength(body)>2_000_000)throw new Error("Request too large");
  }
  const upstream=await fetch(new URL(url.pathname+url.search,base),{method:request.method,headers,body,redirect:"manual",signal:AbortSignal.timeout(25000)});
  for(const name of ["content-type","cache-control","retry-after","x-content-type-options"])if(upstream.headers.has(name))response.setHeader(name,upstream.headers.get(name));
  const cookies=upstream.headers.getSetCookie();if(cookies.length)response.setHeader("Set-Cookie",cookies);
  response.writeHead(upstream.status);response.end(Buffer.from(await upstream.arrayBuffer()));
}
module.exports={proxyBackend};

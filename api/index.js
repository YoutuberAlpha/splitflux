const {Pool}=require("pg");
const {createCloudHandler}=require("../cloud-runtime.cjs");
let handler;

module.exports=async(request,response)=>{
  const url=new URL(request.url,"https://splitflux-agario.vercel.app");
  const route=request.query?.route||url.searchParams.get("route");
  if (route) {
    const pathname=Array.isArray(route)?route.join("/"):route;
    if (!/^[a-zA-Z0-9/_-]+$/.test(pathname)) {response.writeHead(404);response.end("Not found");return;}
    url.searchParams.delete("route");
    request.url=(pathname==="health"?"/health":"/api/"+pathname)+url.search;
  }
  if(process.env.SPLITFLUX_BACKEND_ORIGIN){
    try{await require("../backend-proxy.cjs").proxyBackend(request,response,process.env.SPLITFLUX_BACKEND_ORIGIN);}catch{
      response.writeHead(503,{"Content-Type":"application/json","Cache-Control":"no-store","Retry-After":"3"});
      response.end(JSON.stringify({error:"The game server is waking up. Please retry shortly."}));
    }
    return;
  }
  if (!handler) {
    const connectionString=process.env.DATABASE_URL||process.env.POSTGRES_URL;
    if (!connectionString) {
      response.writeHead(503,{"Content-Type":"application/json","Cache-Control":"no-store"});
      response.end(JSON.stringify({error:"Connect the shared database before playing."}));return;
    }
    const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:8000,idleTimeoutMillis:10000,allowExitOnIdle:true});
    pool.on("error",error=>console.error("SPLITFLUX database connection failed",error.code||error.name));
    handler=createCloudHandler(pool);
  }
  await handler(request,response);
};

const assert=require("assert/strict"),http=require("http"),fs=require("fs"),vm=require("vm"),path=require("path");
const {proxyBackend}=require("../backend-proxy.cjs"),{captureResponse}=require("../cloud-runtime.cjs");
let received;const previous=process.env.NODE_ENV;
const server=http.createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  received={url:request.url,cookie:request.headers.cookie,body:Buffer.concat(chunks).toString()};
  response.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store","Set-Cookie":["one=test; Path=/; HttpOnly","two=test; Path=/; HttpOnly"]});response.end(JSON.stringify({ok:true}));
});
(async()=>{
 try{
  process.env.NODE_ENV="test";await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const context=vm.createContext({require(name){if(name==="pg")return {Pool:class{constructor(){throw new Error("Proxy must not open a database connection");}}};if(name==="../cloud-runtime.cjs")return {createCloudHandler(){throw new Error("Wrong runtime");}};if(name==="../backend-proxy.cjs")return {proxyBackend};throw new Error(name);},module:{exports:{}},URL,Buffer,console,process:{env:{NODE_ENV:"test",SPLITFLUX_BACKEND_ORIGIN:origin}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,"..","api","index.js"),"utf8"),context);
  const response=captureResponse();
  await context.module.exports({method:"POST",url:"/api/index?route=state&v=3",query:{route:"state"},headers:{cookie:"test_session=example","content-type":"application/json"},body:{running:true}},response);
  assert.equal(received.url,"/api/state?v=3");assert.equal(received.cookie,"test_session=example");assert.equal(JSON.parse(received.body).running,true);
  assert.equal(response.statusCode,200);assert.equal(response.getHeader("Set-Cookie").length,2,"All login/device cookies must survive the same-origin proxy");
  assert.equal(response.getHeader("cache-control"),"no-store");
  await assert.rejects(proxyBackend({url:"/api/state",method:"GET",headers:{}},captureResponse(),"https://user:password@example.invalid/"),/Invalid backend origin/);
  console.log("PASS: Vercel forwards game requests and both authentication cookies without opening the database, preserves route queries, and rejects unsafe origins.");
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});

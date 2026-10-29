const crypto=require("crypto");
const {captureResponse}=require("./cloud-runtime.cjs");

function attachRealtime(server,{getSession,dispatch}) {
  const {WebSocketServer}=require("ws");
  const sockets=new Set(),tickets=new Map();
  const allowed=new Set((process.env.SPLITFLUX_ALLOWED_ORIGINS||"https://splitflux-agario.vercel.app,https://splitflux.vercel.app").split(","));
  if(process.env.RENDER_EXTERNAL_URL)allowed.add(process.env.RENDER_EXTERNAL_URL);
  // Updates to one player look a lot like the previous one, so the server keeps its compression memory
  // between messages (no "context takeover" reset): repeated names, colours and ids then cost almost nothing.
  // A 16 KB memory window holds the last few updates and uses about 0.2 MB per connected player.
  const wss=new WebSocketServer({noServer:true,maxPayload:2_000_000,perMessageDeflate:{
    threshold:256,serverNoContextTakeover:false,clientNoContextTakeover:true,serverMaxWindowBits:14,
    concurrencyLimit:2,zlibDeflateOptions:{level:1},
  }});
  const digest=value=>crypto.createHash("sha256").update(value).digest("hex");
  server.on("upgrade",(request,socket,head)=>{
    const origin=request.headers.origin;
    let hostname;
    try{hostname=new URL("http://"+request.headers.host).hostname;}catch{socket.destroy();return;}
    const local=!process.env.RENDER&&["localhost","127.0.0.1","[::1]"].includes(hostname);
    const own=local&&["http://"+request.headers.host,"https://"+request.headers.host].includes(origin);
    if(request.url!=="/realtime"||(!allowed.has(origin)&&!own)) {socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");return;}
    wss.handleUpgrade(request,socket,head,ws=>wss.emit("connection",ws,request));
  });
  wss.on("connection",ws=>{
    sockets.add(ws);
    let identity=null,busy=false;
    const timeout=setTimeout(()=>{if(!identity)ws.close(4001,"Authentication required");},5000);
    timeout.unref();
    ws.on("error",()=>{});
    ws.on("close",()=>{clearTimeout(timeout);sockets.delete(ws);});
    ws.on("message",async(data,binary)=>{
      if(busy)return;
      if(binary){ws.close(4002,"JSON required");return;}
      try {
        const message=JSON.parse(data.toString());
        if(!identity){
          if(message.type!=="auth"||typeof message.ticket!=="string"){ws.close(4001,"Invalid authentication");return;}
          const key=digest(message.ticket),ticket=tickets.get(key);tickets.delete(key);
          const session=ticket&&getSession(ticket.id);
          if(!session||ticket.expires<Date.now()||session.sessionKey!==ticket.sessionKey){ws.close(4001,"Ticket expired");return;}
          identity=ticket;ws.deviceId=session.deviceId;clearTimeout(timeout);
          ws.send(JSON.stringify({type:"ready"}));return;
        }
        const session=getSession(identity.id);
        if(!session||session.sessionKey!==identity.sessionKey){ws.close(4001,"Session expired");return;}
        if(message.type!=="state"||!Number.isSafeInteger(message.sequence))return;
        if(ws.bufferedAmount>2_000_000){ws.close(4008,"Slow connection");return;}
        busy=true;
        const response=captureResponse();
        await dispatch({method:"POST",url:"/api/state",headers:{host:"realtime",cookie:identity.cookie},
          body:{...message.payload,id:identity.id,sessionKey:identity.sessionKey}},response);
        if(ws.readyState===1)ws.send(JSON.stringify({type:"state",sequence:message.sequence,status:response.statusCode,body:JSON.parse(response.body.toString())}));
      }catch{ws.close(4002,"Invalid message");}finally{busy=false;}
    });
  });
  return {
    issue(request,session){
      for(const [key,ticket]of tickets)if(ticket.expires<Date.now())tickets.delete(key);
      if(tickets.size>=1000)throw new Error("Too many connection requests");
      const ticket=crypto.randomBytes(32).toString("base64url");
      tickets.set(digest(ticket),{id:session.id,sessionKey:session.sessionKey,cookie:String(request.headers.cookie||""),deviceId:session.deviceId,expires:Date.now()+60000});
      const origin=process.env.RENDER_EXTERNAL_URL||"http://"+request.headers.host;
      const url=new URL("/realtime",origin);url.protocol=url.protocol==="https:"?"wss:":"ws:";
      return {available:true,url:url.href,ticket};
    },
    invalidateDevice(deviceId){
      for(const ws of sockets)if(ws.deviceId===deviceId)ws.close(4001,"Authentication changed");
      for(const [key,ticket]of tickets)if(ticket.deviceId===deviceId)tickets.delete(key);
    },
    close(){for(const ws of sockets)ws.close(1001,"Server restarting");wss.close();},
  };
}
module.exports={attachRealtime};

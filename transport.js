(function(root,factory){if(typeof module==="object"&&module.exports)module.exports=factory();else root.RoomTransport=factory();})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function create({fetch:request,WebSocket:Socket,setTimeout:later=setTimeout,clearTimeout:cancel=clearTimeout}){
    let socket=null,opening=null,sequence=0,nextAttempt=0,pending=new Map(),generation=0;
    function reset(){
      const old=socket;socket=null;old?.close();
      for(const job of pending.values()){cancel(job.timeout);job.reject(new Error("Connection closed"));}pending.clear();
    }
    async function connect(session){
      if(socket?.readyState===1)return true;
      if(opening)return opening;
      if(Date.now()<nextAttempt)return false;
      const epoch=generation;
      nextAttempt=Date.now()+5000;
      opening=(async()=>{
        const response=await request("/api/realtime-ticket",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:session.id,sessionKey:session.sessionKey})});
        if(!response.ok||epoch!==generation)return false;
        const config=await response.json();if(!config.available){nextAttempt=Date.now()+60000;return false;}
        const ws=new Socket(config.url);socket=ws;
        return await new Promise(resolve=>{
          let ready=false;
          const timeout=later(()=>{if(!ready){ws.close();resolve(false);}},5000);
          ws.onopen=()=>ws.send(JSON.stringify({type:"auth",ticket:config.ticket}));
          ws.onmessage=event=>{
            try{
              const message=JSON.parse(event.data);
              if(message.type==="ready"){if(epoch!==generation){ws.close();resolve(false);return;}ready=true;cancel(timeout);resolve(true);return;}
              const job=pending.get(message.sequence);if(message.type!=="state"||!job)return;
              pending.delete(message.sequence);cancel(job.timeout);
              job.resolve({ok:message.status>=200&&message.status<300,status:message.status,json:async()=>message.body});
            }catch{ws.close();}
          };
          ws.onclose=()=>{cancel(timeout);if(socket===ws)reset();resolve(false);};
          ws.onerror=()=>{ws.close();};
        });
      })().catch(()=>false).finally(()=>{if(epoch===generation)opening=null;});
      return opening;
    }
    return {
      connect,
      reset(){generation++;opening=null;nextAttempt=0;reset();},
      get realtime(){return socket?.readyState===1;},
      async state(payload){
        if(socket?.readyState!==1)return request("/api/state",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),cache:"no-store"});
        const id=++sequence;
        return new Promise((resolve,reject)=>{
          const timeout=later(()=>{pending.delete(id);reset();reject(new Error("Server timed out"));},5000);
          pending.set(id,{resolve,reject,timeout});
          try{socket.send(JSON.stringify({type:"state",sequence:id,payload}));}catch(error){pending.delete(id);cancel(timeout);reject(error);}
        });
      },
    };
  }
  return {create};
});

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FeedPhysics = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const cost = 25, value = 22, minimumMass = cost + 28, duration = .36;
  const motionFields = ["x", "y", "vx", "vy", "flightX", "flightY", "flightEndX", "flightEndY", "flightAge", "flightDuration"];
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function create(cell, dx, dy, target, size=Infinity) {
    const length = Math.hypot(dx, dy);
    const dirX = length > 1e-6 ? dx / length : 1, dirY = length > 1e-6 ? dy / length : 0;
    const radius = Math.sqrt(Math.max(.000001, cell.mass)) * 4.2 + 8;
    const distance = target ? Math.hypot(target.x-cell.x,target.y-cell.y) : Infinity;
    let boundary=Infinity;
    if (Number.isFinite(size)) {
      if (dirX>0) boundary=Math.min(boundary,(size-8-cell.x)/dirX);
      if (dirX<0) boundary=Math.min(boundary,(8-cell.x)/dirX);
      if (dirY>0) boundary=Math.min(boundary,(size-8-cell.y)/dirY);
      if (dirY<0) boundary=Math.min(boundary,(8-cell.y)/dirY);
      boundary=Math.max(0,boundary);
    }
    const offset = Math.min(radius+10,distance,boundary);
    const range = Math.min(Math.max(0,distance-offset),clamp(90+radius*.6,100,360),boundary-offset);
    const x = cell.x+dirX*offset, y = cell.y+dirY*offset;
    return {x,y,vx:dirX*range*3/duration,vy:dirY*range*3/duration,
      dirX,dirY,targetX:target?.x,targetY:target?.y,value,r:8,
      flightX:x,flightY:y,flightEndX:x+dirX*range,flightEndY:y+dirY*range,
      flightAge:0,flightDuration:duration};
  }

  function move(shot, dt, size) {
    // Old in-flight pellets remain playable when a server is updated mid-round.
    if (!Number.isFinite(shot.flightX)) {
      shot.flightX=shot.x;shot.flightY=shot.y;
      shot.flightEndX=shot.x+(Number(shot.vx)||0)*duration/3;
      shot.flightEndY=shot.y+(Number(shot.vy)||0)*duration/3;
      shot.flightAge=0;shot.flightDuration=duration;
    }
    shot.flightAge=Math.min(shot.flightDuration,shot.flightAge+Math.max(0,dt));
    const remaining=Math.max(0,1-shot.flightAge/shot.flightDuration);
    const progress=1-remaining*remaining*remaining;
    const min=Math.min(shot.r||8,size/2), max=Math.max(min,size-min);
    shot.x=clamp(shot.flightX+(shot.flightEndX-shot.flightX)*progress,min,max);
    shot.y=clamp(shot.flightY+(shot.flightEndY-shot.flightY)*progress,min,max);
    shot.vx=(shot.flightEndX-shot.flightX)*3/shot.flightDuration*remaining*remaining;
    shot.vy=(shot.flightEndY-shot.flightY)*3/shot.flightDuration*remaining*remaining;
  }

  return {create,move,cost,value,minimumMass,motionFields,maxPending:160,interval:.02};
});

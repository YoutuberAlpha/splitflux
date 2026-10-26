/* Split boost decay adapted from MultiOgar Cell.move (Apache-2.0).
 * Copyright 2015 Devin Ryan; Barbosik and MultiOgar contributors.
 * Feed braking adapted from owenashurst/agar.io-clone MassFood.move (MIT).
 * Copyright (c) 2015 Huy Tran; agar.io-clone contributors.
 * Adapted for elapsed seconds and SPLITFLUX units; see THIRD-PARTY-NOTICES.txt.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BlobPhysics = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const launchDecay = -Math.log(.9) / .04;
  function radius(mass) { return Math.sqrt(Math.max(.000001, Number(mass) || .000001)) * 4.2 + 8; }
  function direction(x, y) {
    const length = Math.hypot(x, y);
    return length > .000001 ? { x: x / length, y: y / length } : { x: 1, y: 0 };
  }
  function moveBoost(body, dt, size, fieldX = "vx", fieldY = "vy", padding = body.r || body.radius || 0) {
    const damping = Math.exp(-launchDecay * Math.max(0, dt));
    const travel = (1 - damping) / launchDecay;
    const min = Math.min(padding, size / 2), max = Math.max(min, size - padding);
    body.x = clamp(body.x + (Number(body[fieldX]) || 0) * travel, min, max);
    body.y = clamp(body.y + (Number(body[fieldY]) || 0) * travel, min, max);
    body[fieldX] *= damping;
    body[fieldY] *= damping;
  }
  function createFeed(cell, x, y) {
    const dir = direction(x, y), r = radius(cell.mass);
    const range = clamp(100 + r * .65, 120, 360);
    const stopTime = .45;
    const speed = 2 * range / stopTime;
    return { x: cell.x + dir.x * (r + 10), y: cell.y + dir.y * (r + 10),
      vx: dir.x * speed, vy: dir.y * speed, dirX: dir.x, dirY: dir.y, feedDrag: speed / stopTime, value: 2.2, r: 8 };
  }
  function moveFeed(body, dt, size) {
    const speed = Math.hypot(body.vx, body.vy);
    if (!speed) return;
    const drag = Number.isFinite(body.feedDrag) && body.feedDrag > 0 ? body.feedDrag : speed / .45;
    body.feedDrag = drag;
    const elapsed = Math.min(Math.max(0, dt), speed / drag);
    const travel = speed * elapsed - .5 * drag * elapsed * elapsed;
    const min = Math.min(body.r, size / 2), max = Math.max(min, size - body.r);
    body.x = clamp(body.x + body.vx / speed * travel, min, max);
    body.y = clamp(body.y + body.vy / speed * travel, min, max);
    const remaining = Math.max(0, speed - drag * elapsed);
    body.vx *= remaining / speed;
    body.vy *= remaining / speed;
  }
  function catchesFeed(cell, pellet, previousX = pellet.x, previousY = pellet.y) {
    const dx = pellet.x - previousX, dy = pellet.y - previousY, lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? clamp(((cell.x - previousX) * dx + (cell.y - previousY) * dy) / lengthSquared, 0, 1) : 0;
    return Math.hypot(cell.x - previousX - dx * t, cell.y - previousY - dy * t) < cell.radius + pellet.r * .5;
  }
  return { radius, direction, moveBoost, moveFeed, createFeed, catchesFeed, feedCost: 2.5, minFeedMass: 20 };
});

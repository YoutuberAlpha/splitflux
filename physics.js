/* Split boost decay adapted from MultiOgar Cell.move (Apache-2.0).
 * Copyright 2015 Devin Ryan; Barbosik and MultiOgar contributors.
 * Feeding is implemented separately in feeding.js.
 * Adapted for elapsed seconds and SPLITFLUX units; see THIRD-PARTY-NOTICES.txt.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./feeding.js"));
  else root.BlobPhysics = factory(root.FeedPhysics);
})(typeof globalThis !== "undefined" ? globalThis : this, function (feeding) {
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
  function catchesFeed(cell, pellet, previousX = pellet.x, previousY = pellet.y) {
    const dx = pellet.x - previousX, dy = pellet.y - previousY, lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? clamp(((cell.x - previousX) * dx + (cell.y - previousY) * dy) / lengthSquared, 0, 1) : 0;
    return Math.hypot(cell.x - previousX - dx * t, cell.y - previousY - dy * t) < cell.radius + pellet.r * .5;
  }
  // Shared food (SPLITFLUX code, not from MultiOgar). Every dot's spot comes from the arena seed,
  // the dot's slot number and how many times that slot has been eaten (0-255, wrapping), so the server
  // and every player compute the exact same food without sending tens of thousands of positions.
  const foodCount = 49600;
  function unit(value) {
    let t = (value + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function foodAt(seed, index, version, size) {
    const base = (seed ^ Math.imul(index + 1, 0x9E3779B1) ^ Math.imul((version & 255) + 1, 0x85EBCA77)) | 0;
    const span = Math.max(0, size - 70);
    return {
      x: 35 + unit(base) * span,
      y: 35 + unit(base + 1) * span,
      r: 2.4 + unit(base + 2) * 2.8,
      value: .7 + unit(base + 3) * .8,
      colorIndex: Math.floor(unit(base + 4) * 8),
      pulse: unit(base + 5) * Math.PI * 2,
    };
  }
  const food = { count: foodCount, at: foodAt };
  return { radius, direction, moveBoost, moveFeed:feeding.move, createFeed:feeding.create, catchesFeed,
    feedCost:feeding.cost, feedValue:feeding.value, minFeedMass:feeding.minimumMass, feeding, food };
});

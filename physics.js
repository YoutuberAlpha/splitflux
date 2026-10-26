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
  return { radius, direction, moveBoost, moveFeed:feeding.move, createFeed:feeding.create, catchesFeed,
    feedCost:feeding.cost, feedValue:feeding.value, minFeedMass:feeding.minimumMass, feeding };
});

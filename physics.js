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

  // ---- Spikes ----
  // One set of rules for players, bots, the game and the server, so a pop looks and counts the same everywhere.
  // - A piece pops a spike as soon as it hits it (overlaps the spike's edge) and is big enough (90+ mass).
  //   Smaller pieces slide under spikes.
  // - A popped blob always turns into 15 blobs of the same mass: one stays in the middle and 14 burst out in an
  //   even ring. This is an exception to the normal 16-piece limit; only a hard safety limit of 64 pieces
  //   (so the game stays smooth) can make a pop smaller.
  const SPIKE_RADIUS = 42, POP_MASS = 90, MAX_SHARDS = 14, MAX_PIECES = 64;
  function spikeCovered(cell, spike) {
    const size = Number(cell.radius) || radius(cell.mass), spikeSize = Number(spike.r) || SPIKE_RADIUS;
    return cell.mass >= POP_MASS && size > spikeSize && Math.hypot(cell.x - spike.x, cell.y - spike.y) < size + spikeSize * .65;
  }
  // [mass of the middle piece, ...shard masses] (all equal), or [] when it can't pop (no room left at all).
  function popMasses(mass, freeSlots) {
    const shards = Math.min(MAX_SHARDS, Math.floor(freeSlots));
    if (!(shards >= 1) || !(mass > 0)) return [];
    return Array.from({ length: shards + 1 }, () => mass / (shards + 1));
  }
  // Where shard i of n starts and how fast it flies out: an even ring around the piece, turned by `turn`.
  function shardLaunch(parent, index, count, turn, keptRadius) {
    const angle = turn + Math.PI * 2 * index / count;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    return { x: parent.x + dir.x * keptRadius, y: parent.y + dir.y * keptRadius, launchX: dir.x * 540, launchY: dir.y * 540 };
  }
  const spikes = { radius: SPIKE_RADIUS, popMass: POP_MASS, maxShards: MAX_SHARDS, maxPieces: MAX_PIECES, covered: spikeCovered, popMasses, shardLaunch };

  return { radius, direction, moveBoost, moveFeed:feeding.move, createFeed:feeding.create, catchesFeed,
    feedCost:feeding.cost, feedValue:feeding.value, minFeedMass:feeding.minimumMass, feeding, food, spikes };
});

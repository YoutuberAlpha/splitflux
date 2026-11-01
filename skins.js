// The SKIN SHOP list: every skin, its price in coins and its picture (skins/<id>.webp).
// The game (shop screen, drawing blobs) and the server (buying, checking who owns what) both read this file,
// so a price or a new skin only has to be added here.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SkinShop = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TIERS = { common: 100, rare: 250, epic: 500, legendary: 1000 };
  // Coins: 1 for every 10 mass a player grows past their biggest size in that life.
  const MASS_PER_COIN = 10;
  const list = [
    ["void", "Void Orb", "common"], ["frosty", "Frosty", "common"], ["browser", "Browser", "common"], ["swirl", "Tadpole Swirl", "common"],
    ["eagle", "Eagle", "rare"], ["pirate", "Pirate Blob", "rare"], ["speedster", "Blue Speedster", "rare"], ["plumber", "Plumber", "rare"],
    ["kanji", "Purple Kanji", "epic"], ["squid", "Deep Squid", "epic"], ["ice", "Ice Beast", "epic"], ["toxic", "Toxic Flame", "epic"],
    ["dragon", "Yin-Yang Dragon", "legendary"], ["mech", "Dark Mech", "legendary"], ["wolf", "Frost Wolf", "legendary"], ["demon", "Pink Demon", "legendary"],
  ].map(([id, name, tier]) => Object.freeze({ id, name, tier, price: TIERS[tier], image: `/skins/${id}.webp` }));
  // A lookup with no built-in keys, so names like "constructor" are never mistaken for a skin.
  const byId = Object.assign(Object.create(null), ...list.map(skin => ({ [skin.id]: skin })));
  const find = id => (typeof id === "string" && byId[id]) || null;
  return { list, find, tiers: TIERS, massPerCoin: MASS_PER_COIN };
});

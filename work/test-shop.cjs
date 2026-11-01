// SKIN SHOP: 16 skins with pictures and prices; coins come only from real growth (1 for every 10 mass past your
// biggest size this life) and are kept on your account; buying, wearing, and everyone seeing it; nobody can wear
// a skin they don't own; the owner owns every skin.
const assert = require("assert/strict");
const fs = require("fs"), path = require("path");
const SkinShop = require("../skins.js");
const {createServer} = require("./server-harness.cjs");

const total = cells => cells.reduce((sum, cell) => sum + cell.mass, 0);
const speedFor = mass => 235 / Math.pow(mass / 25, .18);

(async () => {
  // ---- The shop list: 16 skins, a picture for each, four price levels. ----
  assert.equal(SkinShop.list.length, 16);
  assert.deepEqual(SkinShop.tiers, {common: 100, rare: 250, epic: 500, legendary: 1000});
  for (const skin of SkinShop.list) {
    const picture = fs.readFileSync(path.join(__dirname, "..", skin.image));
    assert.equal(picture.toString("ascii", 0, 4) + picture.toString("ascii", 8, 12), "RIFFWEBP", skin.id + " is a WebP picture");
    assert(picture.length < 40_000, skin.id + " is small enough to load quickly");
    assert.equal(skin.price, SkinShop.tiers[skin.tier]);
  }
  for (const tier of Object.keys(SkinShop.tiers)) assert.equal(SkinShop.list.filter(skin => skin.tier === tier).length, 4, "4 skins per price level");
  assert.equal(SkinShop.find("constructor"), null, "Only real skins are found");
  assert.equal(SkinShop.find("__proto__"), null);
  const build = fs.readFileSync(path.join(__dirname, "build-vercel.cjs"), "utf8");
  assert(build.includes('"skins.js"') && build.includes('"skins"'), "The website build publishes the shop list and pictures");

  // ---- The coin rule. ----
  {
    const game = createServer();
    const s = game.run(`({running: true, cells: [{alive: true, mass: 50}], account: {username: "bob", role: "player"}, isAdmin: false})`);
    const credit = wasRunning => game.run("creditGrowth")(s, wasRunning);
    const coins = () => game.run("shop").coins({username: "bob"});
    credit(false);                       // the first update of a life only notes the starting size
    assert.equal(coins(), 0);
    s.cells[0].mass = 175; credit(true);  // grew 125 → 12 coins (the half coin is kept for later)
    assert.equal(coins(), 12);
    s.cells[0].mass = 100; credit(true);  // shrank (fed, decay): nothing
    s.cells[0].mass = 170; credit(true);  // growing back to where it was doesn't count again
    assert.equal(coins(), 12, "Growing back doesn't pay twice");
    s.cells[0].mass = 180; credit(true);  // 5 new mass + the kept half = 1 coin
    assert.equal(coins(), 13);
    s.cells = [{alive: true, mass: 120}, {alive: true, mass: 120}, {alive: false, mass: 999}]; credit(true);  // split pieces add up; dead ones don't
    assert.equal(coins(), 19);
    s.running = false; s.cells = []; credit(true);                         // died
    s.running = true; s.cells = [{alive: true, mass: 40}]; credit(false); // new life from the start size
    s.cells[0].mass = 140; credit(true);
    assert.equal(coins(), 29, "Each new life earns again from its start");
    s.isAdmin = true; s.cells[0].mass = 9000; credit(true);
    assert.equal(coins(), 29, "Admins don't earn coins (the server doesn't check an admin's size)");
    s.isAdmin = false; s.cells[0].mass = 9010; credit(true);
    assert.equal(coins(), 30, "After losing admin, only new growth counts");
    // A guest's coins wait on their session and move to the account they sign in to.
    const guest = game.run(`({running: true, cells: [{alive: true, mass: 50}], account: null, isAdmin: false})`);
    game.run("creditGrowth")(guest, false); guest.cells[0].mass = 350; game.run("creditGrowth")(guest, true);
    assert.equal(guest.guestCoins, 30);
    guest.account = {username: "newbie", role: "player"}; game.run("creditGrowth")(guest, true);
    assert.equal(game.run("shop").coins({username: "newbie"}), 30, "Coins earned as a guest go onto the account");
    assert.equal(guest.guestCoins, 0);
  }

  // ---- Honest play through the real game updates earns coins (anti-cheat on). ----
  const game = createServer();
  const bob = await game.player(false, "bob");
  let snap = await bob.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
  assert.deepEqual({...snap.wallet, sig: undefined}, {coins: 0, unsaved: 0, skin: "", signedIn: true, sig: undefined});
  const cell = {...snap.self.cells[0]};
  const start = cell.mass;
  let angle = 0;
  for (let step = 0; step < 150; step++) {
    game.advance(150);
    const fromX = cell.x, fromY = cell.y;
    angle += .15;
    const travel = speedFor(cell.mass) * .15 * .98;
    cell.x += Math.cos(angle) * travel; cell.y += Math.sin(angle * .7) * travel * .6;
    if (cell.x > 4600 || cell.x < 600 || cell.y > 4600 || cell.y < 600) {
      cell.x = Math.max(600, Math.min(4600, cell.x)); cell.y = Math.max(600, Math.min(4600, cell.y)); angle += Math.PI;
    }
    snap = await bob.state({cells: [cell], ackRevision: snap.self.revision, foodClaims: bob.eat(cell, fromX, fromY), ackWallet: snap.wallet?.sig ?? bob.lastSig});
    if (snap.wallet) bob.lastSig = snap.wallet.sig;
  }
  const grown = total(snap.self.cells) - start;
  const earned = game.run("shop").coins({username: "bob"});
  assert(grown > 30, "Bob ate plenty, grew " + grown);
  assert.equal(earned, Math.floor(grown / 10), `1 coin per 10 mass (grew ${grown}, got ${earned})`);
  // Faking a size doesn't pay: the server corrects it before counting.
  game.advance(100);
  snap = await bob.state({cells: [{...snap.self.cells[0], mass: 1e9}], ackRevision: snap.self.revision});
  assert.equal(game.run("shop").coins({username: "bob"}), earned, "A faked size earns nothing");
  // The wallet only comes along when it changed.
  game.advance(100);
  const sig = game.run(`walletFor(sessions.get(${JSON.stringify(bob.session.id)}), {}).sig`);
  snap = await bob.state({cells: snap.self.cells, ackRevision: snap.self.revision, ackWallet: sig});
  assert.equal(snap.wallet, undefined, "An unchanged wallet isn't resent");

  // ---- Buying and wearing. ----
  const shopCall = (who, route, body = {}) => game.call(route, {id: who.session.id, sessionKey: who.session.sessionKey, ...body}, who.owner, who.user);
  game.run("shop").earn({username: "bob"}, 400 - earned);  // bob now has 400 coins
  let answer = await shopCall(bob, "/api/shop");
  assert.equal(answer.body.coins, 400); assert.deepEqual(answer.body.owned, []);
  assert.equal((await shopCall(bob, "/api/shop/buy", {skin: "dragon"})).body.error, "You need 600 more coins for Yin-Yang Dragon.");
  assert.equal((await shopCall(bob, "/api/shop/buy", {skin: "nope"})).status, 400);
  assert.equal((await shopCall(bob, "/api/shop/equip", {skin: "eagle"})).body.error, "Buy this skin first.");
  answer = await shopCall(bob, "/api/shop/buy", {skin: "eagle"});
  assert.equal(answer.status, 200);
  assert.equal(answer.body.coins, 150, "Eagle costs 250");
  assert.deepEqual(answer.body.owned, ["eagle"]); assert.equal(answer.body.skin, "eagle", "A new skin is worn straight away");
  assert.equal((await shopCall(bob, "/api/shop/buy", {skin: "eagle"})).body.error, "You already own Eagle.");
  assert.equal((await shopCall(bob, "/api/shop/buy", {skin: "void"})).body.coins, 50);
  assert.equal((await shopCall(bob, "/api/shop/equip", {skin: "eagle"})).body.skin, "eagle", "Switch between skins you own");
  // Everyone sees it.
  const amy = await game.player();
  await amy.state({cells: [{netId: "m", x: 1200, y: 1200, mass: 28, alive: true}], view: 2});
  game.advance(100); await bob.state({cells: snap.self.cells, ackRevision: snap.self.revision});
  const seen = (await amy.state({view: 2})).players.find(player => player.id === bob.session.id);
  assert.equal(seen.skin, "eagle", "Other players see Bob's skin");
  assert.equal((await shopCall(bob, "/api/shop/equip", {skin: ""})).body.skin, "", "Take the skin off");
  assert.equal((await amy.state({view: 2})).players.find(player => player.id === bob.session.id).skin, undefined);
  // Guests can look but not buy or wear.
  assert.equal((await shopCall(amy, "/api/shop")).body.signedIn, false);
  assert.match((await shopCall(amy, "/api/shop/buy", {skin: "void"})).body.error, /Sign in/);
  // A skin can't be sent by the game itself (old uploads included).
  await amy.state({skin: "dragon"}); await amy.state({skin: "data:image/png;base64,AAAA"});
  assert.equal(game.run(`sessions.get(${JSON.stringify(amy.session.id)}).skin`), "");
  // A wrong session key is refused.
  assert.equal((await game.call("/api/shop/buy", {id: bob.session.id, sessionKey: "wrong", skin: "void"}, false, "bob")).status, 401);

  // ---- The owner owns every skin. ----
  const owner = await game.player(true);
  answer = await shopCall(owner, "/api/shop");
  assert.equal(answer.body.ownsAll, true); assert.equal(answer.body.owned.length, 16);
  assert.equal((await shopCall(owner, "/api/shop/equip", {skin: "demon"})).body.skin, "demon");

  // ---- Saved: a new server reads the coins and skins back. ----
  const shopModule = require("../shop.cjs"), os = require("os");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "splitflux-shop-test-"));
  const first = shopModule(folder);
  first.earn({username: "zed"}, 120); first.buy({username: "zed", role: "player"}, "frosty"); first.earn({username: "zed"}, 7);
  first.flush();
  const again = shopModule(folder);
  assert.deepEqual(again.view({username: "zed", role: "player"}), {signedIn: true, coins: 27, owned: ["frosty"], skin: "frosty", ownsAll: false});
  fs.writeFileSync(path.join(folder, "shop.json"), JSON.stringify({zed: {coins: -5, owned: ["frosty", "fake"], skin: "fake"}, "Bad Name": {coins: 9}}));
  assert.deepEqual(shopModule(folder).view({username: "zed", role: "player"}), {signedIn: true, coins: 0, owned: ["frosty"], skin: "", ownsAll: false}, "A damaged file is cleaned up");
  fs.rmSync(folder, {recursive: true, force: true});

  console.log(`PASS: 16 shop skins (4 at each price: 100/250/500/1000) with pictures, coins only from real growth (1 per 10 mass past your best this life, not for admins, not for faked sizes, guest coins move to the account), honest play earned ${earned} coins, buy/wear/take off, everyone sees it, guests can't buy, the game can't pick its own skin, the owner owns all, coins and skins saved.`);
})().catch(error => { console.error(error); process.exitCode = 1; });

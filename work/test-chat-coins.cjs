// CHAT (one per server, rate-limited, sent only when new) and COINS from the owner / real admins
// (add to yourself, gift to a signed-in player, who gets a notice).
const assert = require("assert/strict");
const {createServer} = require("./server-harness.cjs");

(async () => {
  const game = createServer();
  const owner = await game.player(true), bob = await game.player(false, "bob"), amy = await game.player(), carl = await game.player(false, "carl");
  for (const who of [owner, bob, amy, carl]) await who.state({cells: [{netId: "c", x: 1000 + Math.random() * 3000, y: 1000 + Math.random() * 3000, mass: 28, alive: true}]});
  const post = (who, route, body = {}) => game.call(route, {id: who.session.id, sessionKey: who.session.sessionKey, ...body}, who.owner, who.user);
  const coinsOf = username => game.run("shop").coins({username});

  // ---- COINS ----
  assert.equal((await post(bob, "/api/admin/coins", {amount: 100})).status, 403, "Players can't make coins");
  assert.equal((await post(amy, "/api/admin/coins", {amount: 100})).status, 403);
  let answer = await post(owner, "/api/admin/coins", {amount: 5000});
  assert.equal(answer.status, 200); assert.equal(answer.body.coins, 5000, "The owner adds coins to himself");
  for (const amount of [0, -5, 1.5, 2_000_000, "lots"]) assert.equal((await post(owner, "/api/admin/coins", {amount})).status, 400, "Bad amount " + amount);
  answer = await post(owner, "/api/admin/coins", {targetId: bob.session.id, amount: 300});
  assert.equal(answer.status, 200); assert.equal(answer.body.name, "T");
  assert.equal(coinsOf("bob"), 300, "A gift lands on the player's account");
  const bobView = await bob.state();
  assert.deepEqual(bobView.notices, ["T gave you 300 coins!"], "The player is told");
  assert.equal(bobView.wallet.coins, 300);
  assert.equal((await bob.state()).notices, undefined, "Shown once");
  assert.match((await post(owner, "/api/admin/coins", {targetId: amy.session.id, amount: 10})).body.error, /guest/, "Guests can't get coins");
  assert.equal((await post(owner, "/api/admin/coins", {targetId: "gone", amount: 10})).status, 404);
  // A real admin (made admin by the owner) can do it too, for himself and as gifts.
  game.run(`promotedAdmins.push("account:carl")`);
  assert.equal((await post(carl, "/api/admin/coins", {amount: 1_000_000})).body.coins, 1_000_000);
  assert.equal((await post(carl, "/api/admin/coins", {targetId: bob.session.id, amount: 50})).status, 200);
  assert.equal(coinsOf("bob"), 350);
  // A server owner on their own server is an admin there, but not a real admin: no coins.
  game.run(`roomConfig = {id: "r1", name: "Party", host: {username: "bob", deviceId: null}, maxPlayers: 10}; globalAdmins = () => []`);
  assert.equal(game.run(`adminRole(sessions.get(${JSON.stringify(bob.session.id)}).deviceId, {username: "bob", role: "player"})`), "host");
  assert.equal((await post(bob, "/api/admin/coins", {amount: 100})).status, 403, "Server owners can't make coins");
  game.run(`roomConfig = null; globalAdmins = () => promotedAdmins`);

  // ---- CHAT ----
  await amy.state();
  assert.equal((await post(bob, "/api/chat", {text: "   "})).status, 400, "Empty messages are refused");
  answer = await post(bob, "/api/chat", {text: "hello\u0007 everyone‮!", name: "BOB"});
  assert.equal(answer.status, 200);
  let view = await amy.state({ackChat: 0});
  assert.equal(view.chat.messages.length, 1);
  const first = view.chat.messages[0];
  assert.deepEqual([first.name, first.text, first.role], ["BOB", "hello everyone !", undefined], "Control characters are cleaned out");
  const seq = view.chat.seq;
  assert.equal((await amy.state({ackChat: seq})).chat, undefined, "Nothing new, nothing sent");
  game.advance(1000);
  await post(owner, "/api/chat", {text: "x".repeat(300), name: "ALPHA"});
  view = await amy.state({ackChat: seq});
  assert.equal(view.chat.messages.length, 1, "Only the new message");
  assert.equal(view.chat.messages[0].text.length, 120, "120 characters at most");
  assert.equal(view.chat.messages[0].role, "owner", "The owner's messages are tagged");
  assert.equal((await amy.state({ackChat: 999})).chat.messages.length, 2, "After a server restart the recent chat comes again");
  assert.equal((await post(amy, "/api/chat", {text: "guests can chat"})).status, 200);
  // Rate limit: one every 0.7 s, 5 per 10 s.
  assert.equal((await post(amy, "/api/chat", {text: "too fast"})).status, 429);
  for (let i = 0; i < 4; i++) { game.advance(800); assert.equal((await post(amy, "/api/chat", {text: "m" + i})).status, 200); }
  game.advance(800);
  assert.equal((await post(amy, "/api/chat", {text: "sixth"})).status, 429, "5 messages per 10 seconds");
  game.advance(10_000);
  assert.equal((await post(amy, "/api/chat", {text: "later"})).status, 200);
  // Only the newest 40 are kept, and a newcomer gets the last 20.
  for (let i = 0; i < 50; i++) game.run(`chatLog = [...chatLog, {seq: ++chatSeq, name: "X", text: "${i}", at: 0}].slice(-CHAT_KEEP)`);
  assert.equal(game.run("chatLog.length"), 40);
  assert.equal((await amy.state({ackChat: 0})).chat.messages.length, 20);
  assert.equal((await game.call("/api/chat", {id: amy.session.id, sessionKey: "wrong", text: "hi"})).status, 401);
  // Chat survives a save and load (backup hosting mode reloads the arena for every request).
  const saved = game.run("exportState()");
  assert.equal(saved.chatLog.length, 40);
  game.run("chatLog = []; chatSeq = 0"); game.run("importState")(saved);
  assert.equal(game.run("chatLog.length"), 40); assert(game.run("chatSeq") >= 50);

  console.log("PASS: owner and real admins add coins to themselves and gift them to signed-in players (who are told once), not players/guests/server owners, amounts 1-1,000,000; chat per server, cleaned and cut to 120 characters, owner/admin tags, only new messages sent, 1 per 0.7 s and 5 per 10 s, newest 40 kept, saved with the arena.");
})().catch(error => { console.error(error); process.exitCode = 1; });

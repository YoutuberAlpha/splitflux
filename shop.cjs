const fs = require("fs");
const path = require("path");
const SkinShop = require("./skins.js");

// Coins and skins for every account, kept in shop.json next to accounts.json. Coins change all the time while
// people play, so they're written at most every few seconds (buying and equipping are written straight away).
// Only signed-in players have a wallet; the owner owns every skin for free.
module.exports = function createShop(directory) {
  const filename = path.join(directory, "shop.json");
  const wallets = Object.create(null);
  const clean = wallet => ({
    coins: Math.max(0, Math.floor(Number(wallet?.coins) || 0)),
    owned: [...new Set((Array.isArray(wallet?.owned) ? wallet.owned : []).filter(id => SkinShop.find(id)))],
    skin: SkinShop.find(wallet?.skin) ? wallet.skin : "",
  });
  try {
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    for (const [username, wallet] of Object.entries(saved && typeof saved === "object" ? saved : {}))
      if (/^[a-z0-9_]{3,20}$/.test(username)) wallets[username] = clean(wallet);
  } catch {}

  let timer = null;
  function save() {
    clearTimeout(timer); timer = null;
    fs.writeFileSync(filename + ".tmp", JSON.stringify(wallets), { mode: 0o600 });
    fs.renameSync(filename + ".tmp", filename);
  }
  function saveSoon() { if (!timer) { timer = setTimeout(save, 3000); timer.unref?.(); } }
  // Writes waiting coins now (before the hosting code copies the file into the database).
  function flush() { if (timer) save(); }

  const problem = message => Object.assign(new Error(message), { shop: true });
  const ownsAll = account => account?.role === "owner";
  const wallet = account => (wallets[account.username] ||= { coins: 0, owned: [], skin: "" });
  const owns = (account, id) => Boolean(account && SkinShop.find(id)) && (ownsAll(account) || Boolean(wallets[account.username]?.owned.includes(id)));
  // The skin this player wears: only one they own (or "" for none).
  function equipped(account) {
    const id = account && wallets[account.username]?.skin;
    return id && owns(account, id) ? id : "";
  }
  function coins(account) { return account ? wallets[account.username]?.coins || 0 : 0; }
  function view(account) {
    if (!account) return { signedIn: false, coins: 0, owned: [], skin: "", ownsAll: false };
    return { signedIn: true, coins: coins(account), owned: ownsAll(account) ? SkinShop.list.map(skin => skin.id) : [...(wallets[account.username]?.owned || [])],
      skin: equipped(account), ownsAll: ownsAll(account) };
  }
  function earn(account, amount) {
    amount = Math.floor(amount);
    if (!account || !(amount > 0)) return;
    wallet(account).coins += amount;
    saveSoon();
  }
  function buy(account, id) {
    if (!account) throw problem("Sign in to buy skins (your coins are saved on your account).");
    const skin = SkinShop.find(id);
    if (!skin) throw problem("That skin isn't in the shop.");
    if (owns(account, id)) throw problem(`You already own ${skin.name}.`);
    const mine = wallet(account);
    if (mine.coins < skin.price) throw problem(`You need ${skin.price - mine.coins} more coins for ${skin.name}.`);
    mine.coins -= skin.price;
    mine.owned.push(id);
    mine.skin = id;  // wear it straight away
    save();
    return view(account);
  }
  function equip(account, id) {
    if (!account) throw problem("Sign in to wear skins.");
    if (id !== "" && !owns(account, id)) throw problem("Buy this skin first.");
    wallet(account).skin = id;
    save();
    return view(account);
  }
  return { view, coins, equipped, earn, buy, equip, flush };
};

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

/* ===== Railway対応: Volume設定 ===== */
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const DATA_DIR = path.join(STORAGE_DIR, "data");
const UPLOADS_DIR = path.join(STORAGE_DIR, "uploads");

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "database.sqlite"));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, "bg_" + Date.now() + "_" + safeName);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "asb_super_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static("public"));
app.use("/uploads", express.static(UPLOADS_DIR));

/* --- DB初期化 & ★自動マイグレーション --- */
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS software (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      version TEXT,
      description TEXT,
      zip_path TEXT,
      apk_path TEXT,
      zip_downloads INTEGER DEFAULT 0,
      apk_downloads INTEGER DEFAULT 0,
      is_beta INTEGER DEFAULT 0,
      is_update INTEGER DEFAULT 0,
      is_maintenance INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();

  const insertSetting = db.prepare('INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)');
  insertSetting.run('hero_title', 'ASB');
  insertSetting.run('hero_subtitle', 'Production greatly advances freedom.');
  insertSetting.run('bg_image', 'background.jpg');
  insertSetting.run('discord_link', 'https://discord.gg/44cQR8BD');

  // ★ 既存のDBファイルを消さずに「自作・他作」カラムを自動追加する処理
  try { db.prepare("ALTER TABLE software ADD COLUMN is_original INTEGER DEFAULT 0").run(); } catch(e){}
  try { db.prepare("ALTER TABLE software ADD COLUMN is_thirdparty INTEGER DEFAULT 0").run(); } catch(e){}

} catch (err) { console.error("DB Error:", err.message); }

/* --- 認証 --- */
function auth(req, res, next){
  if(!req.session.admin) return res.status(401).json({error:"Unauthorized"});
  next();
}

/* ===== Discord Auth ===== */
app.get("/auth/discord", (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;
  res.redirect(url);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code provided.");
  try {
    const tokenParams = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    });
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: tokenParams,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send("Auth Failed.");

    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${process.env.ALLOWED_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const memberData = await memberRes.json();

    if (memberData.roles && memberData.roles.includes(process.env.ALLOWED_ROLE_ID)) {
      req.session.admin = true;
      req.session.username = memberData.user ? memberData.user.username : "Admin";
      res.redirect("/admin.html");
    } else {
      res.status(403).send("Admin role required.");
    }
  } catch (err) { res.status(500).send("Server Error."); }
});

app.get("/api/me", (req, res) => {
  if (req.session.admin) res.json({ loggedIn: true, user: req.session.username });
  else res.json({ loggedIn: false });
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});


/* ===== サイト設定 API ===== */
app.get("/api/settings", (req, res) => {
  try {
    const rows = db.prepare("SELECT key, value FROM site_settings").all();
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch(e) { res.status(500).json({error: "Server error"}); }
});

app.post("/api/settings", auth, upload.single("bg_image"), (req, res) => {
  try {
    const { hero_title, hero_subtitle, discord_link } = req.body;
    const update = db.prepare("UPDATE site_settings SET value = ? WHERE key = ?");
    
    if (hero_title !== undefined) update.run(hero_title, 'hero_title');
    if (hero_subtitle !== undefined) update.run(hero_subtitle, 'hero_subtitle');
    if (discord_link !== undefined) update.run(discord_link, 'discord_link');
    
    if (req.file) {
      const oldBg = db.prepare("SELECT value FROM site_settings WHERE key = 'bg_image'").get();
      if (oldBg && oldBg.value.startsWith('/uploads/')) {
        const oldFullPath = path.join(UPLOADS_DIR, oldBg.value.replace('/uploads/', ''));
        if (fs.existsSync(oldFullPath)) fs.unlinkSync(oldFullPath);
      }
      update.run(`/uploads/${req.file.filename}`, 'bg_image');
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});


/* ===== ソフトウェア API ===== */
app.get("/api/software", (req, res) => {
  const list = db.prepare("SELECT * FROM software ORDER BY created_at DESC").all();
  res.json(list);
});

app.post("/api/software", auth, (req, res) => {
  try {
    const { name, version, description, zip_url, apk_url, is_beta, is_update, is_maintenance, is_original, is_thirdparty } = req.body;
    
    db.prepare(`
      INSERT INTO software (name, version, description, zip_path, apk_path, is_beta, is_update, is_maintenance, is_original, is_thirdparty)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      name, version, description, zip_url || "", apk_url || "",
      is_beta ? 1 : 0, is_update ? 1 : 0, is_maintenance ? 1 : 0,
      is_original ? 1 : 0, is_thirdparty ? 1 : 0
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.put("/api/software/:id", auth, (req, res) => {
  try {
    const id = req.params.id;
    const { name, version, description, zip_url, apk_url, is_beta, is_update, is_maintenance, zip_downloads, apk_downloads, is_original, is_thirdparty } = req.body;
    
    db.prepare(`
      UPDATE software 
      SET name=?, version=?, description=?, zip_path=?, apk_path=?, is_beta=?, is_update=?, is_maintenance=?, zip_downloads=?, apk_downloads=?, is_original=?, is_thirdparty=?
      WHERE id=?
    `).run(
      name, version, description, zip_url || "", apk_url || "",
      is_beta ? 1 : 0, is_update ? 1 : 0, is_maintenance ? 1 : 0,
      parseInt(zip_downloads) || 0, parseInt(apk_downloads) || 0,
      is_original ? 1 : 0, is_thirdparty ? 1 : 0, id
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete("/api/software/:id", auth, (req, res) => {
  try {
    db.prepare("DELETE FROM software WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/api/download/:id/:type", (req, res) => {
  try {
    const { id, type } = req.params;
    const item = db.prepare("SELECT zip_path, apk_path, is_maintenance FROM software WHERE id=?").get(id);
    if(!item) return res.status(404).json({error:"Not found"});
    if(item.is_maintenance === 1) return res.status(403).json({error:"Maintenance"});

    if (type === 'zip' && item.zip_path) {
      db.prepare("UPDATE software SET zip_downloads=zip_downloads+1 WHERE id=?").run(id);
      return res.json({ link: item.zip_path });
    } else if (type === 'apk' && item.apk_path) {
      db.prepare("UPDATE software SET apk_downloads=apk_downloads+1 WHERE id=?").run(id);
      return res.json({ link: item.apk_path });
    } else {
      return res.status(404).json({error:"File not found"});
    }
  } catch(e) { res.status(500).json({error: "Server error"}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));

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
    cb(null, Date.now() + "_" + safeName);
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

/* --- DB初期化 --- */
try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS software (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      version TEXT,
      description TEXT,
      file_path TEXT,
      downloads INTEGER DEFAULT 0,
      is_beta INTEGER DEFAULT 0,
      is_update INTEGER DEFAULT 0,
      is_maintenance INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
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

/* ===== API ===== */

app.get("/api/software", (req, res) => {
  const list = db.prepare("SELECT * FROM software ORDER BY created_at DESC").all();
  res.json(list);
});

// 新規作成
app.post("/api/software", auth, upload.single("file"), (req, res) => {
  try {
    const { name, version, description, is_beta, is_update, is_maintenance } = req.body;
    const filePath = req.file ? `/uploads/${req.file.filename}` : "";
    
    db.prepare(`
      INSERT INTO software (name, version, description, file_path, is_beta, is_update, is_maintenance)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      name, version, description, filePath,
      is_beta === "true" ? 1 : 0,
      is_update === "true" ? 1 : 0,
      is_maintenance === "true" ? 1 : 0
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({error: e.message}); }
});

// ★★★ 更新機能 (UPDATE) ★★★
app.put("/api/software/:id", auth, upload.single("file"), (req, res) => {
  try {
    const id = req.params.id;
    const { name, version, description, is_beta, is_update, is_maintenance } = req.body;
    
    // 現在のデータを取得
    const oldItem = db.prepare("SELECT file_path FROM software WHERE id=?").get(id);
    if (!oldItem) return res.status(404).json({error: "Not found"});

    let newFilePath = oldItem.file_path;

    // 新しいファイルがアップロードされた場合のみ、古いファイルを消してパスを更新
    if (req.file) {
      if (oldItem.file_path) {
        const oldFullPath = path.join(UPLOADS_DIR, oldItem.file_path.replace('/uploads/', ''));
        if (fs.existsSync(oldFullPath)) fs.unlinkSync(oldFullPath); // 古いファイルを削除
      }
      newFilePath = `/uploads/${req.file.filename}`;
    }

    db.prepare(`
      UPDATE software 
      SET name=?, version=?, description=?, file_path=?, is_beta=?, is_update=?, is_maintenance=?
      WHERE id=?
    `).run(
      name, version, description, newFilePath,
      is_beta === "true" ? 1 : 0,
      is_update === "true" ? 1 : 0,
      is_maintenance === "true" ? 1 : 0,
      id
    );

    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.status(500).json({error: e.message});
  }
});

// 削除
app.delete("/api/software/:id", auth, (req, res) => {
  try {
    const item = db.prepare("SELECT file_path FROM software WHERE id=?").get(req.params.id);
    if (item && item.file_path) {
      const filename = item.file_path.replace('/uploads/', '');
      const fullPath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    db.prepare("DELETE FROM software WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ダウンロード
app.post("/api/download/:id", (req, res) => {
  const item = db.prepare("SELECT file_path, is_maintenance FROM software WHERE id=?").get(req.params.id);
  if(!item) return res.status(404).json({error:"Not found"});
  if(item.is_maintenance === 1) return res.status(403).json({error:"Maintenance"});

  db.prepare("UPDATE software SET downloads=downloads+1 WHERE id=?").run(req.params.id);
  res.json({ link: item.file_path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));

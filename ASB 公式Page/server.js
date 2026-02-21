require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();

// データとアップロード保存用のフォルダを作成（KoyebのVolumes用）
if (!fs.existsSync("data")) fs.mkdirSync("data");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const db = new Database("data/database.sqlite");

// ZIPアップロードの設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    // ファイル名を「タイムスタンプ_元のファイル名」にして被りを防ぐ
    cb(null, Date.now() + "_" + file.originalname);
  }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "asb_secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static("public"));
app.use("/uploads", express.static("uploads")); // アップロードファイルへのアクセス許可

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

/* --- 認証ミドルウェア --- */
function auth(req, res, next){
  if(!req.session.admin) return res.status(401).json({error:"Unauthorized"});
  next();
}

/* ===== Discord OAuth2 ログイン ===== */

app.get("/auth/discord", (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`;
  res.redirect(url);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code provided.");

  try {
    // 1. Tokenを取得
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
    if (!tokenData.access_token) return res.send("Discord Authentication Failed.");

    // 2. サーバー(Guild)のメンバー情報とロールを取得
    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${process.env.ALLOWED_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    
    if (memberRes.status === 404) {
      return res.status(403).send("Error: 指定されたDiscordサーバーに参加していません。");
    }
    const memberData = await memberRes.json();

    // 3. ロールチェック
    if (memberData.roles && memberData.roles.includes(process.env.ALLOWED_ROLE_ID)) {
      req.session.admin = true; // 管理者としてセッションを保存
      req.session.username = memberData.user.username;
      res.redirect("/admin.html");
    } else {
      res.status(403).send("Error: 管理者ロールを持っていません。");
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error during authentication.");
  }
});

app.get("/api/me", (req, res) => {
  if (req.session.admin) res.json({ loggedIn: true, user: req.session.username });
  else res.json({ loggedIn: false });
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

/* ===== Software API ===== */

app.get("/api/software", (req, res) => {
  const list = db.prepare("SELECT id, name, version, description, downloads, is_beta, is_update, is_maintenance FROM software ORDER BY created_at DESC").all();
  res.json(list);
});

// ZIPアップロード対応のPOST
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
  } catch (e) {
    res.status(500).json({error: e.message});
  }
});

app.delete("/api/software/:id", auth, (req, res) => {
  // ファイルも削除する処理
  const item = db.prepare("SELECT file_path FROM software WHERE id=?").get(req.params.id);
  if (item && item.file_path) {
    const fullPath = path.join(__dirname, item.file_path);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  db.prepare("DELETE FROM software WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post("/api/download/:id", (req, res) => {
  const item = db.prepare("SELECT file_path, is_maintenance FROM software WHERE id=?").get(req.params.id);
  if(!item) return res.status(404).json({error:"Not found"});
  if(item.is_maintenance === 1) return res.status(403).json({error:"Maintenance"});

  db.prepare("UPDATE software SET downloads=downloads+1 WHERE id=?").run(req.params.id);
  res.json({ link: item.file_path }); // ZIPファイルのURLを返す
});

app.listen(3000, () => console.log(">> Server running on http://localhost:3000"));
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ★ Supabaseの初期化 (Service Role Key を使用)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ★ ローカルディスクに保存せず、メモリに一時保存してSupabaseに送る
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "asb_super_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ↓もしファイルの先頭付近に path が無ければ追加してください
const path = require("path");

// ↓元々 app.use(express.static("public")); だった場所を以下に変更
app.use(express.static(path.join(__dirname, "public")));

/* --- 認証ミドルウェア --- */
function auth(req, res, next){
  if(!req.session.admin) return res.status(401).json({error:"Unauthorized"});
  next();
}

/* ===== Discord Auth ===== */
app.get("/auth/discord", (req, res) => {
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code provided.");
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: process.env.DISCORD_REDIRECT_URI }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send("Auth Failed.");

    const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${process.env.ALLOWED_GUILD_ID}/member`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
    if (memberRes.status === 404) return res.status(403).send("Error: 指定サーバーに参加していません。");
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
app.get("/api/settings", async (req, res) => {
  try {
    const { data, error } = await supabase.from('site_settings').select('*');
    if (error) throw error;
    const settings = {};
    data.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/api/settings", auth, upload.single("bg_image"), async (req, res) => {
  try {
    const { hero_title, hero_subtitle, discord_link, x_link, youtube_link, ad_code } = req.body;
    
    const updates = [];
    if (hero_title !== undefined) updates.push({ key: 'hero_title', value: hero_title });
    if (hero_subtitle !== undefined) updates.push({ key: 'hero_subtitle', value: hero_subtitle });
    if (discord_link !== undefined) updates.push({ key: 'discord_link', value: discord_link });
    if (x_link !== undefined) updates.push({ key: 'x_link', value: x_link });
    if (youtube_link !== undefined) updates.push({ key: 'youtube_link', value: youtube_link });
    if (ad_code !== undefined) updates.push({ key: 'ad_code', value: ad_code });
    
    // 背景画像のアップロード処理
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const fileName = `bg_${Date.now()}${ext}`;
      const { data, error } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      if (!error) {
        const { data: publicUrlData } = supabase.storage.from('uploads').getPublicUrl(fileName);
        updates.push({ key: 'bg_image', value: publicUrlData.publicUrl });
      }
    }

    if (updates.length > 0) {
      await supabase.from('site_settings').upsert(updates);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});


/* ===== カスタムタグ API ===== */
app.get("/api/tags", async (req, res) => {
  const { data } = await supabase.from('tags').select('*').order('id', { ascending: true });
  res.json(data || []);
});
app.post("/api/tags", auth, async (req, res) => {
  await supabase.from('tags').insert([{ name: req.body.name, color: req.body.color }]);
  res.json({success:true});
});
app.delete("/api/tags/:id", auth, async (req, res) => {
  await supabase.from('tags').delete().eq('id', req.params.id);
  res.json({success:true});
});


/* ===== 公式ソフトウェア API ===== */
app.get("/api/software", async (req, res) => {
  const { data } = await supabase.from('software').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});

app.post("/api/software", auth, async (req, res) => {
  try {
    const { name, version, description, zip_url, apk_url, is_beta, is_update, is_maintenance, is_original, is_thirdparty, tags } = req.body;
    await supabase.from('software').insert([{
      name, version, description, zip_path: zip_url || "", apk_path: apk_url || "",
      is_beta: is_beta ? 1 : 0, is_update: is_update ? 1 : 0, is_maintenance: is_maintenance ? 1 : 0,
      is_original: is_original ? 1 : 0, is_thirdparty: is_thirdparty ? 1 : 0,
      tags: JSON.stringify(tags || [])
    }]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({error: e.message}); }
});

app.put("/api/software/:id", auth, async (req, res) => {
  try {
    const { name, version, description, zip_url, apk_url, is_beta, is_update, is_maintenance, zip_downloads, apk_downloads, is_original, is_thirdparty, tags } = req.body;
    await supabase.from('software').update({
      name, version, description, zip_path: zip_url || "", apk_path: apk_url || "",
      is_beta: is_beta ? 1 : 0, is_update: is_update ? 1 : 0, is_maintenance: is_maintenance ? 1 : 0,
      zip_downloads: parseInt(zip_downloads) || 0, apk_downloads: parseInt(apk_downloads) || 0,
      is_original: is_original ? 1 : 0, is_thirdparty: is_thirdparty ? 1 : 0,
      tags: JSON.stringify(tags || [])
    }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete("/api/software/:id", auth, async (req, res) => {
  await supabase.from('software').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.post("/api/download/:id/:type", async (req, res) => {
  try {
    const { id, type } = req.params;
    const { data: item } = await supabase.from('software').select('*').eq('id', id).single();
    
    if(!item) return res.status(404).json({error:"Not found"});
    if(item.is_maintenance === 1) return res.status(403).json({error:"Maintenance"});

    if (type === 'zip' && item.zip_path) {
      await supabase.from('software').update({ zip_downloads: item.zip_downloads + 1 }).eq('id', id);
      return res.json({ link: item.zip_path });
    } else if (type === 'apk' && item.apk_path) {
      await supabase.from('software').update({ apk_downloads: item.apk_downloads + 1 }).eq('id', id);
      return res.json({ link: item.apk_path });
    } else {
      return res.status(404).json({error:"File not found"});
    }
  } catch(e) { res.status(500).json({error: "Server error"}); }
});


/* ===== 一般ユーザー投稿ソフト API ===== */
app.get("/api/user_software", async (req, res) => {
  const { data } = await supabase.from('user_software').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});
app.post("/api/user_software", async (req, res) => {
  try {
    const { name, version, description, zip_url, apk_url, is_original, is_thirdparty, author_name } = req.body;
    await supabase.from('user_software').insert([{
      name, version, description, zip_url: zip_url || "", apk_url: apk_url || "",
      is_original: is_original ? 1 : 0, is_thirdparty: is_thirdparty ? 1 : 0, author_name: author_name || "Anonymous"
    }]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete("/api/user_software/:id", auth, async (req, res) => {
  await supabase.from('user_software').delete().eq('id', req.params.id);
  res.json({ success: true });
});
app.post("/api/download_user/:id", async (req, res) => {
  try {
    const { data: item } = await supabase.from('user_software').select('downloads').eq('id', req.params.id).single();
    if(item) {
      await supabase.from('user_software').update({ downloads: item.downloads + 1 }).eq('id', req.params.id);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: "Server error"}); }
});


/* ===== SNS宣伝 API ===== */
app.get("/api/sns", async (req, res) => {
  const { data } = await supabase.from('sns_promotions').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});
app.post("/api/sns", async (req, res) => {
  try {
    const { user_name, sns_type, url, description } = req.body;
    await supabase.from('sns_promotions').insert([{
      user_name: user_name || "Anonymous", sns_type: sns_type || "other", url, description
    }]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});
app.delete("/api/sns/:id", auth, async (req, res) => {
  await supabase.from('sns_promotions').delete().eq('id', req.params.id);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`>> Server running on port ${PORT}`));


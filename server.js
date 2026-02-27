require("dotenv").config();
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const upload = multer({ storage: multer.memoryStorage() }); 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "asb_super_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, "public")));

function auth(req, res, next){
  if(!req.session.admin) return res.status(401).json({error:"Unauthorized"});
  next();
}

/* ===== Discord Auth ===== */
app.get("/auth/discord/admin", (req, res) => {
  req.session.auth_type = 'admin';
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`);
});

app.get("/auth/discord/apply", (req, res) => {
  req.session.auth_type = 'apply';
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds%20guilds.members.read`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code provided.");
  
  try {
    // ★ ブロック回避のために User-Agent などをしっかり設定
    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ 
        client_id: process.env.DISCORD_CLIENT_ID, 
        client_secret: process.env.DISCORD_CLIENT_SECRET, 
        grant_type: "authorization_code", 
        code, 
        redirect_uri: process.env.DISCORD_REDIRECT_URI 
      }),
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "DiscordBot (https://asb-team-official.onrender.com, 1.0.0)"
      }
    });

    // エラーの場合は理由をログに出す
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Token Error:", errText);
      return res.send("Discordの認証システムとの通信に失敗しました。設定を確認してください。");
    }

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send("Auth Failed.");

    const memberRes = await fetch(`https://discord.com/api/v10/users/@me/guilds/${process.env.ALLOWED_GUILD_ID}/member`, { 
      headers: { 
        Authorization: `Bearer ${tokenData.access_token}`,
        "Accept": "application/json",
        "User-Agent": "DiscordBot (https://asb-team-official.onrender.com, 1.0.0)"
      } 
    });
    
    if (memberRes.status === 404) {
      if (req.session.auth_type === 'apply') return res.redirect("/?error=not_in_guild");
      return res.status(403).send("Error: 指定されたDiscordサーバーに参加していません。");
    }
    
    if (!memberRes.ok) {
      console.error("Member Error:", await memberRes.text());
      return res.send("ユーザー情報の取得に失敗しました。");
    }

    const memberData = await memberRes.json();

    if (req.session.auth_type === 'admin') {
      if (memberData.roles && memberData.roles.includes(process.env.ALLOWED_ROLE_ID)) {
        req.session.admin = true;
        req.session.username = memberData.user ? memberData.user.username : "Admin";
        res.redirect("/admin.html");
      } else {
        res.status(403).send("Error: 管理者ロールを持っていません。");
      }
    } else if (req.session.auth_type === 'apply') {
      req.session.applicant = { id: memberData.user.id, username: memberData.user.username };
      res.redirect("/?apply=ready");
    } else {
      res.redirect("/");
    }
  } catch (err) { 
    console.error(err);
    res.status(500).send("Server Error during Discord Auth."); 
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

/* ===== リクルート (共同創設者募集) API ===== */
app.get("/api/me/applicant", (req, res) => {
  if (req.session.applicant) res.json({ loggedIn: true, user: req.session.applicant });
  else res.json({ loggedIn: false });
});

app.post("/api/recruit/apply", async (req, res) => {
  if (!req.session.applicant) return res.status(401).json({error: "Unauthorized"});
  try {
    await supabase.from('recruit_applications').insert([{
      discord_id: req.session.applicant.id,
      discord_username: req.session.applicant.username,
      message: req.body.message
    }]);
    req.session.applicant = null;
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get("/api/recruit/applications", auth, async (req, res) => {
  const { data } = await supabase.from('recruit_applications').select('*').order('created_at', { ascending: false });
  res.json(data ||[]);
});
app.delete("/api/recruit/applications/:id", auth, async (req, res) => {
  await supabase.from('recruit_applications').delete().eq('id', req.params.id);
  res.json({ success: true });
});

/* ===== サイト設定 API ===== */
app.get("/api/settings", async (req, res) => {
  try {
    const { data } = await supabase.from('site_settings').select('*');
    const settings = {};
    if(data) data.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post("/api/settings", auth, upload.single("bg_image"), async (req, res) => {
  try {
    const { hero_title, hero_subtitle, discord_link, x_link, youtube_link, roblox_link, ad_code, recruit_enabled, recruit_title, recruit_description } = req.body;
    
    const updates =[];
    if (hero_title !== undefined) updates.push({ key: 'hero_title', value: hero_title });
    if (hero_subtitle !== undefined) updates.push({ key: 'hero_subtitle', value: hero_subtitle });
    if (discord_link !== undefined) updates.push({ key: 'discord_link', value: discord_link });
    if (x_link !== undefined) updates.push({ key: 'x_link', value: x_link });
    if (youtube_link !== undefined) updates.push({ key: 'youtube_link', value: youtube_link });
    if (roblox_link !== undefined) updates.push({ key: 'roblox_link', value: roblox_link });
    if (ad_code !== undefined) updates.push({ key: 'ad_code', value: ad_code });
    if (recruit_enabled !== undefined) updates.push({ key: 'recruit_enabled', value: recruit_enabled });
    if (recruit_title !== undefined) updates.push({ key: 'recruit_title', value: recruit_title });
    if (recruit_description !== undefined) updates.push({ key: 'recruit_description', value: recruit_description });
    
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const fileName = `bg_${Date.now()}${ext}`;
      const { error } = await supabase.storage.from('uploads').upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
      if (!error) {
        const { data } = supabase.storage.from('uploads').getPublicUrl(fileName);
        updates.push({ key: 'bg_image', value: data.publicUrl });
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
  res.json(data ||[]);
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
  res.json(data ||[]);
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
      tags: JSON.stringify(tags ||[])
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
  res.json(data ||[]);
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
    if(item) await supabase.from('user_software').update({ downloads: item.downloads + 1 }).eq('id', req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({error: "Server error"}); }
});

/* ===== SNS宣伝 API ===== */
app.get("/api/sns", async (req, res) => {
  const { data } = await supabase.from('sns_promotions').select('*').order('created_at', { ascending: false });
  res.json(data ||[]);
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

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 7000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    next();
});

// 1. КОНФИГУРАЦИОННАТА СТРАНИЦА
app.get("/", (req, res) => {
    res.send(`
        <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #1a1a1a; color: white;">
                <h2>⚙️ Настройки на P2PBG Добавка</h2>
                <p>Въведете вашите лични данни за вход:</p>
                <form onsubmit="install(event)" style="background: #333; padding: 20px; border-radius: 10px; display: inline-block;">
                    <input type="text" id="user" placeholder="Потребител" required style="padding: 10px; margin: 10px; width: 200px;"><br>
                    <input type="password" id="pass" placeholder="Парола" required style="padding: 10px; margin: 10px; width: 200px;"><br>
                    <button type="submit" style="padding: 10px 20px; background: #8a5aeb; color: white; border: none; cursor: pointer; border-radius: 5px; font-weight: bold;">
                        Генерирай линк
                    </button>
                </form>

                <div id="result" style="display: none; margin-top: 30px; padding: 15px; background: #2a2a2a; border: 1px solid #8a5aeb; border-radius: 5px; max-width: 600px; margin-left: auto; margin-right: auto; word-wrap: break-word;">
                    <p style="color: #ffcc00; font-size: 14px;">⚠️ Копирайте целия зелен линк по-долу и го поставете в търсачката за добавки в Stremio:</p>
                    <b id="manualLink" style="color: #00ffcc; font-size: 16px;"></b>
                </div>

                <script>
                    function install(e) {
                        e.preventDefault();
                        let u = document.getElementById("user").value;
                        let p = document.getElementById("pass").value;
                        
                        let encodedConfig = btoa(u + "|" + p);
                        let url = window.location.host + "/" + encodedConfig + "/manifest.json";
                        
                        document.getElementById("result").style.display = "block";
                        document.getElementById("manualLink").innerText = "https://" + url;

                        window.location.href = "stremio://" + url;
                    }
                </script>
            </body>
        </html>
    `);
});

// МАХНАХМЕ behaviorHints, ЗА ДА НЕ СЕ БЪРКА STREMIO
const manifest = {
    id: "org.p2pbg.stremio",
    version: "1.0.0",
    name: "P2PBG Торенти",
    description: "Търси филми в p2pbg.com с твой личен профил!",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: []
};

let userCookies = {};

async function loginToSite(username, password) {
    console.log(`Опит за логин на потребител: ${username}`);
    try {
        const loginPageResp = await axios.get("https://www.p2pbg.com/login", {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        let initialCookies = loginPageResp.headers['set-cookie'] ? loginPageResp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') : "";
        const $ = cheerio.load(loginPageResp.data);
        const token = $('input[name="_token"]').val();
        if (!token) return false;

        const params = new URLSearchParams();
        params.append('_token', token);
        params.append('uid', username);
        params.append('pwd', password);

        const loginResp = await axios.post("https://www.p2pbg.com/login", params, {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0",
                "Cookie": initialCookies 
            },
            maxRedirects: 0, 
            validateStatus: status => status >= 200 && status < 400
        });

        if (loginResp.headers['set-cookie']) {
            userCookies[username] = loginResp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            console.log(`Успешен вход за: ${username}!`);
            return true;
        }
        return false;
    } catch (error) {
        console.error("Грешка при логин:", error.message);
        return false;
    }
}

// 3. ДИРЕКТНА ВРЪЗКА СЪС STREMIO
app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/:config/manifest.json', (req, res) => res.json(manifest));

// Защита, ако Stremio все пак потърси configure
app.get('/configure', (req, res) => res.redirect('/'));
app.get('/:config/configure', (req, res) => res.redirect('/'));

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        let decoded = Buffer.from(req.params.config, 'base64').toString('utf8');
        let parts = decoded.split('|');
        let username = parts[0];
        let password = parts[1];

        if (!username || !password) return res.json({ streams: [] });

        console.log(`\nТърсене за: ${req.params.id} (През профила на: ${username})`);

        if (!userCookies[username]) {
            let success = await loginToSite(username, password);
            if (!success) return res.json({ streams: [] });
        }

        const currentCookie = userCookies[username];
        const imdbId = req.params.id.split(':')[0];
        const streams = [];

        const searchUrl = `https://www.p2pbg.com/torrents?search=${imdbId}&category=0&active=1`;
        const response = await axios.get(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0", "Cookie": currentCookie }
        });

        const $ = cheerio.load(response.data);
        $('a[href^="magnet:"]').each((index, element) => {
            const magnetLink = $(element).attr('href');
            try {
                const decodedMagnet = decodeURIComponent(magnetLink);
                const hashMatch = decodedMagnet.match(/urn:btih:([a-zA-Z0-9]{40})/i);
                const nameMatch = decodedMagnet.match(/dn=([^&]+)/i);

                if (hashMatch && hashMatch[1]) {
                    const titleText = nameMatch ? nameMatch[1].replace(/\+/g, ' ') : `Резултат ${index + 1}`;
                    streams.push({
                        title: `P2PBG\n${titleText}`,
                        infoHash: hashMatch[1].toLowerCase()
                    });
                }
            } catch (e) {}
        });

        console.log(`Намерени ${streams.length} стрийма.`);
        if (streams.length === 0) userCookies[username] = ""; 

        res.json({ streams: streams });
    } catch (error) {
        console.error("Грешка:", error.message);
        res.json({ streams: [] });
    }
});

app.listen(port, () => {
    console.log(`\n========================================`);
    console.log(`🚀 ДОБАВКАТА Е ГОТОВА!`);
    console.log(`Отвори този адрес в браузъра си:`);
    console.log(`👉 http://127.0.0.1:${port}`);
    console.log(`========================================\n`);
});

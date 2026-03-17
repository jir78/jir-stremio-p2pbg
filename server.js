const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 10000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "*");
    res.header("Access-Control-Allow-Methods", "*");
    next();
});

app.get("/", (req, res) => {
    res.send(`
        <html>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #1a1a1a; color: white;">
                <h2>⚙️ Настройки на P2PBG Добавка</h2>
                <form onsubmit="install(event)" style="background: #333; padding: 20px; border-radius: 10px; display: inline-block;">
                    <input type="text" id="user" placeholder="Потребител" required style="padding: 10px; margin: 10px; width: 200px;"><br>
                    <input type="password" id="pass" placeholder="Парола" required style="padding: 10px; margin: 10px; width: 200px;"><br>
                    <button type="submit" style="padding: 10px 20px; background: #8a5aeb; color: white; border: none; cursor: pointer; border-radius: 5px; font-weight: bold;">
                        Генерирай линк
                    </button>
                </form>
                <div id="result" style="display: none; margin-top: 30px; padding: 15px; background: #2a2a2a; border: 1px solid #8a5aeb; border-radius: 5px; max-width: 600px; margin-left: auto; margin-right: auto;">
                    <p style="color: #ffcc00; font-size: 14px;">Копирайте линка по-долу и го поставете в Stremio:</p>
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

const manifest = {
    id: "org.p2pbg.stremio.cloud",
    version: "1.0.8",
    name: "P2PBG Торенти",
    description: "Търси филми в p2pbg.com през твоя профил",
    resources: ["stream"],
    types: ["movie", "series"],
    idPrefixes: ["tt"]
};

let userCookies = {};

async function loginToSite(username, password) {
    try {
        const loginPageResp = await axios.get("https://www.p2pbg.com/login", { headers: { "User-Agent": "Mozilla/5.0" } });
        let initialCookies = loginPageResp.headers['set-cookie'] ? loginPageResp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ') : "";
        const $ = cheerio.load(loginPageResp.data);
        const token = $('input[name="_token"]').val();
        if (!token) return false;
        
        const params = new URLSearchParams();
        params.append('_token', token);
        params.append('uid', username);
        params.append('pwd', password);
        
        const loginResp = await axios.post("https://www.p2pbg.com/login", params, {
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0", "Cookie": initialCookies },
            maxRedirects: 0, 
            validateStatus: status => status >= 200 && status < 400
        });
        
        if (loginResp.headers['set-cookie']) {
            userCookies[username] = loginResp.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            return true;
        }
        return false;
    } catch (e) { return false; }
}

app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/:config/manifest.json', (req, res) => res.json(manifest));
app.get('/:config/configure', (req, res) => res.redirect('/'));

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        let decoded = Buffer.from(req.params.config, 'base64').toString('utf8');
        let [username, password] = decoded.split('|');
        if (!username || !password) return res.json({ streams: [] });

        if (!userCookies[username]) {
            let success = await loginToSite(username, password);
            if (!success) return res.json({ streams: [] });
        }

        const fullId = req.params.id; 
        const idParts = fullId.split(':');
        const imdbId = idParts[0];

        let searchQuery = imdbId; 
        
        try {
            // Взимаме името на филма от Stremio (на английски)
            const metaResp = await axios.get(`https://v3-cinemeta.strem.io/meta/${req.params.type}/${imdbId}.json`);
            if (metaResp.data && metaResp.data.meta && metaResp.data.meta.name) {
                searchQuery = metaResp.data.meta.name;
            }
        } catch (err) {}

        const searchUrl = `https://www.p2pbg.com/torrents?search=${encodeURIComponent(searchQuery)}&category=0&active=1`;
        const response = await axios.get(searchUrl, { headers: { "User-Agent": "Mozilla/5.0", "Cookie": userCookies[username] } });
        
        let htmlData = response.data;

        // --- ХИРУРГИЧЕСКИЯТ РАЗРЕЗ ---
        // Намираме къде е полето за търсене и изтриваме целия код ПРЕДИ него (премахваме спама)
        let cutIndex = htmlData.indexOf('name="search"');
        if (cutIndex !== -1) {
            htmlData = htmlData.substring(cutIndex);
        }

        const $ = cheerio.load(htmlData);
        const streams = [];

        // Вече търсим магнити само в изчистената, долна част на сайта
        $('a[href^="magnet:"]').each((i, el) => {
            const magnet = $(el).attr('href');
            const hashMatch = decodeURIComponent(magnet).match(/urn:btih:([a-zA-Z0-9]{40})/i);
            const nameMatch = decodeURIComponent(magnet).match(/dn=([^&]+)/i);
            
            if (hashMatch && nameMatch) {
                const torrentTitle = nameMatch[1].replace(/\+/g, ' ');
                const tTitleLower = torrentTitle.toLowerCase();
                
                let isValid = true;

                // Проверка за сериали (трябва да има правилния сезон и епизод)
                if (req.params.type === 'series') {
                    let s = idParts[1].padStart(2, '0');
                    let e = idParts[2].padStart(2, '0');
                    let ep1 = `s${s}e${e}`; // s01e02
                    let ep2 = `${idParts[1]}x${idParts[2].padStart(2, '0')}`; // 1x02
                    
                    if (!tTitleLower.includes(ep1) && !tTitleLower.includes(ep2)) {
                        isValid = false; 
                    }
                }

                if (isValid) {
                    streams.push({
                        title: `P2PBG\n${torrentTitle}`,
                        infoHash: hashMatch[1].toLowerCase()
                    });
                }
            }
        });
        
        res.json({ streams });
    } catch (e) { res.json({ streams: [] }); }
});

app.listen(port, () => console.log(`Облачната добавка работи!`));

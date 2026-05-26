const OAuth = require("oauth-1.0a");
const CryptoJS = require("crypto-js");
const https = require("https");

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

function supabaseRequest(method, path, body) {
  const parsed = new URL(`${process.env.SUPABASE_URL}/rest/v1/${path}`);
  const postData = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        "apikey": process.env.SUPABASE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": method === "PATCH" ? "return=representation" : "",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(data ? JSON.parse(data) : null); }
        catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function callClaude(title, topic, description) {
  const postData = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Wyjaśnij PROSTYM językiem o co chodzi w tym głosowaniu sejmowym — MAX 1 zdanie, max 120 znaków, po polsku. Bez żargonu.

Tytuł: ${title}
Temat: ${topic}
${description ? `Opis: ${description}` : ""}

NIE pisz że nie masz dostępu do internetu. Odpowiedz TYLKO tekstem wyjaśnienia.`
    }]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve("");
            return;
          }
          const text = parsed.content
            ?.filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          resolve(text || "");
        } catch (e) {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
    req.write(postData);
    req.end();
  });
}

function postTweet(text) {
  const oauth = OAuth({
    consumer: { key: process.env.CONSUMER_KEY, secret: process.env.CONSUMER_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return CryptoJS.HmacSHA1(baseString, key).toString(CryptoJS.enc.Base64);
    },
  });
  const token = { key: process.env.ACCESS_TOKEN, secret: process.env.ACCESS_TOKEN_SECRET };
  const requestData = { url: "https://api.twitter.com/2/tweets", method: "POST" };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
  const postData = JSON.stringify({ text });

  return new Promise((resolve) => {
    const req = https.request("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.write(postData);
    req.end();
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).json({ error: "POST or GET only" });

  const secret = req.query?.secret || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Tryb manualny — bezpośredni tekst
    if (req.body?.text) {
      const tweet = await postTweet(req.body.text);
      return res.status(200).json(tweet.body);
    }

    // Pobierz lastId z Supabase
    const rows = await supabaseRequest("GET", "sejmbot?key=eq.lastId&select=value");
    const lastId = rows?.[0]?.value || "0-0";
    const [lastP, lastV] = lastId.split("-").map(Number);

    // Pobierz listę posiedzeń
    const sittings = await fetch("https://api.sejm.gov.pl/sejm/term10/votings");
    const lastSitting = sittings[sittings.length - 1];
    const currentP = lastSitting.proceeding;

    // Pobierz głosowania z aktualnego posiedzenia
    const votings = await fetch(`https://api.sejm.gov.pl/sejm/term10/votings/${currentP}`);

    // Filtruj nowe (pomijaj proceduralne)
    const newVotings = votings.filter((v) => {
      const isNew = currentP > lastP || (currentP === lastP && v.votingNumber > lastV);
      if (!isNew) return false;

      const topic = (v.topic || "").toLowerCase();
      const skip = [
        "kworum",
        "przerwę",
        "odroczenie",
        "ustalenie czasów",
        "skrócenie terminu",
        "przystąpienie do trzeciego czytania",
        "uzupełnienie porządku",
      ];
      return !skip.some((s) => topic.includes(s));
    });

    if (newVotings.length === 0) {
      return res.status(200).json({ skipped: true, message: "Brak nowych głosowań", lastId });
    }

    newVotings.sort((a, b) => a.votingNumber - b.votingNumber);

    // 1 tweet na raz (ochrona przed timeout i spam)
    const batch = newVotings.slice(0, 1);
    const results = [];

    for (const v of batch) {
      // Kontekst AI
      const context = await callClaude(v.title, v.topic, v.description || "");

      const outcome = v.yes > v.no ? "PRZYJĘTO ✅" : "ODRZUCONO ❌";
      const shortTitle = v.title.length > 100 ? v.title.substring(0, 97) + "..." : v.title;
      const shortContext = context && context.length > 120 ? context.substring(0, 117) + "..." : (context || "");
      const contextLine = shortContext ? `\n\n💡 ${shortContext}` : "";

      const text = `🗳️ #${currentP}/${v.votingNumber}\n\n📋 ${shortTitle}${contextLine}\n\n✅ Za: ${v.yes}\n❌ Przeciw: ${v.no}\n⚪ Wstrzymało się: ${v.abstain}\n\nWynik: ${outcome}\n\n#Sejm`;

      // Twardy limit 280 znaków
      const finalText = text.length > 280 ? text.substring(0, 277) + "..." : text;

      // Tryb testowy
      if (req.query?.mode === "test") {
        results.push({ id: `${currentP}-${v.votingNumber}`, text: finalText, length: finalText.length });
        continue;
      }

      // Publikuj
      const tweet = await postTweet(finalText);
      const newId = `${currentP}-${v.votingNumber}`;
      results.push({ id: newId, status: tweet.status, body: tweet.body });

      // Zapisuj lastId tylko po udanym tweecie
      if (tweet.status === 201) {
        await supabaseRequest("PATCH", "sejmbot?key=eq.lastId", { value: newId });
      }
    }

    const remaining = newVotings.length - batch.length;
    return res.status(200).json({ posted: results, remaining, lastId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
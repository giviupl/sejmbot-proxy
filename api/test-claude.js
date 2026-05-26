const https = require("https");

module.exports = async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(200).json({ error: "ANTHROPIC_API_KEY is empty" });

  const postData = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [{ role: "user", content: "Powiedz: test działa" }]
  });

  const request = https.request({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
  }, (response) => {
    let data = "";
    response.on("data", (chunk) => (data += chunk));
    response.on("end", () => {
      res.status(200).json({
        keyLength: key.length,
        keyStart: key.substring(0, 10),
        statusCode: response.statusCode,
        body: data.substring(0, 500),
      });
    });
  });
  request.write(postData);
  request.end();
};
module.exports= async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

if (!apiKey) {
  return res.status(500).json({
    error: "OPENAI_API_KEY is missing."
  });
}

if (!/^[\x00-\x7F]+$/.test(apiKey)) {
  return res.status(500).json({
    error: "OPENAI_API_KEY contains invalid characters. Create a new API key and update Vercel."
  });
}

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  },
  body: JSON.stringify({
    model: "gpt-6luna",
    instructions:
      "You are MuB, a helpful personal AI assistant. Be clear, practical, friendly, and concise. Help the user solve problems rather than merely describing them.",
    input: message
  })
});

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI API error:", data);
      return res.status(response.status).json({
        error: "MuB could not get a response from the AI service."
      });
    }

    return res.status(200).json({
      reply: data.output_text || "MuB could not generate a response."
    });

  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
  error: error?.message || "Unknown server error"
});
}
  

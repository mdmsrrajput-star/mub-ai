export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
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
      error: "Something went wrong while MuB was processing your message."
    });
  }
}

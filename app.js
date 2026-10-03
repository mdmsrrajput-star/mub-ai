const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const messages = document.getElementById("messages");
const welcome = document.querySelector(".welcome");

let isThinking = false;

function addMessage(text, type) {
  const message = document.createElement("div");

  message.classList.add("message");

  if (type === "user") {
    message.classList.add("user-message");
  } else {
    message.classList.add("mub-message");
  }

  message.textContent = text;

  messages.appendChild(message);

  messages.scrollTop = messages.scrollHeight;

  return message;
}

function showThinking() {
  const thinking = document.createElement("div");

  thinking.classList.add("message", "mub-message");
  thinking.id = "thinkingMessage";
  thinking.textContent = "MuB is thinking...";

  messages.appendChild(thinking);

  messages.scrollTop = messages.scrollHeight;
}

function removeThinking() {
  const thinking = document.getElementById("thinkingMessage");

  if (thinking) {
    thinking.remove();
  }
}

async function sendMessage() {
  if (isThinking) {
    return;
  }

  const text = messageInput.value.trim();

  if (text === "") {
    return;
  }

  // Hide welcome screen after first message
  if (welcome) {
    welcome.style.display = "none";
  }

  // Show user's message
  addMessage(text, "user");

  // Clear input
  messageInput.value = "";

  // Lock input while MuB responds
  isThinking = true;
  sendButton.disabled = true;
  messageInput.disabled = true;

  // Show thinking state
  showThinking();

  // Ask MuB's AI backend
try {
    const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            message: text
        })
    });

    const data = await response.json();

    removeThinking();

    if (!response.ok) {
        throw new Error(data.error || "MuB could not respond.");
    }

    addMessage(data.reply, "mub");

} catch (error) {
    removeThinking();

    addMessage(
        error.message || "Sorry, MuB couldn't respond right now.",
        "mub"
    );

} finally {
    isThinking = false;
    sendButton.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
}

// Send button
sendButton.addEventListener("click", sendMessage);

// Press Enter to send
messageInput.addEventListener("keydown", function (event) {

  if (event.key === "Enter") {

    event.preventDefault();

    sendMessage();

  }
  
});

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

function sendMessage() {
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

  // Temporary response
  setTimeout(() => {
    removeThinking();

    addMessage(
      "I'm MuB. I received your message. My AI brain is coming next.",
      "mub"
    );

    isThinking = false;
    sendButton.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();

  }, 1200);
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